/**
 * Raidsmith guild tracker - lane B6a part 2b of the user-hierarchy build: the CI grep of the retired placeholder
 * Run: node tests/guild/guild-b6a-placeholder-greps-tests.js
 *
 * A re-home (worker/rehome.js) leaves a retired PLACEHOLDER character on the old person: Former, Social, teamless, keyless, a reserved name_key
 * (`~ph:<id>`, worker/character-visibility.js). It must never show in a roster, a picker, the Users list or a count, and never count in the 20-character cap.
 * ONE SQL helper does that (visibleCharacterSql); this suite lists EVERY statement of worker/ that reads the characters table and fails for one that
 *   - neither calls the helper,
 *   - nor sits on the reasoned allowlist below (ALLOWED: [file, a snippet that appears in exactly that statement, reason key, why]).
 * The allowlist is checked both ways: a statement nobody classified fails, and an entry that no statement matches any more fails (a stale reason).
 * The detectors run on seeded SQL first, so a broken detector fails here instead of passing everything.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Reading the source: every string literal with its text (each ${...} becomes a NUL), its RAW source (the ${...} expressions visible) and its line

function literalsOf(source) {
  const out = [];
  const n = source.length;
  const lineOf = (index) => source.slice(0, index).split('\n').length;
  function skipString(start) {
    const quote = source[start];
    let j = start + 1;
    while (j < n && source[j] !== quote && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    return { text: source.slice(start + 1, j), end: j + 1 };
  }
  function skipRegex(i) {
    const before = source.slice(Math.max(0, i - 40), i).trimEnd();
    if (!(before === '' || /[=(,:;!&|?{}[+\-*%<>~^]$/.test(before) || /\b(return|typeof|case)$/.test(before))) return -1;
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== '\n' && (inClass || source[j] !== '/')) {
      if (source[j] === '\\') j++;
      else if (source[j] === '[') inClass = true;
      else if (source[j] === ']') inClass = false;
      j++;
    }
    return j + 1;
  }
  function readTemplate(start) {
    let text = '';
    let j = start + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === '\\') { text += source.slice(j, j + 2); j += 2; continue; }
      if (ch === '`') return { text, end: j + 1 };
      if (ch === '$' && source[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < n && depth) {
          const c = source[j];
          if (c === '`') { const inner = readTemplate(j); out.push({ text: inner.text, raw: source.slice(j, inner.end), line: lineOf(j) }); j = inner.end; continue; }
          if (c === '\'' || c === '"') { const s = skipString(j); out.push({ text: s.text, raw: source.slice(j, s.end), line: lineOf(j) }); j = s.end; continue; }
          if (c === '/' && source[j + 1] !== '/' && source[j + 1] !== '*') { const after = skipRegex(j); if (after > 0) { j = after; continue; } }
          if (c === '{') depth++;
          else if (c === '}') depth--;
          j++;
        }
        text += '\u0000';
        continue;
      }
      text += ch;
      j++;
    }
    throw new Error('unterminated template literal');
  }
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (ch === '`') { const t = readTemplate(i); out.push({ text: t.text, raw: source.slice(i, t.end), line: lineOf(i) }); i = t.end; continue; }
    if (ch === '\'' || ch === '"') { const s = skipString(i); out.push({ text: s.text, raw: source.slice(i, s.end), line: lineOf(i) }); i = s.end; continue; }
    if (ch === '/') {
      const after = skipRegex(i);
      if (after > 0) { i = after; continue; }
    }
    i++;
  }
  return out;
}

function workerFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('worker');
  return files.sort();
}

// ---------------------------------------------------------------------------
// The detectors

const READS_CHARACTERS = /\b(?:FROM|JOIN)\s+characters\b/i;
const USES_HELPER = /\bvisibleCharacterSql\(/;
const isSql = (text) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(text) && /\b(FROM|INTO|SET|WHERE|VALUES)\b/.test(text);

// [{ file, line, sql, raw }] of every SQL literal of worker/ that reads the characters table.
function characterReaders(files = workerFiles(), read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')) {
  const found = [];
  for (const rel of files) {
    const source = read(rel).replace(/\r\n/g, '\n');
    for (const { text, raw, line } of literalsOf(source)) {
      const sql = text.replace(/\u0000/g, '?').replace(/\s+/g, ' ');
      if (isSql(sql) && READS_CHARACTERS.test(sql)) found.push({ file: rel, line, sql, raw });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The reasoned allowlist

const WHY = {
  evidence: 'EVIDENCE: it resolves a stored name (a log line, a plan seat, a paste, a loot award) through worker/name-alias.js, and the retired placeholder is exactly the character that evidence dated before a re-home resolves to: it carries the old person\'s history, so this reader must see it',
  team: 'TEAM ROSTER: scoped by team_id or the team-roster predicate (placed, still here, a raiding rank); the placeholder is teamless, Former and Social, so it can never match',
  key: 'KEYED: it matches by identity key, proof or a real name_key; the placeholder has no key, no proof, and a reserved name_key (`~ph:`) that no character name can equal',
  id: 'BY ID: it addresses one character or one person by its id, or guards a write on it; the id of a placeholder is never handed out (the Activity / audit JSON of a re-home names the person and the reason, that of a join the visible characters and a count of the hidden ones: guild-b6a-rehome-fixes-tests.js L6)',
  display: 'NAMES A PERSON: it shows the Main (or the first character) as the person\'s name; a placeholder is only ever the Main of a person with nothing else, and then its name is the only one that person has, and history keeps reading it',
  person: 'PERSON SCOPE: a write or a guard over every character of ONE person on purpose (the placeholder belongs to that person, it moves and is deleted with it)',
  rank: 'RANK MAP: the placeholder is Social and keyless, which is what the rank map gives such a character, so it never changes rank and never shows in a transition',
};

// [file, snippet, reason key]: the snippet must appear in the SQL text of the statement (whitespace collapsed to single spaces; each ${...} is a ?).
const ALLOWED = [
  ["worker/api-data.js", "p.joined_on FROM characters c JOIN players p ON p.id = c.player_id AND", "team"],
  ["worker/attendance-store.js", "nal JOIN characters nlc ON nlc.guild_id = nal.guild_id AND", "evidence"],
  ["worker/attendance-store.js", "SELECT name_key FROM characters INDEXED BY characters_player WHERE guild_id", "evidence"],
  ["worker/attendance-store.js", "IN (SELECT team_id FROM characters INDEXED BY characters_player WHERE guild_id", "evidence"],
  ["worker/attendance-store.js", "AS ( SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id IN (SELECT", "evidence"],
  ["worker/attendance-view.js", "c.team_id, c.is_main FROM characters c WHERE c.guild_id = ?1 AND (c.player_id IN", "evidence"],
  ["worker/away-store.js", "is_main, team_id FROM characters WHERE guild_id = ?1 AND team_id = ?2 AND", "team"],
  ["worker/block-effects.js", "c.name, c.team_id FROM characters c WHERE c.guild_id = ? AND c.player_id IN", "person"],
  ["worker/block-effects.js", "IN (SELECT team_id FROM characters WHERE guild_id = ? AND team_id IS NOT NULL", "team"],
  ["worker/block-tombstones.js", "SELECT DISTINCT ? FROM characters c WHERE c.proof_user_id = ? AND", "key"],
  ["worker/block-tombstones.js", "SELECT DISTINCT ? FROM characters c WHERE c.guild_id = ? AND c.player_id = ?", "key"],
  ["worker/succession.js", "JOIN characters gc ON gc.guild_id = gr.guild_id AND", "key"],
  ["worker/bnet-match.js", "?), ? FROM characters INDEXED BY characters_player WHERE ? AND", "key"],
  ["worker/bnet-match.js", "NOT EXISTS (SELECT 1 FROM characters h WHERE h.guild_id = gr.guild_id AND", "key"],
  ["worker/bnet-match.js", "NOT EXISTS (SELECT 1 FROM characters h WHERE h.guild_id = ? AND h.namespace = ?", "id"],
  ["worker/bnet-match.js", "at FROM json_each(?) j JOIN characters c ON c.guild_id = json_extract(j.value,", "key"],
  ["worker/bnet-match.js", "(EXISTS (SELECT 1 FROM characters bc WHERE bc.id = ? AND bc.guild_id = ? AND bc.blizzard_char_id IS NULL", "id"],
  ["worker/bnet-match.js", "EXISTS (SELECT 1 FROM characters pc WHERE pc.id = ? AND", "key"],
  ["worker/bnet-store.js", "FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1", "person"],
  ["worker/bnet-store.js", "AS home_team_id FROM characters c JOIN players p ON p.id = c.player_id JOIN", "key"],
  ["worker/claim-apply.js", "AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main =", "person"],
  ["worker/duties.js", "(SELECT c.name FROM characters c WHERE c.player_id = d.player_id ORDER BY", "display"],
  ["worker/flip-preview.js", "(SELECT fm.name FROM characters fm WHERE fm.player_id = ? AND fm.is_main =", "display"],
  ["worker/loot-store.js", "id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT value", "evidence"],
  ["worker/loot-store.js", "id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT ? FROM", "evidence"],
  ["worker/membership.js", "EXISTS (SELECT 1 FROM characters mx_ch JOIN guild_roster mx_gr ON", "key"],
  ["worker/name-alias.js", "nal JOIN characters nlc ON nlc.guild_id = nal.guild_id AND", "evidence"],
  ["worker/notify-run.js", "?, (SELECT c.name FROM characters c WHERE c.player_id = p.id AND c.team_id =", "team"],
  ["worker/notify-run.js", "?, (SELECT c.name FROM characters c WHERE c.player_id = p.id ORDER BY", "display"],
  ["worker/permissions.js", "DISTINCT c.team_id FROM characters c JOIN players p ON p.id = c.player_id", "team"],
  ["worker/person-join.js", "c.name_key)) FROM characters c ? WHERE c.guild_id = p.guild_id AND c.player_id = p.id", "person"],
  ["worker/person-join.js", "IN (SELECT id FROM characters ? WHERE guild_id = ? AND player_id = ?)", "person"],
  ["worker/person-join.js", "IN (SELECT s.team_id FROM characters s WHERE s.player_id = ? AND s.team_id IS", "team"],
  ["worker/person-join.js", "NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ?)", "person"],
  ["worker/person-legacy.js", "(SELECT o.trial_start FROM characters o WHERE o.id = ?1), trial_end = (SELECT", "id"],
  ["worker/rank-map.js", "c.name_key AS name_key FROM characters c WHERE c.guild_id = ? AND c.core_rank !=", "rank"],
  ["worker/rank-map.js", "AS from_rank, ? AS to_rank FROM characters c WHERE c.guild_id = ?) WHERE from_rank != to_rank GROUP BY", "rank"],
  ["worker/rank-map.js", "AS from_rank, ? AS to_rank FROM characters c WHERE c.guild_id = ?) WHERE from_rank != to_rank ORDER BY", "rank"],
  ["worker/rehome.js", "NULL, CASE WHEN EXISTS (SELECT 1 FROM characters m ? WHERE m.player_id = ? AND m.is_main = 1) THEN 0 ELSE 1 END,", "person"],
  ["worker/rehome.js", "EXISTS (SELECT 1 FROM characters c WHERE c.id = ? AND c.guild_id = ? AND", "id"],
  ["worker/rehome.js", "EXISTS (SELECT 1 FROM characters WHERE id = ? AND guild_id = ? AND name_key", "id"],
  ["worker/roster-sync.js", "c.team_id AS team_id FROM characters c JOIN new_roster n ON ? WHERE c.guild_id =", "key"],
  ["worker/roster-sync.js", "c.realm_key, ? FROM characters c JOIN new_roster n ON ? WHERE c.guild_id =", "key"],
  ["worker/roster-sync.js", "NOT EXISTS (SELECT 1 FROM characters o WHERE o.guild_id = characters.guild_id", "key"],
  ["worker/roster-view.js", "SELECT rc.player_id FROM characters rc WHERE rc.guild_id = ?1 AND ?", "team"],
  ["worker/roster-view.js", "SELECT rc.player_id FROM characters rc WHERE rc.guild_id = ?1 AND rc.team_id =", "team"],
  ["worker/routes/accounts.js", "SELECT 1 AS found FROM characters WHERE guild_id = ? AND player_id = ? AND", "key"],
  ["worker/routes/accounts.js", "EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main =", "person"],
  ["worker/routes/applications.js", "(SELECT c.player_id FROM characters c WHERE c.guild_id = a.guild_id AND", "key"],
  ["worker/routes/applications.js", "SELECT id, team_id FROM characters WHERE id = ? AND guild_id = ?", "id"],
  ["worker/routes/applications.js", "SELECT 1 AS found FROM characters WHERE player_id = ? AND team_id = ?", "team"],
  ["worker/routes/attendance.js", "team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN", "evidence"],
  ["worker/routes/attendance.js", "name_key, realm_key FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT", "evidence"],
  ["worker/routes/attendance.js", "NOT EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.name_key = ?", "evidence"],
  ["worker/routes/attendance.js", "main_id FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1", "person"],
  ["worker/routes/attendance.js", "SELECT 1 AS x FROM characters WHERE guild_id = ? AND player_id = ? AND", "team"],
  ["worker/routes/attendance.js", "IN (SELECT player_id FROM characters WHERE team_id = ?2) OR p.id IN (SELECT", "team"],
  ["worker/routes/attendance.js", "core_rank, left_on FROM characters WHERE guild_id = ?1 AND (player_id IN", "evidence"],
  ["worker/routes/attendance.js", "core_rank, left_on FROM characters WHERE guild_id = ?1 AND player_id = ?2", "evidence"],
  ["worker/routes/attendance.js", "IN (SELECT team_id FROM characters WHERE player_id = ?2 UNION SELECT team_id", "team"],
  ["worker/routes/attention.js", "NOT EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.name_key = ?", "evidence"],
  ["worker/routes/attention.js", "c.class, c.team_id FROM characters c WHERE c.guild_id = ? AND c.core_rank =", "team"],
  ["worker/routes/attention.js", "(SELECT c.name FROM characters c WHERE c.player_id = d.player_id ORDER BY", "display"],
  ["worker/routes/attention.js", "is_main, team_id FROM characters WHERE guild_id = ?1 AND player_id IN", "display"],
  ["worker/routes/audit.js", "SELECT player_id, name FROM characters WHERE guild_id = ?1 AND player_id IN (SELECT value FROM json_each(?2)) ORDER BY ?, is_main DESC, name", "display"],
  ["worker/routes/audit.js", "SELECT id, name FROM characters WHERE guild_id = ?1 AND id IN (SELECT value", "id"],
  ["worker/routes/away.js", "EXISTS (SELECT 1 FROM characters ac WHERE ac.guild_id = ? AND ac.player_id =", "person"],
  ["worker/routes/away.js", "IN (SELECT team_id FROM characters WHERE guild_id = ?1 AND player_id = ?3) AND", "team"],
  ["worker/routes/away.js", "is_main, team_id FROM characters WHERE guild_id = ? AND team_id = ?", "team"],
  ["worker/routes/bnet-import.js", "(SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND", "key"],
  ["worker/routes/bnet-import.js", "SELECT c.name FROM characters c WHERE c.guild_id = ? AND c.namespace = ?", "key"],
  ["worker/routes/bnet.js", "p.user_id FROM characters c JOIN players p ON p.id = c.player_id", "key"],
  ["worker/routes/guild.js", "core_rank, left_on FROM characters WHERE guild_id = ? AND player_id = ?", "team"],
  ["worker/routes/intent.js", "= k.guild_id LEFT JOIN characters m ON m.player_id = p.id AND m.is_main = 1", "display"],
  ["worker/routes/join.js", "SELECT 1 AS x FROM characters WHERE guild_id = ? AND name_key = ? LIMIT 1", "key"],
  ["worker/routes/launch.js", "SELECT player_id, class FROM characters WHERE guild_id = ? AND team_id = ?", "team"],
  ["worker/routes/launch.js", "MAX(cl.level) AS level FROM characters c JOIN character_claims cl ON cl.guild_id =", "team"],
  ["worker/routes/loot-board.js", "DISTINCT c.player_id FROM characters c WHERE c.guild_id = ?1 AND ?", "team"],
  ["worker/routes/loot-board.js", "team_id, is_main FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT", "evidence"],
  ["worker/routes/loot.js", "SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT ? FROM loot_awards la WHERE la.guild_id = ?1 AND la.team_id = ?2))", "evidence"],
  ["worker/routes/loot.js", "?1 AND p.id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id = ?2)", "team"],
  ["worker/routes/loot.js", "name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id", "evidence"],
  ["worker/routes/loot.js", "team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id = ?2", "evidence"],
  ["worker/routes/loot.js", "AND EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.player_id =", "evidence"],
  ["worker/routes/loot.js", "SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT ? FROM loot_awards la WHERE la.guild_id = ?1 AND la.team_id = ?2 AND", "evidence"],
  ["worker/routes/open-raids.js", "SELECT 1 AS x FROM characters WHERE guild_id = ? AND name_key = ? LIMIT 1", "key"],
  ["worker/routes/paste.js", "json_each(?2) w) k JOIN characters c ON c.guild_id = ?1 AND c.name_key =", "evidence"],
  ["worker/routes/person-blocks.js", "THEN 2 ELSE 3 END) FROM characters c JOIN guild_roster gr ON gr.guild_id =", "key"],
  ["worker/routes/raids.js", "raid_signups s LEFT JOIN characters c ON c.id = s.character_id WHERE", "id"],
  ["worker/routes/raids.js", "FROM raid_plan pl JOIN raids pr ON pr.id = pl.raid_id JOIN characters c ON c.guild_id = ? AND c.name_key =", "evidence"],
  ["worker/routes/ranks.js", "SELECT 1 AS found FROM characters WHERE player_id = ? AND team_id = ? AND", "team"],
  ["worker/routes/recruiting.js", "m.class, m.main_spec FROM characters m WHERE m.guild_id = ? AND m.is_main = 1", "team"],
  ["worker/routes/roster-import.js", "c.name_key FROM characters c WHERE c.guild_id = ? AND c.player_id IN (", "key"],
  ["worker/routes/roster-import.js", "c.name_key, c.player_id, (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name FROM characters c", "key"],
  ["worker/routes/roster-import.js", "SELECT c.name_key, c.realm_key, c.player_id, (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name FROM characters c WHERE c.guild_id = ? AND c.name_key IN", "key"],
  ["worker/routes/roster-import.js", "SELECT c.name_key, c.realm_key, c.player_id, (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name FROM characters c WHERE c.guild_id = ?", "key"],
  ["worker/routes/roster-match.js", "EXISTS (SELECT 1 FROM characters mc WHERE mc.id = ? AND mc.guild_id = ? AND", "id"],
  ["worker/routes/roster-match.js", "SELECT id FROM characters WHERE guild_id = ? AND namespace = ? AND", "key"],
  ["worker/routes/roster-match.js", "name_key, realm_key FROM characters WHERE id = ? AND guild_id = ?", "id"],
  ["worker/routes/roster-match.js", "EXISTS (SELECT 1 FROM characters ac WHERE ac.id = ? AND ac.blizzard_char_id", "id"],
  ["worker/routes/roster-publish.js", "is_main, team_id FROM characters WHERE guild_id = ? AND name_key IN (SELECT", "key"],
  ["worker/routes/roster.js", "(SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND", "key"],
  ["worker/routes/roster.js", "? AND EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ? AND is_main", "id"],
  ["worker/routes/roster.js", "NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ? AND is_main = 1)", "person"],
  ["worker/routes/roster.js", "AND EXISTS (SELECT 1 FROM characters WHERE player_id = ? AND is_main = 1 AND", "person"],
  ["worker/routes/roster.js", "version = ? AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?)", "person"],
  ["worker/routes/roster.js", "= ? AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?)", "person"],
  ["worker/routes/roster.js", "EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?) AND NOT EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND team_id IS NOT NULL AND team_id NOT IN (SELECT value FROM json_each(?)))", "person"],
  ["worker/routes/roster.js", "EXISTS (SELECT 1 FROM characters WHERE id = ? AND player_id = ? AND is_main = 0 AND team_id IS ?) AND ", "id"],
  ["worker/routes/roster.js", "DELETE FROM characters WHERE id = ? AND player_id = ? AND is_main", "id"],
  ["worker/routes/roster.js", "SELECT 1 AS found FROM characters WHERE guild_id = ? AND player_id = ? AND", "key"],
  ["worker/routes/roster.js", "AND (NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ? AND owner_proof = 'bnet') OR", "key"],
  ["worker/routes/signups.js", "SELECT 1 FROM characters WHERE guild_id = ? AND name_key = ? LIMIT 1", "key"],
  ["worker/routes/signups.js", "(SELECT m.team_id FROM characters m WHERE m.player_id = players.id AND", "person"],
  ["worker/routes/signups.js", "AND (NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ? AND owner_proof = 'bnet') OR", "key"],
  ["worker/routes/team-requests.js", "u.avatar FROM ? LEFT JOIN characters m ON m.player_id = c.player_id AND", "display"],
  ["worker/routes/team-requests.js", "id, name, team_id FROM characters WHERE id = ? AND guild_id = ? AND player_id", "id"],
  ["worker/routes/team-requests.js", "SELECT 1 AS found FROM characters WHERE player_id = ? AND team_id = ?", "team"],
  ["worker/routes/team-requests.js", "?, 'pending', ?, ? FROM characters c WHERE c.id = ? AND c.guild_id = ? AND", "id"],
  ["worker/routes/teams.js", "c.player_id) AS n FROM characters c WHERE c.guild_id = ? AND ? GROUP BY", "team"],
  ["worker/routes/trial.js", "AND EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.player_id =", "evidence"],
  ["worker/seniority.js", "EXISTS (SELECT 1 FROM characters pc WHERE pc.player_id = ? AND pc.guild_id =", "key"],
  ["worker/team-place.js", "NOT EXISTS (SELECT 1 FROM characters o WHERE o.player_id = characters.player_id", "team"],
  ["worker/team-place.js", "NOT EXISTS (SELECT 1 FROM characters lc WHERE lc.guild_id = ? AND lc.player_id =", "team"],
  ["worker/team-roster.js", "EXISTS (SELECT 1 FROM characters rc WHERE rc.player_id = ? AND ?)", "team"],
  ["worker/team-roster.js", "(SELECT rc.core_rank FROM characters rc WHERE rc.player_id = ? AND ? ORDER BY", "team"],
  ["worker/viewer.js", "c.team_id, c.is_main FROM characters c WHERE c.guild_id = ?1 AND ?", "team"],
];

// ---------------------------------------------------------------------------

check('the detectors see what they must (seeded SQL)', () => {
  const seeded = (sql) => characterReaders(['x.js'], () => `const q = db.prepare(\`${sql}\`);`);
  assert.equal(seeded('SELECT id FROM characters WHERE guild_id = ?').length, 1);
  assert.equal(seeded('SELECT c.id FROM players p JOIN characters c ON c.player_id = p.id').length, 1);
  assert.equal(seeded('SELECT 1 FROM\n   characters c WHERE c.id = ?').length, 1, 'a line break between FROM and the table');
  assert.equal(seeded('DELETE FROM characters WHERE id = ?').length, 1);
  assert.equal(seeded('UPDATE characters SET team_id = NULL WHERE id IN (SELECT id FROM characters WHERE player_id = ?)').length, 1);
  assert.equal(seeded('SELECT id FROM players WHERE guild_id = ?').length, 0);
  assert.equal(seeded('INSERT INTO characters (id) VALUES (?)').length, 0, 'a plain INSERT reads nothing');
  assert.equal(seeded('SELECT id FROM character_claims WHERE guild_id = ?').length, 0);
  const withHelper = characterReaders(['x.js'], () => 'const q = `SELECT id FROM characters c WHERE ${visibleCharacterSql(\'c\')}`;');
  assert.equal(withHelper.length, 1);
  assert(USES_HELPER.test(withHelper[0].raw), 'the helper call is visible in the raw literal');
  assert.equal(USES_HELPER.test(seeded('SELECT id FROM characters')[0].raw), false);
  // a comment or a regex that mentions the table is no statement
  assert.equal(characterReaders(['x.js'], () => '// SELECT id FROM characters WHERE x = 1\nconst re = /FROM characters/;').length, 0);
});

check('every worker statement that reads the characters table calls visibleCharacterSql or sits on the reasoned allowlist', () => {
  const readers = characterReaders();
  assert(readers.length > 100, `the scan sees the characters readers of worker/ (saw ${readers.length})`);
  const unclassified = [];
  const used = new Set();
  let helperCount = 0;
  const byReason = {};
  for (const reader of readers) {
    if (USES_HELPER.test(reader.raw)) { helperCount++; continue; }
    const hits = ALLOWED.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry[0] === reader.file && reader.sql.includes(entry[1]));
    if (!hits.length) { unclassified.push(`${reader.file}:${reader.line}  ${reader.sql.slice(0, 150)}`); continue; }
    for (const { entry, index } of hits) used.add(index);
    byReason[hits[0].entry[2]] = (byReason[hits[0].entry[2]] || 0) + 1;
  }
  if (unclassified.length) console.log(`      unclassified:\n        ${unclassified.join('\n        ')}`);
  assert.equal(unclassified.length, 0, `${unclassified.length} statement(s) read characters with neither the helper nor an allowlist entry (listed above)`);
  const stale = ALLOWED.filter((entry, index) => !used.has(index)).map((entry) => `${entry[0]}: ${entry[1].slice(0, 80)}`);
  if (stale.length) console.log(`      stale:\n        ${stale.join('\n        ')}`);
  assert.equal(stale.length, 0, `${stale.length} allowlist entr(ies) match no statement any more (listed above)`);
  console.log(`      readers: ${readers.length} (helper ${helperCount}, allowlisted ${readers.length - helperCount}: ${JSON.stringify(byReason)})`);
});

check('every allowlist entry names a known reason and the snippet is not trivial', () => {
  for (const entry of ALLOWED) {
    assert(WHY[entry[2]], `${entry[0]}: unknown reason ${entry[2]}`);
    assert(entry[1].length >= 12, `${entry[0]}: the snippet "${entry[1]}" is too short to say which statement it is`);
    assert(fs.existsSync(path.join(ROOT, entry[0])), `${entry[0]} does not exist`);
  }
});

check('the helper itself: fixed text on the name_key prefix, no parameters; the placeholder test is its mirror', async () => {
  const { pathToFileURL } = require('node:url');
  const mod = await import(pathToFileURL(path.join(ROOT, 'worker/character-visibility.js')).href);
  assert.equal(mod.visibleCharacterSql('c'), "substr(c.name_key, 1, 4) <> '~ph:'");
  assert.equal(mod.placeholderCharacterSql('c'), "substr(c.name_key, 1, 4) = '~ph:'");
  assert.equal(mod.visibleCharacterSql(), "substr(characters.name_key, 1, 4) <> '~ph:'");
  assert(!/\?/.test(mod.visibleCharacterSql('c')) && !/\?/.test(mod.placeholderCharacterSql('c')), 'no placeholder: it fits statements with anonymous and numbered ones');
  assert.equal(mod.PLACEHOLDER_PREFIX.length, 4);
  assert.equal(mod.placeholderKey('c_x'), '~ph:c_x');
  assert(mod.isPlaceholderKey(mod.placeholderKey('c_x')) && !mod.isPlaceholderKey('aldric') && !mod.isPlaceholderKey(mod.retiredNameKey('c_x')));
  // no real character name can start with the reserved prefix (worker/roster-data.js cleanCharacterName is letters only)
  const roster = await import(pathToFileURL(path.join(ROOT, 'worker/roster-data.js')).href);
  for (const name of ['~ph:c_abc', '~Aldric', 'Al~dric', '~was:c_abc']) assert.equal(roster.cleanCharacterName(name, 'tbc'), null, `${name} is no character name`);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 40).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
