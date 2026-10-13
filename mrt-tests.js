/**
 * PartyPlanner Web - MRT Raid Groups string golden tests
 * Run: node mrt-tests.js
 *
 * "Copy for MRT" (Import.exportMrtString) is the owner's only weekly handoff
 * into the game. These tests pin the FULL string for fixed boards, built by
 * hand and never from Optimizer output, so a change to the optimizer, the
 * share UI or the codec cannot alter it by accident.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const { Import, State } = app.sandbox(['Import', 'State']).api;

// Test-local port of LibDeflate:DecodeForPrint, independent of the encoder in js/import.js.
const MRT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()';
function mrtDecodeForPrint(str) {
  const val = c => MRT_ALPHABET.indexOf(c);
  const out = [];
  let i = 0;
  while (i + 4 <= str.length) {
    const x = [0, 1, 2, 3].map(k => val(str[i + k]));
    if (x.some(v => v < 0)) return null;
    i += 4;
    let cache = x[0] + x[1] * 64 + x[2] * 4096 + x[3] * 262144;
    const b1 = cache % 256; cache = (cache - b1) / 256;
    const b2 = cache % 256; const b3 = (cache - b2) / 256;
    out.push(b1, b2, b3);
  }
  let cache = 0, bits = 0;
  while (i < str.length) {
    const v = val(str[i]); if (v < 0) return null;
    cache += v * Math.pow(2, bits); bits += 6; i++;
  }
  while (bits >= 8) {
    const b = cache % 256; out.push(b); cache = (cache - b) / 256; bits -= 8;
  }
  return Buffer.from(out).toString('utf8');
}

const mk = name => ({ name, class: 'MAGE', spec: 'Fire', role: 'caster_dps', groupNumber: 1, imported: true });

// These strings are what MRT imports; change them only on purpose.
const GOLDEN_25 = 'MRTRGR0WWYEBftx9isqSrMCPnMiSSLmD1JicjxzU5wyIWYwZ0vpIm0BYDxAUjclBrtx9icrLXwAHjclBvtx9iYWgkxAUjclBztx9iIrL5MBIWYw30vpIC0D55MiSSfoD1JiifgBLjclBLtx9issZ9gBKvMiSSvmW0vpIO0BYvMBIWYwXetx9iYsHvgBIWYwXitx9ict5jxyIWYwXmtx9istVjxAJjclBfdnD1Jiov2CZfMiSSvm10vpI8KCP5MiSSvm20vpIavARvMiSSvm30vpIevDPXgBIWYwXGtx9iIuOvwyIWYwXKtx9iYuVjxzUjclBjdmD1JiufwBZLMBIWYwYetx9isvSjxAJjclBjJmD1Jiwv2CWvMCIWYwYmtx9iYvYvMBIWYwYqtx9icwH5gzLjNiSSLm10vpIKvyYfMi9b';
const GOLDEN_OVER = 'MRTRGR0WWYEBftx9icuXiclBjtx9icuYiclBntx9icuZiclBrtx9icu0iclBvtx9icu1isF';
const GOLDEN_40 = 'MRTRGR0WWYEBftx9iIuXiclBjtx9iIuYiclBntx9iIuZiclBrtx9iIu0iclBvtx9iIu1iclBztx9iIu2iclBDtx9iIu3iclBHtx9iIu4iclBLtx9iIu5iclBfdmD1JisfdmIWYwXetx9iIuXeJiSSvmY0vpIivmYiclBfZmD1JisfZmIWYwXqtx9iIuXqJiSSvm10vpIivm1iclBfJnD1JisfJnIWYwXCtx9iIuXCJiSSvm40vpIivm4iclBftoD1JisftoIWYwYatx9iIuYaJiSSLmX0vpIiLmXiclBjJmD1JisjJmIWYwYmtx9iIuYmJiSSLm00vpIiLm0iclBjtnD1JisjtnIWYwYytx9iIuYyJiSSLm30vpIiLm3iclBjdoD1JisjdoIWYwYKtx9iIuYKJiSS1mW0vpIi1mWiclBntmD1JisntmIWYwZitx9iIuZiJiSS1mZ0vpIi1mZiclBndnD1JisndnIWYwZutx9iIuZuJiSS1m20vpIi1m2iclBnZnD1JisnZnIWYwZGtx9iIuZGJiSS1m50vpIi1m5iclBrdmD1JisrdmI0h';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`); }
}

check('25-man, 5 groups of 5 with a non-ASCII name: the full string is pinned', () => {
  State.groups = [
    ['Aldric', 'Brenna', 'Corwin', 'Delia', '\u00C6rin'],
    ['Fenn', 'Gwyn', 'Hale', 'Isolde', 'Joren'],
    ['Kael', 'Lyra', 'Moric', 'Nessa', 'Orin'],
    ['Pike', 'Quill', 'Rhea', 'Soren', 'Tamsin'],
    ['Ulric', 'Vesper', 'Wren', 'Xander', 'Yara'],
  ].map(g => g.map(mk));
  State.bench = [];
  const str = Import.exportMrtString();
  assert.equal(str, GOLDEN_25);
  assert.equal(mrtDecodeForPrint(str.slice(7)),
    '0,{[1]="Aldric",[2]="Brenna",[3]="Corwin",[4]="Delia",[5]="\u00C6rin",'
    + '[6]="Fenn",[7]="Gwyn",[8]="Hale",[9]="Isolde",[10]="Joren",'
    + '[11]="Kael",[12]="Lyra",[13]="Moric",[14]="Nessa",[15]="Orin",'
    + '[16]="Pike",[17]="Quill",[18]="Rhea",[19]="Soren",[20]="Tamsin",'
    + '[21]="Ulric",[22]="Vesper",[23]="Wren",[24]="Xander",[25]="Yara"}');
});

check('Over-capacity group of 6 writes five slots; bench players never appear', () => {
  State.groups = [['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map(mk), [], [], [], []];
  State.bench = ['Benchy', 'Sitter'].map(mk);
  const str = Import.exportMrtString();
  assert.equal(str, GOLDEN_OVER);
  const decoded = mrtDecodeForPrint(str.slice(7));
  assert.equal(decoded, '0,{[1]="P1",[2]="P2",[3]="P3",[4]="P4",[5]="P5"}');
  assert(!decoded.includes('Benchy') && !decoded.includes('Sitter') && !decoded.includes('P6'));
});

check('40-man, 8 groups of 5: slots 1 to 40 are pinned', () => {
  State.groups = Array.from({ length: 8 }, (_, g) => Array.from({ length: 5 }, (_, i) => mk('R' + (g * 5 + i + 1))));
  State.bench = [];
  const str = Import.exportMrtString();
  assert.equal(str, GOLDEN_40);
  const expected = '0,{' + Array.from({ length: 40 }, (_, i) => `[${i + 1}]="R${i + 1}"`).join(',') + '}';
  assert.equal(mrtDecodeForPrint(str.slice(7)), expected);
});

console.log(`\nMRT tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
