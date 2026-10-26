// Reads the Worker's source for the CI greps (lane B5): every string literal of a worker file (template literals keep their text, each ${...} becomes a NUL), and the
// SQL-looking ones with the interpolations blanked to "?". A copy of the reader in tests/guild/guild-legacy-columns-tests.js (left alone so parallel lanes do not collide).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

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
  // A '/' after an operator or an opening bracket starts a regular expression literal (it can hold a quote): returns the index after it, or -1.
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
          if (c === '`') { const inner = readTemplate(j); out.push({ text: inner.text, line: lineOf(j) }); j = inner.end; continue; }
          if (c === '\'' || c === '"') { const s = skipString(j); out.push({ text: s.text, line: lineOf(j) }); j = s.end; continue; }
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
    if (ch === '`') { const t = readTemplate(i); out.push({ text: t.text, line: lineOf(i) }); i = t.end; continue; }
    if (ch === '\'' || ch === '"') { const s = skipString(i); out.push({ text: s.text, line: lineOf(i) }); i = s.end; continue; }
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
// SQL-looking literals of one file: [{ line, sql }] with the interpolations blanked to "?".
function sqlLiterals(rel) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  let literals;
  try {
    literals = literalsOf(source);
  } catch (error) {
    throw new Error(`${rel}: ${error.message}`);
  }
  return literals
    .map(({ text, line }) => ({ line, sql: text.replace(/\u0000/g, '?') }))
    .filter(({ sql }) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(sql) && /\b(FROM|INTO|SET|WHERE|VALUES)\b/.test(sql));
}


module.exports = { literalsOf, workerFiles, sqlLiterals };
