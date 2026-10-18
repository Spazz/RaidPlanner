// CSV for the data links (worker/routes/api-v1.js), the pure half. RFC 4180: fields with a comma, quote or line break are quoted, quotes are doubled,
// lines end with CRLF. A TEXT cell a spreadsheet would run as a formula (it starts with = + - @, a tab or a carriage return) gets a leading apostrophe,
// so a character, title or item name someone typed can never execute in Google Sheets or Excel. Numbers and booleans are not text and pass through
// (a negative number is a number, not a formula).
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// columns: [{ key, header }], rows: [{ [key]: value }] -> the file text (header line first, every line ends with CRLF).
export function toCsv(columns, rows) {
  const lines = [columns.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
