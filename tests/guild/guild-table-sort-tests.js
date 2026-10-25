/**
 * Raidsmith guild UI - sortable table heads (design-spec "Data table": EVERY column head of a data table is sortable, only a row-action column is not).
 * One mechanism in js/guild/ui-kit.js: dataTableHtml columns, ui.sortThHtml + ui.sortItems for hand-built tables, the 'table-sort' click handler.
 * Run: node tests/guild/guild-table-sort-tests.js
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('../guild-scripts');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function loadGuild(extra) {
  const sandbox = Object.assign({ console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout, clearTimeout }, extra || {});
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}

const COLS = [
  { key: 'name', label: 'Name', primary: true },
  { key: 'n', label: 'Count', align: 'right' },
  { key: 'when', label: 'When' },
  { key: 'act', label: 'Actions', srLabel: true, hideLabel: true },
];
const mk = (id, name, n, when, extra) => Object.assign({ id: id, sort: { when: when }, cells: { name: '<a href="#">' + name + '</a>', n: n, when: 'formatted ' + id, act: '<button>x</button>' } }, extra || {});
const order = html => (html.match(/data-row="([^"]+)"/g) || []).map(s => s.slice(10, -1));

(async () => {
  const sandbox = loadGuild();
  const G = sandbox.Guild || sandbox.G || Object.values(sandbox).find(v => v && v.ui && v.ui.dataTableHtml);
  const ui = G.ui;
  let rendered = 0;
  G.app = { render() { rendered++; } };
  const reset = () => Object.keys(ui.tableSortState).forEach(k => delete ui.tableSortState[k]);
  const rows = [mk('a', 'Ironvale', '10', '2026-10-03'), mk('b', 'mirelle', '9', '2026-10-01'), mk('c', 'Thornwick', '', '2026-10-02'), mk('d', 'Auric', '100', null)];
  const table = key => ui.dataTableHtml({ key: key || 't', label: 'T', columns: COLS, rows: rows, showAll: true });

  await check('every head is a sort button with aria-sort="none" by default; a row-action column (srLabel) is not', () => {
    reset();
    const out = table();
    assert.equal((out.match(/class="gs-sort"/g) || []).length, 3);
    assert.equal((out.match(/aria-sort="none"/g) || []).length, 3);
    assert(!/aria-sort="(ascending|descending)"/.test(out), 'no arrow before a head is pressed');
    assert.deepEqual(order(out), ['a', 'b', 'c', 'd'], 'the table keeps its own order');
    assert(out.includes('data-action="table-sort" data-table="t" data-sort="name"'));
    assert(/<th scope="col" class=""><span class="gs-sr">Actions<\/span><\/th>/.test(out));
    assert(ui.dataTableHtml({ key: 't', columns: [{ key: 'x', label: 'X', sort: false, primary: true }], rows: [{ id: 'q', cells: { x: '1' } }] }).includes('<th scope="col" class="">X</th>'));
  });

  await check('text sorts case-insensitively, numbers as numbers (not "100" < "9"), empty last in both directions', () => {
    reset();
    ui.toggleTableSort('t', 'name');
    assert.deepEqual(order(table()), ['d', 'a', 'b', 'c'], 'Auric, Ironvale, mirelle, Thornwick');
    ui.toggleTableSort('t', 'name');
    assert.deepEqual(order(table()), ['c', 'b', 'a', 'd']);
    ui.toggleTableSort('t', 'n');
    assert.deepEqual(order(table()), ['b', 'a', 'd', 'c'], '9, 10, 100, empty last');
    ui.toggleTableSort('t', 'n');
    assert.deepEqual(order(table()), ['d', 'a', 'b', 'c'], 'descending keeps the empty one last');
  });

  await check('dates sort by the row\'s underlying value, not the formatted text; a missing date is last', () => {
    reset();
    ui.toggleTableSort('t', 'when');
    assert.deepEqual(order(table()), ['b', 'c', 'a', 'd']);
    ui.toggleTableSort('t', 'when');
    assert.deepEqual(order(table()), ['a', 'c', 'b', 'd']);
    assert.equal(ui.normalizeSortValue(new Date(5)), 5);
    assert.equal(ui.normalizeSortValue('-'), null);
    assert.equal(ui.normalizeSortValue('85%'), 85);
  });

  await check('toggle: new column ascending, same column flips; aria-sort + data-dir only on the active head', () => {
    reset();
    ui.toggleTableSort('t', 'n');
    let out = table();
    assert(/aria-sort="ascending"><button[^>]*data-sort="n"[^>]*data-dir="asc"/.test(out));
    assert.equal((out.match(/aria-sort="none"/g) || []).length, 2);
    ui.toggleTableSort('t', 'n');
    assert(/aria-sort="descending"><button[^>]*data-sort="n"[^>]*data-dir="desc"/.test(table()));
    ui.toggleTableSort('t', 'name');
    assert(/aria-sort="ascending"><button[^>]*data-sort="name"/.test(table()));
    assert(/aria-sort="none"><button[^>]*data-sort="n"/.test(table()));
  });

  await check('the click handler flips the state and redraws; the state survives re-render and is per table', () => {
    reset(); rendered = 0;
    const btn = attrs => ({ getAttribute: k => attrs[k] == null ? null : attrs[k] });
    G.handlers.click['table-sort'](btn({ 'data-table': 'one', 'data-sort': 'name' }));
    assert.equal(rendered, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.tableSortState.one)), { col: 'name', dir: 'asc' });
    assert.equal(ui.tableSortState.two, undefined);
    const a = table('one'), b = table('one');
    assert.equal(a, b, 're-rendering gives the same sorted table');
    assert.deepEqual(order(table('two')), ['a', 'b', 'c', 'd'], 'another table is untouched');
    // a default arrow (data-dir) flips on the first press
    G.handlers.click['table-sort'](btn({ 'data-table': 'three', 'data-sort': 'name', 'data-dir': 'asc' }));
    assert.equal(ui.tableSortState.three.dir, 'desc');
  });

  await check('a column\'s own default arrow (sort: ascending) shows without reordering until another head is pressed', () => {
    reset();
    const cols = COLS.map(c => c.key === 'name' ? Object.assign({}, c, { sort: 'ascending' }) : c);
    const out = ui.dataTableHtml({ key: 'd', label: 'D', columns: cols, rows: rows, showAll: true });
    assert(/aria-sort="ascending"><button[^>]*data-sort="name"/.test(out));
    assert.deepEqual(order(out), ['a', 'b', 'c', 'd']);
  });

  await check('the viewer\'s own row stays in its sorted place, tinted', () => {
    reset();
    const me = mk('me', 'Zed', '5', '2026-10-09', { you: true });
    ui.toggleTableSort('y', 'n');
    const out = ui.dataTableHtml({ key: 'y', label: 'Y', columns: COLS, rows: rows.concat([me]), showAll: true });
    assert.deepEqual(order(out), ['me', 'b', 'a', 'd', 'c'], 'ascending 5 (you), 9, 10, 100, empty');
    assert(out.includes('gs-dtable-row is-you'));
  });

  await check('sortItems / sortThHtml for hand-built tables: sorted copy, original untouched, th carries the button', () => {
    reset();
    const items = [{ n: 'b' }, { n: 'A' }, { n: null }];
    const g = { name: x => x.n };
    assert.equal(ui.sortItems('h', items, g), items, 'no state: the same list');
    ui.toggleTableSort('h', 'name');
    assert.deepEqual(ui.sortItems('h', items, g).map(x => x.n), ['A', 'b', null]);
    assert.deepEqual(items.map(x => x.n), ['b', 'A', null]);
    assert.equal(ui.sortItems('h', items, {}), items, 'an unknown column leaves the order');
    const th = ui.sortThHtml('h', 'name', 'Name');
    assert(th.startsWith('<th scope="col" aria-sort="ascending"><button type="button" class="gs-sort" data-action="table-sort" data-table="h" data-sort="name"'));
    assert(ui.sortThHtml('h', 'other', 'Other').includes('aria-sort="none"'));
  });

  // Per page: every table in these files carries sort heads. The hand-built ones may keep a bare head only for a row-action / tick column.
  const DATA_TABLE_PAGES = ['pages-away.js', 'pages-bnet.js', 'pages-loot-fix.js', 'pages-loot-hub.js', 'pages-loot-night.js', 'pages-person-attendance.js', 'pages-raids.js', 'pages-view.js'];
  await check('dataTableHtml pages: no column opts out of sorting except a row-action column', () => {
    for (const f of DATA_TABLE_PAGES) {
      const src = read('js/guild/' + f);
      assert(src.includes('dataTableHtml'), f);
      assert(!/sort:\s*false/.test(src), f + ' opts a column out');
      for (const m of src.matchAll(/\{ key: '[^']+', label: '[^']+'([^}]*)\}/g)) {
        if (/srLabel/.test(m[1])) continue;
        assert(!/sort:\s*false/.test(m[1]), f + ': ' + m[0]);
      }
    }
  });

  const HAND_BUILT = {
    'pages-backfill.js': ['backfill'], 'pages-import.js': ['rh-new', 'wcl-decide'], 'pages-import-csv.js': ['csv-rows'], 'pages-import-bnet.js': ['bnet-import'],
    'pages-launch.js': ['launch-roles', 'launch-people'], 'pages-progress.js': ["-bosses'", "-nights'"], 'pages-settings-activity.js': ['settings-activity'],
    'pages-settings-dataaccess.js': ['dkeys'], 'pages-settings-guests.js': ['guest-links'], 'pages-settings-teams.js': ['settings-teams'],
  };
  await check('hand-built tables: every data head is a sortThHtml, its rows go through sortItems', () => {
    for (const [f, keys] of Object.entries(HAND_BUILT)) {
      const src = read('js/guild/' + f);
      for (const k of keys) {
        assert(src.includes('sortThHtml(') && src.includes(k), f + ' ' + k);
        assert(src.includes("sortItems(") , f + ' sorts its rows');
      }
      // a bare <th scope="col">Label</th> is left only on a tick / action column (those carry the label in .gs-sr or none)
      const bare = (src.match(/<th scope="col">[A-Za-z][^<]*<\/th>/g) || []).filter(h => h !== '<th scope="col">Add</th>'); // Add = the tick column
      assert.deepEqual(bare, [], f + ' still has plain heads: ' + bare.join(' '));
    }
  });

  await check('the Loot standings Order bar clears a head sort (the last one pressed wins)', () => {
    assert(/lstand-sort'\][\s\S]{0,300}clearTableSort\('Loot standings'\)/.test(read('js/guild/pages-loot-hub.js')));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
