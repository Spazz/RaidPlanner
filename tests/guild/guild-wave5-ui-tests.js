/**
 * Raidsmith guild UI, PM wave 5 (the pre-raid loot board with TMB / softres pastes, and manual loot awards) - tests for the Loot board card, its paste panels, the
 * raid page's Actions menu entries and the "Add award" dialog of the Loot card.
 * Run: node tests/guild/guild-wave5-ui-tests.js
 *
 * Same approach as guild-wave4-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render functions return HTML strings and the handlers
 * run against a stubbed G.api and a fake document. guild-wave5-contract-tests.js runs the same pages against the real Worker.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('node:zlib');

let passed = 0, failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('../guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, Uint8Array, atob, TextDecoder, DecompressionStream };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
let els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const encode = value => zlib.deflateSync(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')).toString('base64');

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

const OFFICER_CAN = {
  'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild',
  'guild.teams': 'guild', 'roster.edit': 'guild', 'loot.view': 'guild', 'loot.edit': 'guild',
};
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'loot.view': ['t1'] };
function gd(can) {
  return {
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [{ id: 't1', name: 'Team KJ', size: 25, archived: false, players: 3, leads: [] }],
    me: { roles: [], can },
    attendanceFlags: {},
  };
}
const SOURCES = { event: null, reports: [], plan: null };
const PAST = (over) => Object.assign({
  raid: { id: 'r4', team: 't1', raidOn: '2026-10-17', startsAt: 1, zone: 'Black Temple', size: 25, state: 'reviewed', openFlags: 0, stale: false, version: 1 },
  can: { edit: true, review: true, seeAttendance: true, seeNicknames: true }, sources: SOURCES, pulls: [], people: [], unmatched: [], signups: [],
}, over || {});
const UPCOMING = (over) => PAST(Object.assign({
  raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: null, zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 },
}, over || {}));

const e = (name, nameKey, over) => Object.assign({ key: 'prio:' + nameKey, name, nameKey, personId: 'p_' + nameKey, class: 'WARRIOR', kind: 'prio', prio: 1, copies: 1, guest: false, received: false, top: false }, over || {});
const BOARD = (over) => Object.assign({
  raid: { id: 'r4', raidOn: '2026-10-17', upcoming: false },
  canEdit: true,
  roster: { source: 'signups', people: 3 },
  lists: { tmb: { rows: 12, importedAt: Date.now() - 3600000 }, softres: null },
  items: [
    {
      itemId: 28770, itemName: 'Nathrezim Mindblade', contested: true, done: false, omitted: 2, results: [{ winner: 'Aldric', personId: 'p_aldric', tag: 'MS', result: 'top', kind: 'prio' }],
      line: [e('Aldric', 'aldric', { prio: 1, top: true }), e('Brindle', 'brindle', { prio: 1, top: true, class: 'MAGE' }), e('Pugone', 'pugone', { kind: 'sr', prio: null, copies: 2, guest: true, personId: null, class: null, top: true }), e('Cassia', 'cassia', { kind: 'wish', prio: 2, class: 'PRIEST' })],
    },
    {
      itemId: 30311, itemName: null, contested: false, done: true, omitted: 0, results: [{ winner: 'Cassia', personId: 'p_cassia', tag: 'MS', result: 'elsewhere', kind: null }, { winner: null, personId: null, tag: 'DE', result: 'disenchanted', kind: null }],
      line: [e('Aldric', 'aldric', { received: true })],
    },
    { itemId: 31000, itemName: 'Quiet Item', contested: false, done: false, omitted: 0, results: [], line: [e('Thoren', 'thoren', { prio: 3, top: true })] },
  ],
  unmatched: ['Zed'],
}, over || {});
const okState = (over) => Object.assign({ gid: 'g1', rid: 'r4', status: 'ok', data: BOARD(), ui: G.pages.raidBoard.freshUi(), view: G.pages.raidBoard.freshView() }, over || {});
// The Loot prios pieces together: the item list (main column) and the summary (side column).
const card = (state, data, can) => G.pages.raidBoard.listHtml({ guildData: gd(can || OFFICER_CAN), data: data || PAST(), state }) + G.pages.raidBoard.summaryHtml({ guildData: gd(can || OFFICER_CAN), data: data || PAST(), state });
const flow = (state) => G.pages.raidBoard.pasteFlowHtml({ state });

const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert };
    S.att = {}; S.guilds = {}; S.pageAlert = '';
    els = {};
    try { await fn(S); } finally { Object.assign(S, saved); }
  };
}
let renders = 0;
const countRenders = () => { const real = G.app.render; renders = 0; G.app.render = () => { renders++; }; return () => { G.app.render = real; }; };
function boardSetup(S, over, can) {
  S.guilds.g1 = gd(can || OFFICER_CAN); S.currentGid = 'g1';
  S.att.raid = { gid: 'g1', rid: 'r4', data: PAST() };
  S.att.raidBoard = okState(over);
  return S.att.raidBoard;
}

// ── api ──────────────────────────────────────────────────────────
check('api: board, saveList, manual and teamRoster hit the contract paths with the contract bodies', async () => {
  const s = stub(() => Promise.resolve({}));
  await G.api.loot.board('g1', 'r1');
  await G.api.loot.saveList('g1', 'r1', 'tmb', [{ name: 'Aldric', itemId: 1, kind: 'prio', prio: 1 }]);
  await G.api.loot.saveList('g1', 'r1', 'softres', []);
  await G.api.loot.manual('g1', 'r1', { itemId: 5, winnerName: 'Aldric', tag: 'MS' });
  await G.api.teamRoster('g1', 't1');
  assert.deepEqual(plain(s.calls), [
    { m: 'get', url: '/api/guild/g1/raids/r1/loot-board' },
    { m: 'put', url: '/api/guild/g1/raids/r1/loot-lists', body: { source: 'tmb', rows: [{ name: 'Aldric', itemId: 1, kind: 'prio', prio: 1 }] } },
    { m: 'put', url: '/api/guild/g1/raids/r1/loot-lists', body: { source: 'softres', rows: [] } },
    { m: 'post', url: '/api/guild/g1/raids/r1/loot/manual', body: { itemId: 5, winnerName: 'Aldric', tag: 'MS' } },
    { m: 'get', url: '/api/guild/g1/roster?team=t1' },
  ]);
  s.restore();
});

// ── the card ─────────────────────────────────────────────────────
check('card: players have their own item lists with priority labels, guest tags and award results', () => {
  const out = card(okState());
  const text = stripTags(out);
  assert(out.includes('id="board-h"') && text.includes('Loot prios') && text.includes('3 items, 1 roll-off'));
  const rows = out.split('<li class="gs-board-row').slice(1);
  assert.equal(rows.length, 5);
  const names = ['Aldric', 'Brindle', 'Cassia', 'Pugone', 'Thoren'];
  rows.forEach((row, i) => assert(row.includes('aria-label="Items for ' + names[i] + '"')));
  assert(rows[0].includes('>Nathrezim Mindblade<') && rows[0].includes('>Item 30311<'));
  assert(rows[0].includes('Roll-off') && rows[0].includes('Already got it') && rows[0].includes('All have it'));
  assert(rows[0].includes('Went to prio #1: Aldric') && rows[0].includes('Went elsewhere: Cassia'));
  assert(rows[0].includes('Disenchanted') && !rows[0].includes('Disenchanted:'));
  assert(rows[1].includes('gs-class-mage') && rows[2].includes('gs-class-priest'));
  assert(stripTags(rows[2]).includes('Wish #2'));
  assert(stripTags(rows[3]).includes('Guest') && stripTags(rows[3]).includes('SR x2'));
  assert(stripTags(rows[4]).includes('Prio #3') && !rows[4].includes('Roll-off'));
  const filtered = card(okState({ view: { contested: false, player: 'aldric' } })).split('<li class="gs-board-row').slice(1);
  assert.equal(filtered.length, 1);
  assert(filtered[0].includes('Items for Aldric'));
  assert(/TMB prios\s*:\s*12 rows, pasted/.test(text) && /Soft-reserves\s*:\s*not pasted/.test(text));
  assert(text.includes('In line: the 3 people signed up, placed or present on this raid.'));
  assert(text.includes('1 TMB name is not on the roster') && out.includes('Zed'));
  assertNoRawAttrs(out);
});

check('card: result wording (soft-reserve winner, lower prio) and the team fallback line', () => {
  const R = G.pages.raidBoard;
  assert.equal(R.resultText({ result: 'top', kind: 'prio' }), 'Went to prio #1');
  assert.equal(R.resultText({ result: 'top', kind: 'sr' }), 'Went to a soft-reserve holder');
  assert.equal(R.resultText({ result: 'lower' }), 'Went to a lower prio');
  assert.equal(R.resultText({ result: 'elsewhere' }), 'Went elsewhere');
  assert.equal(R.resultText({ result: 'disenchanted' }), 'Disenchanted');
  const text = stripTags(card(okState({ data: BOARD({ roster: { source: 'team', people: 18 } }) })));
  assert(text.includes('Nobody is signed up or placed yet: everyone on the team (18 people) counts as coming.'));
});

check('card: filters (roll-offs only, by player) keep the matching items and say how many are shown', () => {
  const R = G.pages.raidBoard;
  const data = BOARD();
  assert.deepEqual(R.visibleItems(data, { contested: false, player: '' }).map(i => i.itemId), [28770, 30311, 31000]);
  assert.deepEqual(R.visibleItems(data, { contested: true, player: '' }).map(i => i.itemId), [28770]);
  assert.deepEqual(R.visibleItems(data, { contested: false, player: 'aldric' }).map(i => i.itemId), [28770, 30311]);
  assert.deepEqual(R.visibleItems(data, { contested: true, player: 'thoren' }).map(i => i.itemId), []);
  assert.deepEqual(R.playersOf(data).map(p => p.name), ['Aldric', 'Brindle', 'Cassia', 'Pugone', 'Thoren']);
  const out = card(okState({ view: { contested: true, player: '' } }));
  assert(out.includes('id="bd-contested"') && /id="bd-contested"[^>]* checked/.test(out) && out.includes('<option value="">Everyone</option>'));
  assert(stripTags(out).includes('Showing 1 of 3 items.') && !out.includes('Quiet Item'));
  const none = stripTags(card(okState({ view: { contested: true, player: 'thoren' } })));
  assert(none.includes('No item matches these filters.'));
  assert(/<option value="thoren" selected>Thoren<\/option>/.test(card(okState({ view: { contested: false, player: 'thoren' } }))));
});

check('card: who sees what - members only see pasted lists, nothing for denied / none, an error card retries, an editor with nothing pasted gets the buttons', () => {
  const empty = BOARD({ lists: { tmb: null, softres: null }, items: [], unmatched: [] });
  assert.equal(card(okState({ data: Object.assign({}, empty, { canEdit: false }) }), PAST(), MEMBER_CAN).includes('Loot prios'), false, 'a member sees nothing before anything is pasted');
  const member = card(okState({ data: BOARD({ canEdit: false }) }), PAST(), MEMBER_CAN);
  assert(member.includes('Nathrezim Mindblade') && !member.includes('data-action="board-open"') && !member.includes('data-action="board-remove"') && !member.includes('bd-paste'));
  assert(member.includes('data-action="board-print"'), 'printing is for everyone who sees the board');
  assert.equal(card({ gid: 'g1', rid: 'r4', status: 'denied' }), '');
  assert.equal(card({ gid: 'g1', rid: 'r4', status: 'none' }), '');
  assert.equal(card(null), '');
  const err = card({ gid: 'g1', rid: 'r4', status: 'error', error: 'Something broke.' });
  assert(err.includes('Something broke.') && err.includes('data-action="board-reload"'));
  const editor = card(okState({ data: empty }));
  assert(stripTags(editor).includes('Paste the ThatsMyBIS prios and the softres.it reserves of this raid'));
  assert(editor.includes('data-action="board-open" data-list="tmb"') && editor.includes('data-action="board-open" data-list="softres"'));
  assert(!editor.includes('data-action="board-print"'), 'nothing to print yet');
  const nobody = stripTags(card(okState({ data: BOARD({ items: [], unmatched: ['Zed', 'Yan'] }) })));
  assert(nobody.includes('Nobody on this raid is in line for an item in the pasted lists.') && nobody.includes('2 names in the TMB prios are not on the roster: Zed, Yan.'));
  assert(card(okState()).includes('data-action="board-remove" data-list="tmb"') && !card(okState()).includes('data-action="board-remove" data-list="softres"'), 'Remove only for a list that was pasted');
});

check('card: names, item names and notes from the data are escaped everywhere', () => {
  const data = BOARD();
  data.items[0].itemName = HOSTILE + QUOTES;
  data.items[0].line[0].name = HOSTILE + QUOTES;
  data.items[0].results[0].winner = HOSTILE + QUOTES;
  data.unmatched = [HOSTILE];
  const out = card(okState({ data }));
  assertEscaped(out, 'board');
  assertNoRawAttrs(out);
  const html = G.pages.raidBoard.printHtml(gd(OFFICER_CAN), PAST().raid, data, G.pages.raidBoard.freshView());
  assertEscaped(html, 'print');
});

check('print sheet: item, roll-off and the line as plain text, respecting the filters', () => {
  const html = G.pages.raidBoard.printHtml(gd(OFFICER_CAN), PAST().raid, BOARD(), { contested: false, player: '' });
  const text = stripTags(html);
  assert(text.startsWith('Loot prios - ') && text.includes('Black Temple') && text.includes('Ravens - 3 items'));
  assert(text.includes('Nathrezim Mindblade Roll-off Prio #1 Aldric, Prio #1 Brindle, SR x2 Pugone (guest), Wish #2 Cassia'));
  assert(text.includes('Item 30311') && text.includes('Prio #1 Aldric (has it)'));
  const only = stripTags(G.pages.raidBoard.printHtml(gd(OFFICER_CAN), PAST().raid, BOARD(), { contested: true, player: '' }));
  assert(only.includes('1 item (roll-offs only)') && !only.includes('Quiet Item') && !only.includes('Item 31000'));
  assert(/[^\x00-\x7f]/.test(html) === false, 'ASCII only');
});

// ── paste panels ─────────────────────────────────────────────────
check('panel: input stage has a paste box, a file picker, Read and Close; the help names the export; closed when nothing is open', () => {
  const R = G.pages.raidBoard;
  assert.equal(R.panelHtml(okState()), '');
  const tmb = R.panelHtml(okState({ ui: Object.assign(R.freshUi(), { list: 'tmb' }) }));
  assert(tmb.includes('id="bd-paste"') && tmb.includes('data-input="board-paste"') && tmb.includes('id="bd-file"') && tmb.includes('data-action="board-read"') && tmb.includes('data-action="board-close"'));
  assert(stripTags(tmb).includes('Paste TMB prios') && !stripTags(tmb).includes('Loot prio (TMB)') && stripTags(tmb).includes('Export Gargul') && tmb.includes('aria-describedby="bd-help"'));
  const sr = R.panelHtml(okState({ ui: Object.assign(R.freshUi(), { list: 'softres', text: HOSTILE, error: 'Bad.' }) }));
  assert(stripTags(sr).includes('Paste soft-reserves') && !stripTags(sr).includes('softres)') && stripTags(sr).includes('Gargul Export') && sr.includes('Bad.'));
  assertEscaped(sr, 'paste text');
  assertNoRawAttrs(tmb + sr);
  // The panel is drawn by the page at the top of the main column, for editors only; the list and the summary never hold it.
  const open = okState({ ui: Object.assign(R.freshUi(), { list: 'tmb' }) });
  assert(flow(open).includes('id="bd-paste"') && !card(open).includes('id="bd-paste"'));
  assert(flow(Object.assign(open, { data: BOARD({ canEdit: false }) })) === '', 'not for a viewer who cannot edit');
  assert.equal(flow(okState()), '', 'closed: nothing');
});

check('panel: preview stage counts what was read, says what it replaces, lists the skipped entries and saves N rows; done stage closes', () => {
  const R = G.pages.raidBoard;
  const parsed = { ok: true, rows: 40, entries: new Array(30).fill({}), skipped: [{ label: 'item 5', reason: 'Name is not a character name' }], skippedCount: 3, stats: { items: 6, characters: 9, prio: 25, wish: 5, wishLeftOut: 1 } };
  const out = R.panelHtml(okState({ ui: Object.assign(R.freshUi(), { list: 'tmb', stage: 'preview', parsed }) }));
  const text = stripTags(out);
  assert(text.includes('Read 25 prio rows and 5 wishlist rows for 6 items and 9 characters. 1 wishlist row on items nobody has a prio on was left out.'));
  assert(text.includes('3 entries were left out of the paste') && text.includes('item 5: Name is not a character name') && text.includes('And 2 more.'));
  assert(text.includes('This replaces the 12 rows pasted'), 'a list is there already');
  assert(out.includes('data-action="board-save"') && text.includes('Save 30 rows') && out.includes('data-action="board-back"'));
  const soft = { ok: true, rows: 3, entries: [{}, {}], skipped: [], stats: { items: 2, characters: 2, reserves: 3, hardReserves: 1 } };
  const fresh = R.panelHtml(okState({ ui: Object.assign(R.freshUi(), { list: 'softres', stage: 'preview', parsed: soft }) }));
  assert(stripTags(fresh).includes('Read 3 reserves on 2 items by 2 characters. 1 hard-reserve is not used.') && !stripTags(fresh).includes('This replaces'));
  const busy = R.panelHtml(okState({ ui: Object.assign(R.freshUi(), { list: 'softres', stage: 'preview', parsed: soft, busy: true }) }));
  assert(/<button[^>]*disabled[^>]*data-action="board-save"[^>]*><span>Saving\.\.\.<\/span>/.test(busy));
  assert(out.includes('class="gs-commitbar is-inline"') && out.includes('Nothing is saved yet.') && /<li class="gs-step is-current" aria-current="step">(?:(?!<\/li>)[\s\S])*Preview/.test(out), 'the T5 commit bar and stepper, inside the panel');
  const done = R.panelHtml(okState({ ui: Object.assign(R.freshUi(), { list: 'tmb', stage: 'done', note: 'Saved 30 rows of the TMB prios. The board is up to date.' }) }));
  assert(done.includes('id="bd-result"') && stripTags(done).includes('Saved 30 rows') && done.includes('data-action="board-close"') && !done.includes('bd-paste'));
});

const AWARD_OF = (id) => ({ id, raidId: 'r4', raidOn: '2026-10-17', teamId: 't1', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: Date.now(), winner: { name: 'Aldric', realm: 'Firemaw', class: 'WARRIOR' }, match: { kind: 'character', personId: 'p_a', personName: 'Aldric', characterName: 'Aldric' }, tag: 'MS', tagSetBy: null, flags: [], rollType: null, note: null });

check('More holds page-level items only (none of the four loot items); the Loot and Loot prios panels hold the buttons; an open flow hides its button and opens at the top of the main column', () => {
  const labelsOf = (out) => {
    const menu = out.slice(out.indexOf('id="raid-actions-list"'), out.indexOf('</div></div>', out.indexOf('id="raid-actions-list"')));
    return [...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(m => m[1]);
  };
  const lootOk = () => ({ gid: 'g1', rid: 'r4', status: 'ok', data: { awards: [], canEdit: true }, ui: G.pages.raidLoot.freshUi() });
  const page = (data, over) => G.pages.raid.raidHtml(Object.assign({ guildData: gd(OFFICER_CAN), data }, over || {}));
  const past = page(PAST(), { loot: lootOk(), board: okState() });
  assert.deepEqual(labelsOf(past), ['Open in Planner', 'Recalculate attendance', 'Mark as No log', 'Paste raid roster', 'Raid settings', 'Delete raid']);
  for (const gone of ['Import loot from Gargul', 'Add loot award', 'Loot prio (TMB)', 'Soft-reserves (softres)']) assert(!labelsOf(past).includes(gone), gone + ' left the More menu');
  assert(!past.includes('mi-loot-import') && !past.includes('mi-loot-add') && !past.includes('mi-board-tmb') && !past.includes('mi-board-softres'));
  // Their homes: the Loot panel head and the Loot prios summary.
  assert(past.includes('data-action="loot-import-open" data-key="loot-import-open">Import from Gargul<') && past.includes('data-action="loot-add-open" data-key="loot-add-open">Add award<'));
  assert(past.includes('data-action="board-open" data-list="tmb" data-key="board-open-tmb">Paste TMB prios<') && past.includes('data-action="board-open" data-list="softres" data-key="board-open-softres">Paste soft-reserves<'));
  const up = page(UPCOMING(), { board: okState({ rid: 'u1' }) });
  assert.deepEqual(labelsOf(up), ['Open in Planner', 'Raid settings', 'Guest sign-up link', 'Delete raid']);
  assert(up.includes('>Paste TMB prios<') && up.includes('>Paste soft-reserves<') && !up.includes('loot-import-open'), 'before the raid: the prio buttons only');
  // An open paste: its button is gone and the panel is the first thing in the main column.
  const openTmb = page(UPCOMING(), { board: okState({ rid: 'u1', ui: Object.assign(G.pages.raidBoard.freshUi(), { list: 'tmb' }) }) });
  assert(!openTmb.includes('data-key="board-open-tmb"') && openTmb.includes('data-key="board-open-softres"'));
  const mainAt = openTmb.indexOf('<div class="gs-rpg-main">') + '<div class="gs-rpg-main">'.length;
  assert(openTmb.slice(mainAt).startsWith('<div class="gs-loot-import gs-import-panel" role="group" aria-labelledby="bd-title">'), 'the TMB panel opens at the top of the main column');
  assert(openTmb.indexOf('id="bd-paste"') < openTmb.indexOf('id="s-signups"') || !openTmb.includes('id="s-signups"'));
  // The Gargul import too (after the raid), above the attendance board; both flows can be open at once.
  const gOpen = lootOk(); gOpen.ui.open = true;
  const both = page(PAST(), { loot: gOpen, board: okState({ ui: Object.assign(G.pages.raidBoard.freshUi(), { list: 'softres' }) }) });
  const bothMain = both.slice(both.indexOf('<div class="gs-rpg-main">'));
  assert(bothMain.indexOf('id="gl-paste"') > 0 && bothMain.indexOf('id="gl-paste"') < bothMain.indexOf('id="bd-paste"') && bothMain.indexOf('id="bd-paste"') < bothMain.indexOf('id="raid-people"'), 'Gargul, then the paste, then the board');
  assert(!both.includes('data-key="loot-import-open"'), 'the import button hides while its panel is open');
  // A viewer who cannot edit gets neither the menu nor any paste button.
  const member = G.pages.raid.raidHtml({ guildData: gd(MEMBER_CAN), data: PAST({ can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), board: okState({ data: BOARD({ canEdit: false }) }) });
  assert(!member.includes('raid-actions'), 'no Actions menu for a viewer who cannot edit');
  assert(member.includes('id="board-h"') && !member.includes('data-action="board-open"') && !member.includes('data-action="board-remove"'));
  assert(!page(UPCOMING(), {}).includes('board-h'), 'not loaded: no panel');
  assert(page(UPCOMING(), { board: okState({ rid: 'u1' }) }).includes('id="board-h"'), 'the list is on an upcoming raid too');
  // On a past raid the prio list is in the main column and the Loot panel in the side column.
  const lootSome = lootOk(); lootSome.data.awards = [AWARD_OF('a1')];
  const full = page(PAST(), { loot: lootSome, board: okState() });
  assert(full.indexOf('id="board-h"') < full.indexOf('id="loot-h"'));
});


check('raid page side column after the raid: Raid facts, Bosses, Loot (5 rows, All N items), then the Loot prios summary; phone order hooks on each panel', () => {
  const pulls = [
    { encounter: 'Illidan Stormrage', kill: false, startedAt: 7000 }, { encounter: 'High Warlord Naj\'entus', kill: true, startedAt: 1000 }, { encounter: 'Supremus', kill: true, startedAt: 2000 },
    { encounter: 'Shade of Akama', kill: false, startedAt: 3000 }, { encounter: 'Shade of Akama', kill: true, startedAt: 4000 }, { encounter: 'Illidan Stormrage', kill: false, startedAt: 8000 }, { encounter: 'Illidan Stormrage', kill: false, startedAt: 9000 },
  ];
  const loot = { gid: 'g1', rid: 'r4', status: 'ok', data: { awards: Array.from({ length: 7 }, (_, i) => AWARD_OF('a' + i)), canEdit: true }, ui: G.pages.raidLoot.freshUi() };
  const out = G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN), data: PAST({ pulls }), loot, board: okState() });
  const side = out.slice(out.indexOf('<div class="gs-rpg-side">'));
  const at = (id) => side.indexOf(id);
  assert(at('id="raid-facts"') >= 0 && at('id="raid-facts"') < at('id="raid-bosses"') && at('id="raid-bosses"') < at('id="s-loot"') && at('id="s-loot"') < at('board-sum-h'), 'facts, Bosses, Loot, Loot prios');
  assert(side.includes('gs-rpg-sp gs-rpg-sp-bosses') && side.includes('gs-rpg-sp gs-rpg-sp-loot') && side.includes('gs-rpg-sp gs-rpg-sp-prios') && side.includes('gs-rpg-sp gs-rpg-sp-facts'));
  // Bosses: first-pull order, the three words.
  const bosses = stripTags(side.slice(side.lastIndexOf('<section', at('id="raid-bosses"')), side.indexOf('<div class="gs-rpg-sp gs-rpg-sp-loot"')));
  assert.equal(bosses, 'Bosses High Warlord Naj\'entus Kill Supremus Kill Shade of Akama Kill after 1 wipe Illidan Stormrage 3 wipes'); 
  // Loot: 5 rows and All 7 items.
  const lootHtml = side.slice(at('id="s-loot"'), at('gs-rpg-sp-prios'));
  assert.equal((lootHtml.match(/<li class="gs-rpl-row"/g) || []).length, 5);
  assert(lootHtml.includes('>All 7 items</a>') && lootHtml.includes('href="#/g/g1/loot/n/r4"'));
  // Loot prios summary lines.
  const sum = stripTags(side.slice(at('gs-rpg-sp-prios')));
  assert(/Loot prios TMB prios: 12 rows, pasted .* Remove Soft-reserves: not pasted 3 items, 1 roll-off Paste TMB prios Paste soft-reserves/.test(sum), sum);
  // No pulls (awaiting log / by hand): no Bosses panel. Before the raid: no Bosses, no Loot.
  assert(!G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN), data: PAST({ pulls: [] }), loot, board: okState() }).includes('id="raid-bosses"'));
  const before = G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN), data: UPCOMING({ pulls }), board: okState({ rid: 'u1' }) });
  assert(!before.includes('raid-bosses') && !before.includes('id="s-loot"') && before.includes('gs-rpg-sp-prios'));
  // The anchors: s-board is the main list when there is one, else the side summary.
  assert(out.includes('id="s-board"') && out.indexOf('id="s-board"') < out.indexOf('<div class="gs-rpg-side">'));
  const noItems = G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN), data: PAST(), board: okState({ data: BOARD({ items: [], unmatched: [] }) }) });
  assert(noItems.includes('id="s-board"') && noItems.indexOf('id="s-board"') > noItems.indexOf('<div class="gs-rpg-side">') && !noItems.includes('id="board-h"'));
});

check('Loot prios: the list is a main-column panel with Roll-offs only, Player and Print in its head; a member sees no Remove or paste; nothing pasted and no right to paste draws nothing', () => {
  const out = G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN), data: PAST(), board: okState() });
  const main = out.slice(out.indexOf('<div class="gs-rpg-main">'), out.indexOf('<div class="gs-rpg-side">'));
  assert(main.includes('id="board-h"') && main.includes('id="bd-contested"') && main.includes('id="bd-player"') && main.includes('data-action="board-print"'), 'filters and Print in the main panel');
  assert(!main.includes('data-action="board-remove"') && !main.includes('data-action="board-open"'), 'Remove and the paste buttons are the summary\'s');
  assert(stripTags(main).includes('In line: the 3 people signed up, placed or present on this raid.'));
  const empty = BOARD({ lists: { tmb: null, softres: null }, items: [], unmatched: [], canEdit: false });
  const mem = G.pages.raid.raidHtml({ guildData: gd(MEMBER_CAN), data: PAST({ can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), board: okState({ data: empty }) });
  assert(!mem.includes('board-h') && !mem.includes('board-sum-h'));
  assert.equal(G.pages.raidBoard.summaryHtml({ state: { gid: 'g1', rid: 'r4', status: 'denied' } }), '');
});

check('load: the raid page loads the board after the loot; a 403 and a 404 draw nothing; another error shows a retry; coming back starts the panel afresh', withState(async (S) => {
  const gdata = gd(OFFICER_CAN);
  S.guilds.g1 = gdata; S.currentGid = 'g1';
  const DETAIL = PAST();
  const SIGNUPS = { raid: { id: 'r4', teamId: 't1', startsAt: 1, upcoming: false, locked: false, closed: 'started' }, can: { edit: true, self: false, seeList: true, seeNicknames: true }, me: null, counts: null, entries: [], roster: [] };
  let board = () => Promise.resolve(BOARD());
  const s = stub((m, url) => /loot-board$/.test(url) ? board() : Promise.resolve(/loot$/.test(url) ? { awards: [], canEdit: true } : /signups$/.test(url) ? SIGNUPS : DETAIL));
  await G.pages.raid.load({ name: 'raid', gid: 'g1', rid: 'r4' }, gdata);
  assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/raids/r4', '/api/guild/g1/raids/r4/signups', '/api/guild/g1/raids/r4/loot', '/api/guild/g1/raids/r4/loot-board']);
  assert.equal(S.att.raidBoard.status, 'ok');
  assert(G.pages.raid.main({ name: 'raid', gid: 'g1', rid: 'r4' }, gdata).includes('id="board-h"'));
  for (const [status, expected] of [[403, 'denied'], [404, 'none'], [500, 'error']]) {
    board = () => Promise.reject(new G.api.ApiError(status, { error: 'x', message: 'No.' }));
    await G.pages.raid.load({ name: 'raid', gid: 'g1', rid: 'r4' }, gdata);
    assert.equal(S.att.raidBoard.status, expected, String(status));
  }
  assert(G.pages.raid.main({ name: 'raid', gid: 'g1', rid: 'r4' }, gdata).includes('data-action="board-reload"'));
  // Try again keeps the panel and the filters.
  board = () => Promise.resolve(BOARD());
  S.att.raidBoard.ui.list = 'softres'; S.att.raidBoard.view.contested = true;
  const done = countRenders();
  G.handlers.click['board-reload']();
  await settle();
  assert.deepEqual([S.att.raidBoard.status, S.att.raidBoard.ui.list, S.att.raidBoard.view.contested], ['ok', 'softres', true]);
  await G.pages.raid.load({ name: 'raid', gid: 'g1', rid: 'r4' }, gdata);
  assert.deepEqual([S.att.raidBoard.ui.list, S.att.raidBoard.view.contested], [null, false], 'opening the page again starts afresh');
  done();
  s.restore();
}));

// ── paste flow ───────────────────────────────────────────────────
const TMB_EXPORT = encode({ wishlists: { 28770: ['aldric|1|1|1', 'brindle|2|1|1', 'cassia|1|2|1'], 30311: ['aldric|1|1|1'] } });
const SOFTRES_EXPORT = encode({ metadata: { id: 'x' }, softreserves: [{ name: 'Pugone', items: [{ id: 28770 }, { id: 28770 }] }], hardreserves: [] });

check('flow: open, paste, Read parses in the browser (nothing is sent), Save replaces the list and shows the board; Close and Back reset', withState(async (S) => {
  const x = boardSetup(S);
  const done = countRenders();
  G.handlers.click['board-open'](el({ 'data-list': 'tmb' }));
  assert.deepEqual([x.ui.list, x.ui.stage], ['tmb', 'input']);
  G.handlers.input['board-paste']({ value: TMB_EXPORT });
  assert.equal(x.ui.text, TMB_EXPORT);
  const s = stub((m, url, body) => Promise.resolve(BOARD({ lists: { tmb: { rows: body.rows.length, importedAt: Date.now() }, softres: null } })));
  G.handlers.click['board-read']();
  assert.equal(x.ui.busy, true);
  await settle();
  assert.equal(s.calls.length, 0, 'reading is local');
  assert.deepEqual([x.ui.stage, x.ui.busy, x.ui.error, x.ui.text], ['preview', false, '', '']);
  assert.deepEqual(plain(x.ui.parsed.stats), { items: 2, characters: 3, prio: 3, wish: 1, wishLeftOut: 0 });
  G.handlers.click['board-back']();
  assert.deepEqual([x.ui.list, x.ui.stage, x.ui.parsed], ['tmb', 'input', null]);
  G.handlers.input['board-paste']({ value: TMB_EXPORT });
  G.handlers.click['board-read']();
  await settle();
  G.handlers.click['board-save']();
  assert.equal(x.ui.busy, true);
  await settle();
  assert.deepEqual(plain(s.calls), [{ m: 'put', url: '/api/guild/g1/raids/r4/loot-lists', body: { source: 'tmb', rows: [
    { name: 'Aldric', itemId: 28770, kind: 'prio', prio: 1 }, { name: 'Brindle', itemId: 28770, kind: 'prio', prio: 2 }, { name: 'Cassia', itemId: 28770, kind: 'wish', prio: 1 }, { name: 'Aldric', itemId: 30311, kind: 'prio', prio: 1 },
  ] } }]);
  assert.deepEqual([x.ui.stage, x.ui.busy, x.ui.parsed], ['done', false, null]);
  assert.equal(x.ui.note, 'Saved 4 rows of the TMB prios. The board is up to date.');
  assert.equal(x.data.lists.tmb.rows, 4, 'the board is the Worker\'s answer');
  G.handlers.click['board-close']();
  assert.deepEqual([x.ui.list, x.ui.stage, x.ui.text], [null, 'input', '']);
  s.restore();
  done();
}));

check('flow: the pasted text is read from the box; bad text says what to paste; a Worker refusal is shown and the paste stays; softres works the same', withState(async (S) => {
  const x = boardSetup(S);
  const done = countRenders();
  G.handlers.click['board-open'](el({ 'data-list': 'softres' }));
  els['bd-paste'] = { value: 'not an export at all!' };
  G.handlers.click['board-read']();
  await settle();
  assert.equal(x.ui.text, 'not an export at all!');
  assert.deepEqual([x.ui.stage, x.ui.busy], ['input', false]);
  assert(/not a softres.it export/.test(x.ui.error), x.ui.error);
  els['bd-paste'] = { value: encode({ softreserves: [{ name: 'Zz9', items: [{ id: 5 }] }] }) };
  G.handlers.click['board-read']();
  await settle();
  assert(/Nothing in this export can be used\. First problem: Name is not a character name\./.test(x.ui.error), x.ui.error);
  els['bd-paste'] = { value: SOFTRES_EXPORT };
  G.handlers.click['board-read']();
  await settle();
  assert.deepEqual([x.ui.stage, x.ui.error, plain(x.ui.parsed.entries)], ['preview', '', [{ name: 'Pugone', itemId: 28770, copies: 2 }]]);
  const s = stub(() => Promise.reject(new G.api.ApiError(400, { error: 'bad_request', message: 'Row 1: the character needs a name (2 to 12 letters).', field: 'rows', index: 0 })));
  G.handlers.click['board-save']();
  await settle();
  assert.deepEqual([x.ui.stage, x.ui.busy, x.ui.error], ['preview', false, 'Row 1: the character needs a name (2 to 12 letters).']);
  assert.equal(x.ui.parsed.entries.length, 1, 'the read rows stay');
  assert.equal(s.calls[0].body.source, 'softres');
  s.restore();
  // A second request while one runs, a panel that is not open, and an unknown list do nothing.
  x.ui.busy = true;
  G.handlers.click['board-read']();
  G.handlers.click['board-save']();
  G.handlers.click['board-open'](el({ 'data-list': 'wowhead' }));
  assert.equal(x.ui.list, 'softres');
  done();
}));

check('flow: a file fills the paste box (too large and unreadable files say so); Remove asks first and sends an empty list', withState(async (S) => {
  const x = boardSetup(S);
  const done = countRenders();
  G.handlers.click['board-open'](el({ 'data-list': 'tmb' }));
  G.handlers.change['board-file']({ files: [{ size: 10, text: () => Promise.resolve('hello') }] });
  await tick();
  assert.equal(x.ui.text, 'hello');
  G.handlers.change['board-file']({ files: [{ size: G.tmb.MAX_TEXT_CHARS + 1, text: () => Promise.resolve('x') }] });
  assert(/larger than 8 MB/.test(x.ui.error));
  G.handlers.change['board-file']({ files: [{ size: 10, text: () => Promise.reject(new Error('nope')) }] });
  await tick();
  assert.equal(x.ui.error, 'Could not read that file.');
  G.handlers.change['board-file']({ files: [] });
  // Remove.
  const realOpen = G.ui.openDialog, realRun = G.ui.runDialog;
  const opened = [];
  G.ui.openDialog = html => { opened.push(html); return null; };
  G.ui.runDialog = (form, promise, ok) => promise.then(ok);
  const s = stub(() => Promise.resolve(BOARD({ lists: { tmb: null, softres: null }, items: [] })));
  G.handlers.click['board-remove'](el({ 'data-list': 'tmb' }));
  assert(opened[0].includes('data-submit="board-remove-form"') && opened[0].includes('Remove the TMB prios?') && opened[0].includes('You can paste them again.'));
  assert.equal(s.calls.length, 0, 'asks first');
  G.handlers.submit['board-remove-form']({ getAttribute: k => ({ 'data-list': 'tmb' })[k] });
  await settle();
  assert.deepEqual(plain(s.calls), [{ m: 'put', url: '/api/guild/g1/raids/r4/loot-lists', body: { source: 'tmb', rows: [] } }]);
  assert.deepEqual([x.data.lists.tmb, x.data.items], [null, []]);
  s.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun;
  done();
}));

check('flow: the filters change the view and keep the focus; Print writes the sheet into #print-sheet and prints; a refresh keeps the panel', withState(async (S) => {
  const x = boardSetup(S);
  const done = countRenders();
  const realFocus = G.ui.focusByKey;
  const focused = [];
  G.ui.focusByKey = k => { focused.push(k); return true; };
  G.handlers.change['board-contested']({ checked: true });
  G.handlers.change['board-player']({ value: 'aldric' });
  assert.deepEqual([x.view.contested, x.view.player, focused], [true, 'aldric', ['bd-contested', 'bd-player']]);
  G.ui.focusByKey = realFocus;
  // Print.
  els['print-sheet'] = { innerHTML: '' };
  let printed = 0;
  const listeners = {};
  ctx.window = { print() { printed++; ctx.window.sawSheet = els['print-sheet'].innerHTML; }, addEventListener(n, f) { listeners[n] = f; }, removeEventListener() {} };
  G.handlers.click['board-print']();
  assert.equal(printed, 1);
  assert(ctx.window.sawSheet.includes('class="ps-board"') && ctx.window.sawSheet.includes('Roll-off'));
  assert(!ctx.window.sawSheet.includes('Quiet Item'), 'the filters apply to the sheet');
  listeners.afterprint();
  assert.equal(els['print-sheet'].innerHTML, '', 'the sheet is cleared after printing');
  delete ctx.window;
  // refresh: new data, the open panel stays.
  x.ui.list = 'tmb';
  const s = stub(() => Promise.resolve(BOARD({ roster: { source: 'team', people: 7 } })));
  await G.pages.raidBoard.refresh();
  assert.deepEqual([x.data.roster.people, x.ui.list], [7, 'tmb']);
  s.restore();
  const failing = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'x', message: 'No.' })));
  await G.pages.raidBoard.refresh();
  assert.equal(x.data.roster.people, 7, 'a failed refresh keeps the old board');
  failing.restore();
  done();
}));

// ── manual awards ────────────────────────────────────────────────
const AWARD = { id: 'lo_m', raidId: 'r4', raidOn: '2026-10-17', teamId: 't1', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: null, awardedAt: Date.now(), winner: { name: 'Aldric', realm: 'Firemaw', class: 'WARRIOR' }, match: { kind: 'character', personId: 'p_a', personName: 'Aldric', characterId: 'c_a', characterName: 'Aldric', isMain: true }, tag: 'MS', tagSetBy: 'officer', flags: [], rollType: null, note: null, awardedBy: null, manual: true };

check('loot card: Add award for an editor, a Manual chip with no time on a hand-made award, the delete text does not promise a re-import', () => {
  const lootCard = (awards, can, edit) => G.pages.raidLoot.panelHtml({ guildData: gd(can || OFFICER_CAN), data: PAST(), state: { gid: 'g1', rid: 'r4', status: 'ok', data: { awards, canEdit: edit !== false }, ui: G.pages.raidLoot.freshUi() } });
  const out = lootCard([AWARD, Object.assign({}, AWARD, { id: 'lo_g', manual: undefined, awardedAt: Date.UTC(2026, 9, 18, 1, 30) })]);
  assert(out.includes('data-action="loot-add-open"') && out.includes('>Add award<'));
  const rows = [AWARD, Object.assign({}, AWARD, { id: 'lo_g', manual: undefined, awardedAt: Date.UTC(2026, 9, 18, 1, 30) })].map(w => G.pages.loot.awardRowHtml(gd(OFFICER_CAN), w, { when: 'time' }));
  assert(rows[0].includes('>Manual<') && rows[0].includes('<span class="gs-loot-when"></span>'));
  assert(!rows[1].includes('>Manual<') && /gs-loot-when">\d+:\d\d/.test(rows[1]));
  assert(!lootCard([], MEMBER_CAN, false).includes('loot-add-open'));
  assert(stripTags(lootCard([], OFFICER_CAN)).includes('or add an award by hand.'));
  assert.equal(G.pages.raidLoot.canAdd({ status: 'ok', data: { canEdit: true } }), true);
  assert.equal(G.pages.raidLoot.canAdd({ status: 'ok', data: { canEdit: false } }), false);
  assert.equal(G.pages.raidLoot.canAdd(null), false);
});

check('add award dialog: item, optional name, winner with the roster suggestions, tag, note; the names are escaped', () => {
  const out = G.pages.raidLoot.addDialogHtml(['Aldric', 'Brindle', HOSTILE]);
  assert(out.includes('data-submit="loot-add-form"') && out.includes('for="dlg-item"') && out.includes('data-field="itemId"') && out.includes('list="dlg-winners"'));
  assert(out.includes('<option value="Aldric"></option>') && out.includes('<option value="Brindle"></option>'));
  assert(/<option value="MS" selected>Main spec<\/option><option value="OS">Off-spec<\/option><option value="DE">Disenchanted<\/option><option value="BANK">Guild bank<\/option>/.test(out));
  for (const f of ['itemId', 'itemName', 'winnerName', 'tag', 'note']) assert(out.includes('id="dlg-err-' + f + '"'), f);
  assertEscaped(out, 'dialog');
  assertNoRawAttrs(out);
  // A control named like a method of the form's elements collection (item, namedItem, length) hides the control from form.elements.<name>.
  for (const m of out.matchAll(/ name="([^"]+)"/g)) assert(!['item', 'namedItem', 'length'].includes(m[1]), 'control name ' + m[1]);
});

check('add award: open suggests the roster names; submit sends the parsed item id, the winner, tag and note; the new award joins the list and the board reads again', withState(async (S) => {
  const x = boardSetup(S);
  S.att.raidLoot = { gid: 'g1', rid: 'r4', status: 'ok', data: { awards: [], canEdit: true }, ui: G.pages.raidLoot.freshUi() };
  const realOpen = G.ui.openDialog, realRun = G.ui.runDialog, realSet = G.ui.setText, realRender = G.app.render;
  const opened = [];
  G.ui.openDialog = html => { opened.push(html); return {}; };
  G.ui.runDialog = (form, promise, ok) => promise.then(ok);
  const errs = {};
  G.ui.setText = (id, text) => { errs[id] = text; };
  let rendered = 0;
  G.app.render = () => { rendered++; };
  const s = stub((m, url) => {
    if (/roster\?team=/.test(url)) return Promise.resolve({ people: [{ names: ['Aldric', 'Aldric Alt'], shown: { name: 'Aldric' }, main: { name: 'Aldric' } }, { names: [], shown: { name: 'Brindle' }, main: { name: 'Brindle' } }] });
    if (/loot-board$/.test(url)) return Promise.resolve(BOARD({ roster: { source: 'team', people: 9 } }));
    return Promise.resolve({ award: AWARD });
  });
  G.handlers.click['loot-add-open']();
  await settle();
  assert.equal(s.calls[0].url, '/api/guild/g1/roster?team=t1');
  assert(opened[0].includes('<option value="Aldric"></option>') && opened[0].includes('<option value="Aldric Alt"></option>') && opened[0].includes('<option value="Brindle"></option>'));
  const form = (values) => {
    const f = {};
    f.elements = Object.fromEntries(Object.entries(Object.assign({ itemRef: '', itemName: '', winner: '', tag: 'MS', note: '' }, values)).map(([k, v]) => [k, { value: v, focus() { f.focused = k; } }]));
    return f;
  };
  // Refused on the page: no item, no winner (unless DE), a long note.
  let f = form({ itemRef: 'sword', winner: 'Aldric' });
  G.handlers.submit['loot-add-form'](f);
  assert(/item id/i.test(errs['dlg-err-itemId'])); assert.equal(f.focused, 'itemRef');
  f = form({ itemRef: '28770', winner: '' });
  G.handlers.submit['loot-add-form'](f);
  assert(/Pick the winner/.test(errs['dlg-err-winnerName'])); assert.equal(f.focused, 'winner');
  f = form({ itemRef: '28770', winner: 'Aldric', note: 'n'.repeat(201) });
  G.handlers.submit['loot-add-form'](f);
  assert(/200 characters/.test(errs['dlg-err-note']));
  assert.equal(s.calls.filter(c => c.m === 'post').length, 0, 'nothing was sent');
  // Sent: a Wowhead link becomes the item id; empty optional fields are left out.
  G.handlers.submit['loot-add-form'](form({ itemRef: 'https://www.wowhead.com/tbc/item=28770/nathrezim-mindblade', winner: ' Aldric ', tag: 'OS', note: 'Traded' }));
  await settle();
  const post = s.calls.find(c => c.m === 'post');
  assert.deepEqual(post, { m: 'post', url: '/api/guild/g1/raids/r4/loot/manual', body: { itemId: 28770, tag: 'OS', winnerName: 'Aldric', note: 'Traded' } });
  assert.equal(errs['dlg-err-itemId'], '');
  assert.deepEqual(plain(S.att.raidLoot.data.awards.map(a => a.id)), ['lo_m']);
  assert.equal(x.data.roster.people, 9, 'the board was read again');
  // No winner and DE is allowed; a chat link's item name is used when none is typed.
  G.handlers.submit['loot-add-form'](form({ itemRef: '|cffa335ee|Hitem:28770::::::::70:::::::|h[Nathrezim Mindblade]|h|r', tag: 'DE', itemName: 'Own Name' }));
  await settle();
  assert.deepEqual(s.calls.filter(c => c.m === 'post')[1].body, { itemId: 28770, tag: 'DE', itemName: 'Own Name' });
  G.handlers.submit['loot-add-form'](form({ itemRef: '|cffa335ee|Hitem:5::::::::70:::::::|h[Chat Name]|h|r', tag: 'DE' }));
  await settle();
  assert.deepEqual(s.calls.filter(c => c.m === 'post')[2].body, { itemId: 5, tag: 'DE', itemName: 'Chat Name' });
  s.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun; G.ui.setText = realSet; G.app.render = realRender;
}));

check('add award: no roster (the call fails) still opens the dialog; a viewer who cannot edit gets nothing; the delete dialog of a manual award has no re-import line', withState(async (S) => {
  boardSetup(S);
  S.att.raidLoot = { gid: 'g1', rid: 'r4', status: 'ok', data: { awards: [AWARD, Object.assign({}, AWARD, { id: 'lo_g', manual: undefined })], canEdit: true }, ui: G.pages.raidLoot.freshUi() };
  const realOpen = G.ui.openDialog;
  const opened = [];
  G.ui.openDialog = html => { opened.push(html); return {}; };
  const s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'No.' })));
  G.handlers.click['loot-add-open']();
  await settle();
  assert.equal(opened.length, 1);
  assert(opened[0].includes('<datalist id="dlg-winners"></datalist>'));
  for (const id of ['lo_m', 'lo_g']) opened.push(G.pages.raidLoot.deleteDialogHtml(S.att.raidLoot.data.awards.find(w => w.id === id)));
  assert(!opened[1].includes('Importing the same Gargul export again') && opened[2].includes('Importing the same Gargul export again asks before it adds it back.'));
  S.att.raidLoot.data.canEdit = false;
  G.handlers.click['loot-add-open']();
  await settle();
  assert.equal(opened.length, 3);
  s.restore(); G.ui.openDialog = realOpen;
}));

check('files: the new scripts are in the manifest in dependency order, ASCII only outside comments, and the CSS has a rule for every new class', () => {
  const { GUILD_MANIFEST } = require('../guild-scripts');
  const at = n => GUILD_MANIFEST.indexOf('/js/guild/' + n + '.js');
  assert(at('gargul') >= 0 && at('tmb') > at('gargul') && at('softres') > at('tmb'), 'tmb before softres');
  assert(at('pages-raid-board') > at('pages-raid-loot') && at('pages-raid-board') < at('app'), 'the board page after the raid page');
  const css = read('guild.css');
  const board = read('js/guild/pages-raid-board.js') + read('js/guild/pages-raid-loot.js');
  for (const cls of new Set([...board.matchAll(/gs-board-[a-z]+/g)].map(m => m[0]))) assert(css.includes('.' + cls), 'guild.css has .' + cls);
  for (const file of ['tmb', 'softres', 'pages-raid-board']) {
    for (const [i, line] of read('js/guild/' + file + '.js').split('\n').entries()) {
      if (/[^\x00-\x7f]/.test(line) && !line.trim().startsWith('//')) assert.fail(file + ':' + (i + 1) + ' has a non-ASCII character outside a comment');
    }
  }
});

(async () => {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
