/**
 * Raidsmith guild app - lane B8a-links: Guild settings > Links and keys (API keys, guest links and raid join links on one page) and the retirement of
 * Guest links and Data access.
 * Run: node tests/guild/guild-b8a-links-tests.js [name filter]
 *
 * Same approach as guild-roles-ui-tests.js: the shared guild script list (tests/guild-scripts.js) is loaded in a vm with no DOM, the render functions return HTML strings,
 * handlers run against a stubbed G.api and a fake document, and the routes through the real app.js run against a fake page skeleton. The suite carries what the two retired
 * pages' suites covered (the dialogs, the create and turn-off handlers, the token that is never kept, the escaping, the sort heads) on the new page, plus the three groups, the
 * chips, the short dates, the join links, the old addresses and the phone rows. guild-wave7-contract-tests.js and guild-roles-contract-tests.js run the page against the real Worker.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const filter = process.argv[2];
let passed = 0, failed = 0;
async function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`); }
}

function newSandbox(extra) {
  const sandbox = Object.assign({ console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, URL, setTimeout }, extra || {});
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const sandbox = newSandbox();
const fields = {};
sandbox.document = { getElementById: (id) => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = sandbox.Guild;
const L = G.pages.settingsLinks;
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 14; i++) await tick(); };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const count = (html, re) => (html.match(re) || []).length;
const DOT = ' · ';

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

// ---------------------------------------------------------------------------
// fixtures (the Worker's response shapes; the example world of the canvas, Oct 27 2026 in New York)

const NOW = Date.UTC(2026, 9, 27, 16);
const at = (m, d, h) => Date.UTC(2026, m - 1, d, h === undefined ? 16 : h);
const person = (name) => ({ id: 'u_' + name.toLowerCase(), username: name.toLowerCase(), displayName: name, avatarUrl: null, initials: name.slice(0, 2).toUpperCase() });
const TEAMS = [{ id: 't1', name: 'Team KJ', size: 25, archived: false }, { id: 't2', name: 'Sunday Alts', size: 25, archived: false }, { id: 't3', name: 'Old', size: 25, archived: true }];
function guildData(can, extra) {
  return Object.assign({
    guild: { id: 'g1', name: 'Vindicated', realm: 'Dreamscythe', realmKind: 'realm', realmSlug: 'dreamscythe', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', createdAt: 1 },
    teams: TEAMS.map((t) => Object.assign({ players: 0, leads: [] }, t)),
    me: { roles: [{ role: 'officer' }], can: can || { 'guild.access': 'guild' } },
    rosterOptions: null,
  }, extra || {});
}
const key = (id, extra) => Object.assign({
  id, name: 'Loot sheet', team: null, datasets: ['loot', 'roster'], status: 'active', expiresAt: Date.UTC(2027, 0, 24, 16), revokedAt: null, uses: 212, lastUsedAt: at(10, 27, 15), createdAt: at(10, 26), createdBy: person('Cinderlow'),
}, extra || {});
function keyData(extra) {
  return Object.assign({
    keys: [
      key('ak_1'),
      key('ak_2', { name: 'Attendance site', team: { id: 't1', name: 'Team KJ' }, datasets: ['attendance', 'roster'], expiresAt: null, uses: 40, lastUsedAt: at(10, 25), createdAt: at(9, 14), createdBy: person('Mendra') }),
      key('ak_3', { name: 'Old sheet', status: 'revoked', revokedAt: at(9, 1), expiresAt: at(11, 1), uses: 9, lastUsedAt: at(8, 2), createdAt: at(7, 5), createdBy: person('Ashgrove'), datasets: ['raids'] }),
    ],
    datasets: [{ id: 'roster', label: 'Roster', available: true }, { id: 'attendance', label: 'Attendance', available: true }, { id: 'loot', label: 'Loot', available: false }, { id: 'raids', label: 'Raids', available: true }],
    expiries: ['30d', '90d', '365d', 'never'], limits: { perHour: 60, maxActive: 20 },
  }, extra || {});
}
const link = (id, extra) => Object.assign({
  id, label: 'Recruits', role: { id: 'guest', name: 'Guest' }, sections: ['roster', 'raids'], team: null, status: 'active', expiresAt: at(11, 3), revokedAt: null, uses: 6, lastUsedAt: at(10, 26), createdAt: at(10, 20), createdBy: person('Ashgrove'),
}, extra || {});
function guestData(extra) {
  return Object.assign({
    links: [
      link('gl_1'),
      link('gl_2', { label: 'Ironwatch visitors', team: { id: 't1', name: 'Team KJ' }, sections: ['raids'], uses: 0, lastUsedAt: null, expiresAt: at(11, 10), createdAt: at(10, 27), createdBy: person('Brandon') }),
      link('gl_3', { label: null, status: 'expired', expiresAt: at(10, 16), uses: 1, lastUsedAt: null, role: { id: 'cr_loot', name: 'Loot council' }, sections: ['loot'], createdBy: null }),
    ],
    roles: [{ id: 'guest', name: 'Guest', sections: ['roster', 'raids', 'attendance'] }, { id: 'cr_loot', name: 'Loot council', sections: ['loot'] }, { id: 'cr_none', name: 'Nothing yet', sections: [] }],
    expiries: ['1d', '7d', '30d', 'never'],
  }, extra || {});
}
const join = (id, extra) => Object.assign({
  id, raidId: 'r_1', maxUses: 5, uses: 2, status: 'active', createdAt: at(10, 25), createdBy: person('Cinderlow'),
  raid: { raidOn: '2026-10-30', startsAt: Date.UTC(2026, 9, 31, 0), zone: "Gruul's Lair", title: null, teamName: 'Team KJ' },
}, extra || {});
function joinData(extra) {
  return Object.assign({
    links: [
      join('jl_1'),
      join('jl_2', { raidId: 'r_2', maxUses: 10, uses: 10, status: 'full', createdAt: at(10, 22), createdBy: person('Ashgrove'), raid: { raidOn: '2026-11-01', startsAt: Date.UTC(2026, 10, 2, 0), zone: "Magtheridon's Lair", title: null, teamName: 'Sunday Alts' } }),
    ],
    limits: { defaultUses: 5, maxUses: 50, perRaid: 5 },
  }, extra || {});
}
const DATA = () => ({ keys: keyData(), guests: guestData(), joins: joinData() });
const draw = (data, extra) => L.settingsHtml(Object.assign({ guildData: guildData(), data: data === undefined ? DATA() : data, now: NOW }, extra || {}));
const group = (html, title) => { const m = html.match(new RegExp('<section class="gs-lk-group" aria-labelledby="lk-h-[a-z]+"><div class="gs-lk-head"><h3[^>]*><span class="gs-fg-ght">' + title + '</span>[\\s\\S]*?</section>(?=<section class="gs-lk-group"|</div></section>$)')); assert(m, 'group ' + title); return m[0]; };
const deskRows = (html) => html.split('<tr>').filter((r) => r.includes('<th scope="row"')).map((r) => r.split('</tr>')[0]);
const phoneRows = (html) => html.split('<div class="gs-rs-row gs-lk-row">').slice(1);

// ---------------------------------------------------------------------------
// stubs: G.api methods, the dialog opener, the redraw; a fake form and element

function withApi(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = G.api[k]; G.api[k] = stubs[k]; }
  const savedGo = G.app.go, savedRender = G.app.render, savedOpen = G.ui.openDialog;
  const opened = [];
  let renders = 0;
  G.app.go = () => {};
  G.app.render = () => { renders++; };
  G.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return { open: true }; };
  return Promise.resolve(fn({ opened, renders: () => renders })).finally(() => {
    for (const k of Object.keys(saved)) G.api[k] = saved[k];
    G.app.go = savedGo; G.app.render = savedRender; G.ui.openDialog = savedOpen;
  });
}
function formEl(attrs, elements, lists, queries) {
  return { getAttribute: (k) => (attrs || {})[k], elements: elements || {}, querySelectorAll: (sel) => ((lists || {})[sel] || []), querySelector: (sel) => ((queries || {})[sel] || null), closest: () => null, disabled: false };
}
const el = (attrs) => ({ disabled: false, hidden: false, getAttribute: (k) => (attrs || {})[k], closest: () => null, focus() {}, select() {} });
const box = (checked, value) => Object.assign(el({ value }), { checked, value });
const field = (id) => { fields[id] = { textContent: '', hidden: true }; return fields[id]; };
const clearFields = () => { for (const k of Object.keys(fields)) delete fields[k]; };
const okRes = (body) => Promise.resolve(body);
const rejectWith = (status, body) => Promise.reject(new G.api.ApiError(status, body));
function seed(data) {
  const s = G.app.state;
  s.guilds.g1 = guildData(); s.currentGid = 'g1';
  s.linksSettings = Object.assign({ gid: 'g1', notice: '' }, DATA(), data || {});
  return s;
}

(async () => {
  // =========================================================================
  // addresses and the list of pages

  await check('addresses: Guest links and Data access (settings/guests, settings/dataaccess) open Links and keys; the list of pages has Links and keys and neither old page', () => {
    for (const tab of ['guests', 'dataaccess']) {
      assert.deepEqual(plain(G.router.parse('#/g/g1/settings/' + tab)), { name: 'settings', gid: 'g1', tab: 'links' }, tab);
      assert(!G.router.TABS.includes(tab), tab + ' is an alias now, not a tab');
      assert(!G.shell.SETTINGS_TABS.some((t) => t.tab === tab), tab + ' is not a page');
      assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab }), '#/g/g1/settings', 'nothing formats the old address');
    }
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings/links')), { name: 'settings', gid: 'g1', tab: 'links' });
    assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab: 'links' }), '#/g/g1/settings/links');
    const tabs = G.shell.settingsTabs({ 'guild.access': 'guild' }, []);
    assert.deepEqual(plain(tabs.map((t) => t.tab)), ['links']);
    const links = tabs.find((t) => t.tab === 'links');
    assert.deepEqual([links.label, links.group, links.isNew], ['Links and keys', 'Sharing', true]);
    assert.equal(links.purpose, 'Every link and key that opens your guild\'s data without a sign-in, and who made it.');
    assert.equal(G.shell.settingsTabs({ 'guild.roles': 'guild' }, []).some((t) => t.tab === 'links'), false, 'guild.access only');
    const src = read('js/guild/router.js');
    assert(/const TAB_ALIASES = \{\n(    [a-z]+: '[a-z]+',\n)+  \};/.test(src.slice(src.indexOf('const TAB_ALIASES'), src.indexOf('};', src.indexOf('const TAB_ALIASES')) + 3)), 'TAB_ALIASES: one entry per line');
  });

  await check('retired pages: the two scripts are gone from the manifest and the disk, nothing in js/guild or worker/ still points at their addresses, and Links and keys loads before app.js', () => {
    for (const file of ['pages-settings-guests.js', 'pages-settings-dataaccess.js']) {
      assert(!GUILD_SCRIPTS.includes('/js/guild/' + file), file + ' is not in the manifest');
      assert(!fs.existsSync(path.join(ROOT, 'js/guild', file)), file + ' is deleted');
    }
    const at = (file) => GUILD_SCRIPTS.indexOf('/js/guild/' + file);
    assert(at('pages-settings-links.js') > at('pages-settings-discord.js') && at('pages-settings-links.js') < at('pages-settings-public.js') && at('pages-settings-links.js') < at('app.js'));
    assert.equal(GUILD_SCRIPTS.filter((s) => s.endsWith('pages-settings-links.js')).length, 1);
    for (const dir of ['js/guild', 'worker']) {
      const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]));
      for (const file of walk(dir).filter((f) => f.endsWith('.js'))) {
        if (file === 'worker/routes/claim-review.js') continue; // the Owner lane retargets its link
        const src = read(file);
        assert(!/settingsGuests|settingsDataKeys|guestSettings|dataKeySettings|settings\/(guests|dataaccess)|tab: 'dataaccess'|tab: 'guests'/.test(src), file + ' still points at a retired page');
      }
    }
    const app = read('js/guild/app.js');
    assert(!/guests: \{ state|dataaccess: \{ state/.test(app), 'no tab entry for the retired pages');
    assert(/linksSettings: null/.test(app) && /state\.linksSettings = null;/.test(app), 'a state key and a sign-out reset');
    assert(app.includes("loadAttendance('settingsLinks'") && app.includes('P.settingsLinks.main'));
    assert(read('worker/routes/api-v1.js').includes('Guild settings > Links and keys'), 'the key refusal names the new page');
  });

  // =========================================================================
  // the page

  await check('page: three groups in order (API keys, Guest links, Raid join links), each with a count head; New buttons are secondary for keys and guest links only; no intro paragraph, no primary', () => {
    const out = draw();
    assert.deepEqual([...out.matchAll(/<h3 class="gs-fg-gh" id="lk-h-([a-z]+)"><span class="gs-fg-ght">([^<]*)<\/span><span class="gs-fg-ghn">(\d+)<\/span>/g)].map((m) => [m[1], m[2], m[3]]),
      [['keys', 'API keys', '3'], ['guests', 'Guest links', '3'], ['joins', 'Raid join links', '2']]);
    assert(out.includes('class="gs-btn" data-action="lk-key-new"') && /data-action="lk-key-new"[^>]*><span>New key<\/span>/.test(out));
    assert(/data-action="lk-guest-new"[^>]*><span>New guest link<\/span>/.test(out));
    assert(!/lk-join-new/.test(out) && !/New (sign-up|join)/i.test(text(out)), 'a join link is made on its raid');
    assert(!out.includes('gs-btn-molten'), 'no molten primary on the page');
    assert(!/gs-fine" id="(dkeys|guests)-intro"/.test(out) && !/<p class="gs-fine"[^>]*id="[a-z-]*intro/.test(out), 'no intro paragraph');
    assert(!/Data access|Guest links page/i.test(text(out).replace('Guest links', '')), 'no leftover name of a retired page');
    assert(/aria-labelledby="settings-title"/.test(out) && /<table class="gs-table gs-table-links" aria-label="API keys">/.test(out) && /aria-label="Raid join links"/.test(out));
    assertNoRawAttrs(out);
  });

  await check('page: one shared grid (Link, Opens, Used, Ends) in every group; every head is a sort button; the action column is the only one that is not', () => {
    const out = draw();
    const heads = (title) => [...group(out, title).matchAll(/<th scope="col"[^>]*>(?:<button[^>]*data-sort="([a-z]+)"[^>]*>([^<]*)<span[^>]*><\/span><\/button>|<span class="gs-sr">([^<]*)<\/span>)<\/th>/g)].map((m) => m[2] || ('sr:' + m[3]));
    assert.deepEqual(heads('API keys'), ['Link', 'Reads', 'Used', 'Ends', 'sr:Actions']);
    assert.deepEqual(heads('Guest links'), ['Link', 'Shows', 'Used', 'Ends', 'sr:Actions']);
    assert.deepEqual(heads('Raid join links'), ['Link', 'Opens', 'Used', 'Ends', 'sr:Actions']);
    assert.equal(count(out, /<th scope="col" aria-sort="none"><button type="button" class="gs-sort" data-action="table-sort" data-table="lk-(keys|guests|joins)"/g), 12);
    assert(!/<th scope="col">[A-Za-z]/.test(out), 'no plain head');
  });

  await check('rows: API keys - the name with who made it and when, what it reads, used on one line, when it ends (year only when it is not this year, Never for no end)', () => {
    const rows = deskRows(group(draw(), 'API keys'));
    assert.equal(rows.length, 3);
    const t = rows.map(text);
    assert.equal(t[0], 'Loot sheet Made Oct 26 by Cinderlow Whole guild Loot, Roster 212 uses' + DOT + 'last Oct 27 Jan 24, 2027 Turn off');
    assert.equal(t[1], 'Attendance site Made Sep 14 by Mendra Team KJ Attendance, Roster 40 uses' + DOT + 'last Oct 25 Never Turn off');
    assert.equal(t[2], 'Old sheet Turned off Made Jul 5 by Ashgrove Whole guild Raids 9 uses' + DOT + 'last Aug 2 Sep 1');
    assert(/<td>Never<\/td>/.test(rows[1]) && rows[0].includes('<td>Jan 24, 2027</td>'));
    assert(!/Never used|Never opened/.test(t.join(' ')));
    assert.equal(text(group(draw(Object.assign(DATA(), { keys: keyData({ keys: [key('ak_9', { uses: 0, lastUsedAt: null }), key('ak_8', { uses: 1 })] }) })), 'API keys')).includes('Never used'), true);
    assert(text(group(draw(Object.assign(DATA(), { keys: keyData({ keys: [key('ak_8', { uses: 1 })] }) })), 'API keys')).includes('1 use' + DOT));
  });

  await check('rows: guest links - the label (or Untitled), role and team, sections, opens, last open, when it ends; a link nobody made shows no maker', () => {
    const rows = deskRows(group(draw(), 'Guest links'));
    assert.equal(rows.length, 3);
    const t = rows.map(text);
    assert.equal(t[0], 'Recruits Made Oct 20 by Ashgrove Guest, whole guild Roster, Raids 6 opens' + DOT + 'last Oct 26 Nov 3 Turn off');
    assert.equal(t[1], 'Ironwatch visitors Made Oct 27 by Brandon Guest, Team KJ only Raids Never opened Nov 10 Turn off');
    assert.equal(t[2], 'Untitled Expired Made Oct 20 Loot council, whole guild Loot 1 open Oct 16');
  });

  await check('rows: raid join links - the raid, the team, sign-ups used of allowed, the raid start in the guild zone as the end; a link of another officer carries a Turn off like any other', () => {
    const rows = deskRows(group(draw(), 'Raid join links'));
    assert.equal(rows.length, 2);
    const t = rows.map(text);
    assert.equal(t[0], "Gruul's Lair Made Oct 25 by Cinderlow Guest sign-up Team KJ 2 of 5 sign-ups Oct 30 8:00 PM ET Turn off");
    assert.equal(t[1], "Magtheridon's Lair Full Made Oct 22 by Ashgrove Guest sign-up Sunday Alts 10 of 10 sign-ups Nov 1 7:00 PM ET");
    assert(rows[0].includes('<span class="gs-lk-l1">Oct 30</span><span class="gs-fine">8:00 PM ET</span>'), 'the date over the time');
    assert(rows[0].includes('data-action="lk-join-off" data-key="lk-join-off-jl_1" aria-label="Turn off sign-up link Gruul&#39;s Lair" data-join-id="jl_1"') || rows[0].includes('data-join-id="jl_1"'));
    const named = draw(Object.assign(DATA(), { joins: joinData({ links: [join('jl_3', { raid: { raidOn: '2026-12-01', startsAt: at(12, 1), zone: "Gruul's Lair", title: 'Gruul night', teamName: 'Team KJ' }, uses: 1, maxUses: 1 })] }) }));
    assert(text(named).includes('Gruul night') && text(named).includes('1 of 1 sign-up'), 'the raid title wins over the zone; one sign-up is singular');
  });

  await check('chips: a working link or key shows none; Turned off and Full are grey, Expired is rose; the chip sits after the name in the same cell; Turn off is only on a working row', () => {
    const out = draw();
    const chip = (rowHtml) => (rowHtml.match(/<span class="gs-hd-chip is-([a-z]+)">([^<]*)<\/span>/) || []).slice(1);
    const keys = deskRows(group(out, 'API keys')), guests = deskRows(group(out, 'Guest links')), joins = deskRows(group(out, 'Raid join links'));
    assert.deepEqual([keys.map(chip), guests.map(chip), joins.map(chip)], [[[], [], ['grey', 'Turned off']], [[], [], ['rose', 'Expired']], [[], ['grey', 'Full']]]);
    for (const row of keys.concat(guests, joins)) {
      const c = chip(row);
      if (c.length) assert(/<span class="gs-lk-title">[^<]*<\/span><span class="gs-hd-chip/.test(row), 'the chip follows the name');
    }
    assert.deepEqual([keys, guests, joins].map((rows) => rows.map((r) => r.includes('>Turn off</button>'))), [[true, true, false], [true, true, false], [true, false]]);
    assert.equal(count(out, /data-action="lk-(key|guest|join)-off"/g), (2 + 2 + 1) * 2, 'one per working row, in the table and in the phone list');
    const odd = draw(Object.assign(DATA(), { keys: keyData({ keys: [key('ak_7', { status: 'mystery' })] }) }));
    assert(odd.includes('<span class="gs-hd-chip is-grey">mystery</span>'), 'an unknown status is shown, not hidden');
  });

  await check('dates: short, in the guild zone, the year only when it is not the current one', () => {
    const f = { zone: 'America/New_York', now: NOW };
    assert.equal(L.shortDate(Date.UTC(2026, 9, 27, 16), f), 'Oct 27');
    assert.equal(L.shortDate(Date.UTC(2027, 0, 24, 16), f), 'Jan 24, 2027');
    assert.equal(L.shortDate(Date.UTC(2025, 11, 31, 16), f), 'Dec 31, 2025');
    assert.equal(L.shortDate(Date.UTC(2026, 9, 31, 3), f), 'Oct 30', 'Oct 31 03:00 UTC is still Oct 30 in New York');
    assert.equal(L.shortDate(Date.UTC(2026, 9, 31, 3), { zone: 'Pacific/Auckland', now: NOW }), 'Oct 31');
    assert.equal(L.shortDate(Date.UTC(2026, 11, 31, 23), { zone: 'America/New_York', now: Date.UTC(2027, 0, 1, 6) }), 'Dec 31, 2026', 'last year, read in the zone');
    assert.equal(L.shortDate(Date.UTC(2027, 0, 1, 3), { zone: 'America/New_York', now: Date.UTC(2026, 11, 15) }), 'Dec 31', 'Jan 1 03:00 UTC is still Dec 31 of this year in New York');
    assert.equal(L.shortDate(Date.UTC(2026, 9, 27, 16), { zone: 'Not/AZone', now: NOW }).length > 0, true, 'an unknown zone falls back to the viewer\'s');
    assert.equal(L.shortDate(null, f), '');
    assert.equal(L.shortDate(NaN, f), '');
    assert.equal(text(draw(DATA(), { guildData: guildData(null, { guild: Object.assign({}, guildData().guild, { timeZone: 'Pacific/Auckland' }) }) })).includes('2 of 5 sign-ups Oct 31 1:00 PM'), true, 'the end of a join link is the raid start in the guild zone');
  });

  await check('sort: the head sorts one table, the others keep their order; a second press flips it; empty (Never) is always last; the phone list follows the same order', () => {
    G.ui.tableSortState['lk-keys'] = undefined; delete G.ui.tableSortState['lk-keys'];
    const names = (html, title) => deskRows(group(html, title)).map((r) => (r.match(/<span class="gs-lk-title">([^<]*)</) || [])[1].replace(/&#39;/g, "'"));
    assert.deepEqual(names(draw(), 'API keys'), ['Loot sheet', 'Attendance site', 'Old sheet'], 'the Worker\'s order to start with');
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-keys', 'data-sort': 'used' }));
    let out = draw();
    assert.deepEqual(names(out, 'API keys'), ['Old sheet', 'Attendance site', 'Loot sheet'], 'used, ascending');
    assert.deepEqual(names(out, 'Guest links'), ['Recruits', 'Ironwatch visitors', 'Untitled'], 'another table is untouched');
    assert(/aria-sort="ascending"><button[^>]*data-table="lk-keys" data-sort="used"/.test(out));
    assert.deepEqual(phoneRows(group(out, 'API keys')).map((r) => (r.match(/gs-rs-name">([^<]*)</) || [])[1]), ['Old sheet', 'Attendance site', 'Loot sheet']);
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-keys', 'data-sort': 'used' }));
    assert.deepEqual(names(draw(), 'API keys'), ['Loot sheet', 'Attendance site', 'Old sheet'], 'used, descending');
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-keys', 'data-sort': 'ends' }));
    assert.deepEqual(names(draw(), 'API keys'), ['Old sheet', 'Loot sheet', 'Attendance site'], 'ends ascending: Never last');
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-keys', 'data-sort': 'ends' }));
    assert.deepEqual(names(draw(), 'API keys'), ['Loot sheet', 'Old sheet', 'Attendance site'], 'ends descending: Never still last');
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-keys', 'data-sort': 'link' }));
    assert.deepEqual(names(draw(), 'API keys'), ['Attendance site', 'Loot sheet', 'Old sheet'], 'link by name');
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-joins', 'data-sort': 'link' }));
    assert.deepEqual(names(draw(), 'Raid join links'), ["Gruul's Lair", "Magtheridon's Lair"]);
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-joins', 'data-sort': 'ends' }));
    G.handlers.click['table-sort'](el({ 'data-table': 'lk-joins', 'data-sort': 'ends' }));
    assert.deepEqual(names(draw(), 'Raid join links'), ["Magtheridon's Lair", "Gruul's Lair"], 'ends descending: the later raid first');
    for (const k of ['lk-keys', 'lk-guests', 'lk-joins']) delete G.ui.tableSortState[k];
    assert.deepEqual(names(draw(), 'API keys'), ['Loot sheet', 'Attendance site', 'Old sheet']);
  });

  await check('states: loading, an empty group says so in a line (the join one says where a link is made), a notice and an alert; hostile text is escaped', () => {
    assert(text(draw(null)).includes('Loading'));
    const empty = draw({ keys: keyData({ keys: [] }), guests: guestData({ links: [] }), joins: joinData({ links: [] }) });
    const t = text(empty);
    assert(t.includes('No API keys yet.') && t.includes('No guest links yet.') && t.includes('No raid join links yet. Make one from a raid.'));
    assert(empty.includes('data-action="lk-key-new"') && empty.includes('data-action="lk-guest-new"'), 'the New buttons stay');
    assert(!/<table/.test(empty), 'no empty table');
    assert.equal(count(empty, /class="gs-fg-ghn">0</g), 3);
    const n = draw(DATA(), { notice: 'Turned off Loot sheet.', alert: 'It went wrong.' });
    assert(/<div class="gs-notice" role="status"><span>Turned off Loot sheet\.<\/span><\/div>/.test(n) && /<p class="gs-alert" role="alert" id="gs-page-alert">It went wrong\.<\/p>/.test(n));
    const hostile = draw({
      keys: keyData({ keys: [key('ak_x', { name: HOSTILE + QUOTES, team: { id: 't1', name: HOSTILE + QUOTES }, createdBy: person(HOSTILE + QUOTES) })] }),
      guests: guestData({ links: [link('gl_x', { label: HOSTILE + QUOTES, role: { id: 'guest', name: HOSTILE + QUOTES }, team: { id: 't1', name: HOSTILE + QUOTES } })] }),
      joins: joinData({ links: [join('jl_x', { raid: { raidOn: '2026-10-30', startsAt: at(11, 1), zone: HOSTILE + QUOTES, title: null, teamName: HOSTILE + QUOTES } })] }),
    }, { notice: HOSTILE + QUOTES, alert: HOSTILE + QUOTES });
    assertEscaped(hostile, 'page'); assertNoRawAttrs(hostile);
    assert(!/rsk_|token|hash/i.test(draw()), 'no token word in the page');
  });

  await check('phone: slim rows on the Roster\'s phone list - line 1 the name and its chip, line 2 what it opens, used and ends (turned off says when), Turn off in the row', () => {
    const out = draw();
    assert.equal(count(out, /class="gs-rs-phone"><section class="gs-hd-panel gs-rs-plist"/g), 3);
    assert.equal(count(out, /class="gs-rs-desk"><div class="gs-table-wrap gs-hd-panel">/g), 3);
    const keys = phoneRows(group(out, 'API keys'));
    assert.equal(keys.length, 3);
    assert(keys[0].includes('<span class="gs-lk-l1row"><span class="gs-rs-name">Loot sheet</span></span><span class="gs-rs-sub">Whole guild, Loot, Roster' + DOT + '212 uses' + DOT + 'last Oct 27' + DOT + 'ends Jan 24, 2027</span>'), keys[0]);
    assert(keys[0].includes('Whole guild, Loot, Roster' + DOT + '212 uses' + DOT + 'last Oct 27' + DOT + 'ends Jan 24, 2027'));
    assert(keys[1].includes('Team KJ, Attendance, Roster' + DOT + '40 uses' + DOT + 'last Oct 25' + DOT + 'never ends'));
    assert(keys[2].includes('<span class="gs-rs-name">Old sheet</span><span class="gs-hd-chip is-grey">Turned off</span>') && keys[2].includes(DOT + 'turned off Sep 1'));
    const guests = phoneRows(group(out, 'Guest links'));
    assert(guests[1].includes('Guest, Team KJ only, Raids' + DOT + 'Never opened' + DOT + 'ends Nov 10'));
    assert(guests[2].includes('Expired') && guests[2].includes(DOT + 'ended Oct 16'));
    const joins = phoneRows(group(out, 'Raid join links'));
    assert(joins[0].includes('Guest sign-up, Team KJ' + DOT + '2 of 5 sign-ups' + DOT + 'ends Oct 30 8:00 PM ET'));
    assert(joins[1].includes('<span class="gs-hd-chip is-grey">Full</span>') && joins[1].includes('10 of 10 sign-ups' + DOT + 'ends Nov 1 7:00 PM ET'));
    for (const row of keys.slice(0, 2).concat(guests.slice(0, 2), joins.slice(0, 1))) assert(/<button type="button" class="gs-btn gs-btn-ghost"[^>]*>Turn off<\/button><\/div>$/.test(row) || /<button type="button" class="gs-btn gs-btn-ghost"[^>]*>Turn off<\/button>/.test(row), 'Turn off in the row');
    assert(!phoneRows(group(out, 'Raid join links'))[1].includes('Turn off'), 'a full link has none');
  });

  await check('CSS: every class the page draws has a rule in the Links and keys block (and the old Guest links rules stay for the Phase 7 sweep); the block keeps the 600 px media string out; phone targets are 44 px', () => {
    const css = read('guild.css');
    const a = css.indexOf('/* == B8a Links and keys (lane links) == */'), b = css.indexOf('/* == end B8a Links and keys == */');
    assert(a > 0 && b > a);
    const block = css.slice(a, b);
    assert(!block.includes('@media (max-width: 600px)'), 'guild-framework-ui-tests finds the phone block by that exact string');
    const src = read('js/guild/pages-settings-links.js');
    const used = new Set();
    for (const m of src.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/^gs-lk-[a-z0-9-]+$/.test(c)) used.add(c);
    for (const m of src.matchAll(/'(gs-lk-[a-z0-9-]+)'/g)) used.add(m[1]);
    assert(used.size >= 7, [...used].join(','));
    for (const c of used) assert(block.includes('.' + c), c + ' has no rule');
    assert(block.includes('.gs-table-links') && /\.gs-lk-row \.gs-btn \{[^}]*min-height: 44px/.test(block), 'Turn off is a 44 px target in a phone row');
    assert(block.includes('@media (width < 1200px) { .gs-lk-group .gs-rs-desk { display: none; } .gs-lk-group .gs-rs-phone { display: block; } }'), 'the table gives way to the phone list rows below 1200 px, where the detail column is too narrow for five columns');
    assert(/\.gs-rs-desk[^{]*\{ display: none/.test(css) && /\.gs-rs-phone \{ display: block; \}/.test(css), 'and the Roster\'s own swap at 600 px still covers the rest');
    for (const cls of ['gs-hd-chip', 'gs-fg-gh', 'gs-fg-ghn', 'gs-rs-plist', 'gs-rs-row', 'gs-rs-sub', 'gs-rs-name', 'gs-table-wrap', 'gs-sort']) assert(css.includes('.' + cls) || read('planner-forge.css').includes('.' + cls), cls);
    assert(css.includes('.gs-table-guests'), 'the Phase 7 sweep still reads the old table rules');
    const file = read('js/guild/pages-settings-links.js');
    assert(!/[^\x00-\x7f]/.test(file.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')), 'no non-ASCII outside comments');
    assert(!/[\s`'"]style\s*=\s*(?:["'`\\]|\$\{)/.test(file) && !/[\s`'"]on[a-z]{3,}\s*=\s*(?:["'`\\]|\$\{)/i.test(file), 'no inline style or handler');
    assert(file.includes('G.ui.guildZone()'), 'times are written in the guild zone');
  });

  // =========================================================================
  // the dialogs

  const options = (html, id) => [...html.match(new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>'))[1].matchAll(/<option value="([^"]*)"( selected)?[^>]*>([^<]*)</g)].map((m) => [m[1], !!m[2], m[3]]);

  await check('key dialogs: the form (name, team, what it reads - a dataset members cannot see is disabled -, expiry, the hourly limit), the one-time key with its links, the turn-off question', () => {
    const form = L.keyCreateDialogHtml(keyData(), guildData());
    assert(form.includes('data-submit="lk-key-form"') && form.includes('id="dlg-title">New API key<') && form.includes('name="name"') && form.includes('maxlength="40"'));
    assert(/<option value="" selected>Whole guild<\/option>/.test(form) && form.includes('>Team KJ<') && form.includes('>Sunday Alts<') && !form.includes('>Old<'), 'active teams only');
    assert(/<input type="checkbox" id="dlg-key-ds-0" name="datasets" value="roster" checked/.test(form));
    assert(/name="datasets" value="loot" disabled/.test(form) && text(form).includes('Members cannot see this in your guild, so a key cannot read it.'));
    assert.deepEqual(options(form, 'dlg-key-expiry'), [['30d', false, '30 days'], ['90d', true, '90 days'], ['365d', false, '365 days'], ['never', false, 'Never']]);
    assert(form.includes('data-action="dialog-cancel"') && form.includes('>Make key<') && form.includes('id="dlg-error"'));
    assert(/for="dlg-key-name"/.test(form) && /for="dlg-key-team"/.test(form) && /for="dlg-key-expiry"/.test(form));
    for (const f of ['name', 'teamId', 'datasets', 'expiresIn']) assert(form.includes('id="dlg-err-' + f + '"'), f);
    assert(text(form).includes('An API key opens read-only links') && text(form).includes('Each key can be used 60 times an hour.'), 'the hourly limit moved from the page into the dialog');
    assert(!text(L.keyCreateDialogHtml(keyData({ limits: {} }), null)).includes('times an hour'));
    const fallback = L.keyCreateDialogHtml({ datasets: [] }, null);
    assert(fallback.includes('value="never"') && fallback.includes('value="90d" selected'), 'the usual expiries when the Worker sends none');
    const TOKEN = 'rsk_' + 'A'.repeat(20) + '-_' + 'b'.repeat(21);
    const done = L.keyCreatedDialogHtml('https://raidsmith.test', TOKEN, ['roster', 'loot']);
    assert(done.includes('id="dlg-title">API key made<') && done.includes('id="key-token"') && done.includes('readonly') && done.includes('value="' + TOKEN + '"'));
    assert(done.includes('value="https://raidsmith.test/api/v1/roster.csv?key=' + TOKEN + '"') && done.includes('value="https://raidsmith.test/api/v1/loot.csv?key=' + TOKEN + '"'));
    assert(text(done).includes('Copy it now. It is shown only once.') && text(done).includes('IMPORTDATA') && text(done).includes('Authorization: Bearer') && text(done).includes('/api/v1/roster.json'));
    assert(!done.includes('roster.json?key='), 'a JSON address never carries the key');
    assert(done.includes('data-action="lk-key-copy"') && done.includes('data-target="key-csv-0"') && /id="key-copy-status" role="status"/.test(done) && !/<form/.test(done));
    assert.deepEqual(plain(L.keyLinksFor('https://x.test', TOKEN, ['raids'])), [{ id: 'raids', label: 'Raids', csv: 'https://x.test/api/v1/raids.csv?key=' + TOKEN, json: 'https://x.test/api/v1/raids.json' }]);
    const off = L.keyRevokeDialogHtml(keyData().keys[0]);
    assert(off.includes('data-submit="lk-key-off-form"') && off.includes('data-key-id="ak_1"') && text(off).includes('Turn off this key?') && text(off).includes('Loot sheet') && off.includes('gs-btn-danger') && text(off).includes('Keep it on'));
    assert(off.includes('gs-forge'), 'the danger button needs the Forge scope');
    for (const html of [form, done, off]) assertNoRawAttrs(html);
    assertEscaped(L.keyRevokeDialogHtml(key('ak_x', { name: HOSTILE + QUOTES })), 'key revoke dialog');
    assertEscaped(L.keyCreateDialogHtml(keyData({ datasets: [{ id: 'roster', label: HOSTILE + QUOTES, available: true }] }), guildData(null, { teams: [{ id: 't1', name: HOSTILE + QUOTES, archived: false }] })), 'key create dialog');
  });

  await check('guest dialogs: the form (a role that says what it shows, Whole guild or an active team, how long, an optional label of 40), the one-time address, the turn-off question', () => {
    const out = L.guestCreateDialogHtml(guestData(), guildData());
    assert.deepEqual(options(out, 'dlg-guest-role'), [['guest', true, 'Guest - Shows: Roster, Raids, Attendance'], ['cr_loot', false, 'Loot council - Shows: Loot'], ['cr_none', false, 'Nothing yet - Shows: nothing yet']]);
    assert.deepEqual(options(out, 'dlg-guest-team'), [['', true, 'Whole guild'], ['t1', false, 'Team KJ'], ['t2', false, 'Sunday Alts']], 'active teams only');
    assert.deepEqual(options(out, 'dlg-guest-expiry'), [['1d', false, '1 day'], ['7d', true, '7 days'], ['30d', false, '30 days'], ['never', false, 'Never']]);
    assert(out.includes('name="label"') && out.includes('maxlength="40"') && /<label[^>]*for="dlg-guest-label"/.test(out));
    for (const f of ['roleId', 'teamId', 'expiresIn', 'label']) assert(out.includes('id="dlg-err-' + f + '"') && out.includes('data-field="' + f + '"'), f);
    assert(out.includes('data-submit="lk-guest-form"') && out.includes('id="dlg-error"') && out.includes('>Make link<') && out.includes('data-action="dialog-cancel"') && text(out).includes('shown once'));
    const fallback = L.guestCreateDialogHtml({ roles: [{ id: 'guest', name: 'Guest', sections: [] }] }, null);
    assert(fallback.includes('value="never"') && fallback.includes('value="7d" selected'), 'the usual expiries when the Worker sends none');
    const TOKEN = 'A'.repeat(20) + '-_' + 'b'.repeat(21);
    const url = 'https://raidsmith.test/#/guest/' + TOKEN;
    const done = L.guestCreatedDialogHtml(url);
    assert(done.includes('<input class="gs-input gs-code" type="text" id="guest-url" readonly') && done.includes('value="' + url + '"'));
    assert(text(done).includes('Copy it now. It is shown only once.') && done.includes('id="dlg-title">Guest link made<') && done.includes('data-action="lk-guest-copy"') && done.includes('>Copy link<'));
    assert(/<label[^>]*for="guest-url"/.test(done) && /id="guest-copy-status" role="status"/.test(done) && !/<form/.test(done));
    const off = L.guestRevokeDialogHtml(link('gl_1'));
    assert(off.includes('data-submit="lk-guest-off-form"') && off.includes('data-link="gl_1"') && text(off).includes('Turn off this guest link?') && text(off).includes('Recruits') && off.includes('gs-btn-danger') && off.includes('gs-forge'));
    assert(text(L.guestRevokeDialogHtml(link('gl_2', { label: null }))).includes('Untitled'));
    assertEscaped(L.guestCreateDialogHtml(guestData({ roles: [{ id: 'guest', name: HOSTILE + QUOTES, sections: ['roster'] }] }), guildData(null, { teams: [{ id: 't1', name: HOSTILE + QUOTES, archived: false }] })), 'guest create dialog');
    assertEscaped(L.guestRevokeDialogHtml(link('gl_x', { label: HOSTILE + QUOTES })), 'guest revoke dialog');
    assertEscaped(L.guestCreatedDialogHtml('https://x/"><img src=x onerror=1>' + QUOTES), 'guest created dialog');
    for (const html of [out, done, off]) assertNoRawAttrs(html);
  });

  await check('join dialog: a confirm that names the raid, says what the visitor sees and what stays (the sign-ups made through it), never who made it; Cancel is focused, Turn off is the danger button', () => {
    const dlg = L.joinRevokeDialogHtml(join('jl_1'));
    const t = text(dlg);
    assert(t.includes('Turn off this sign-up link?'));
    assert(t.includes("Anyone who opens the link for Gruul's Lair sees that it no longer works. The 2 guests who already signed up stay on the raid. It cannot be turned back on: make a new link on the raid instead."), t);
    assert(!t.includes('Cinderlow'), 'never who made it');
    assert(dlg.includes('data-submit="lk-join-off-form"') && dlg.includes('data-join-id="jl_1"') && dlg.includes('gs-btn-danger') && dlg.includes('gs-forge') && dlg.includes('gs-dialog-confirm'));
    assert(/data-action="dialog-cancel"[^>]*autofocus|autofocus[^>]*data-action="dialog-cancel"/.test(dlg), 'Cancel is focused');
    assert(text(L.joinRevokeDialogHtml(join('jl_1', { uses: 1 }))).includes('The guest who already signed up stays on the raid.'));
    assert(!text(L.joinRevokeDialogHtml(join('jl_1', { uses: 0 }))).includes('already signed up'), 'nobody signed up: nothing to say');
    assert(text(L.joinRevokeDialogHtml(join('jl_1', { raid: { zone: 'Karazhan', title: 'Kara night', startsAt: 1, teamName: 'X' } }))).includes('for Kara night sees'));
    assertEscaped(L.joinRevokeDialogHtml(join('jl_x', { raid: { zone: HOSTILE + QUOTES, startsAt: 1, teamName: 'X' } })), 'join dialog'); assertNoRawAttrs(dlg);
  });

  // =========================================================================
  // behaviour

  const keyForm = (name, teamId, expiresIn, checked) => formEl({}, { name: { value: name }, teamId: { value: teamId }, expiresIn: { value: expiresIn } },
    { 'input[name="datasets"]': ['roster', 'attendance', 'loot', 'raids'].map((id) => box(checked.includes(id), id)) });
  const guestForm = (roleId, teamId, expiresIn, label) => formEl({}, { roleId: { value: roleId }, teamId: { value: teamId }, expiresIn: { value: expiresIn }, label: { value: label } });
  const KEY_TOKEN = 'rsk_' + 'A'.repeat(20) + '-_' + 'b'.repeat(21);
  const GUEST_TOKEN = 'G'.repeat(20) + '-_' + 'h'.repeat(21);

  await check('load(): reads the three lists (by route or guild id) into state.linksSettings; a failed read fails the page', async () => {
    const reads = [];
    const answers = { '/api/guild/g1/api-keys': keyData(), '/api/guild/g1/guest-links': guestData(), '/api/guild/g1/join-links': joinData() };
    await withApi({ get: (url) => { reads.push(url); return okRes(answers[url]); } }, async () => { await L.load({ name: 'settings', gid: 'g1', tab: 'links' }); await L.load('g1'); });
    assert.deepEqual(plain(reads.slice(0, 3).sort()), ['/api/guild/g1/api-keys', '/api/guild/g1/guest-links', '/api/guild/g1/join-links']);
    assert.deepEqual(plain(G.app.state.linksSettings), { gid: 'g1', keys: plain(answers['/api/guild/g1/api-keys']), guests: plain(answers['/api/guild/g1/guest-links']), joins: plain(answers['/api/guild/g1/join-links']), notice: '' });
    G.app.state.linksSettings = null;
    await withApi({ get: (url) => (/join-links/.test(url) ? rejectWith(403, { error: 'forbidden', message: 'No.' }) : okRes(answers[url])) }, async () => {
      await assert.rejects(L.load('g1'), (e) => e.status === 403);
    });
    assert.equal(G.app.state.linksSettings, null, 'nothing half-loaded is kept');
  });

  await check('api client: the key, guest and join-link calls go to the routes the Worker has', async () => {
    const calls = [];
    await withApi({
      get: (url) => { calls.push(['get', url]); return okRes({}); },
      post: (url, body) => { calls.push(['post', url, plain(body)]); return okRes({}); },
      del: (url, body) => { calls.push(['del', url, plain(body)]); return okRes({}); },
    }, async () => {
      await G.api.dataKeys.list('g1'); await G.api.dataKeys.create('g1', { name: 'x' }); await G.api.dataKeys.revoke('g1', 'ak_1');
      await G.api.guests.list('g1'); await G.api.guests.create('g1', { roleId: 'guest' }); await G.api.guests.revoke('g1', 'gl_1');
      await G.api.joinLinks.guildList('g1'); await G.api.joinLinks.guildRevoke('g1', 'jl_1');
    });
    assert.deepEqual(calls, [['get', '/api/guild/g1/api-keys'], ['post', '/api/guild/g1/api-keys', { name: 'x' }], ['del', '/api/guild/g1/api-keys/ak_1', {}],
      ['get', '/api/guild/g1/guest-links'], ['post', '/api/guild/g1/guest-links', { roleId: 'guest' }], ['del', '/api/guild/g1/guest-links/gl_1', {}],
      ['get', '/api/guild/g1/join-links'], ['del', '/api/guild/g1/join-links/jl_1', {}]]);
  });

  await check('New API key: POSTs the choices, opens the one-time dialog with origin + key, keeps the token nowhere in the page state, says so; a refusal stays in the dialog', async () => {
    const s = seed({ keys: keyData({ keys: [] }) });
    clearFields();
    for (const id of ['dlg-err-name', 'dlg-err-teamId', 'dlg-err-datasets', 'dlg-err-expiresIn', 'dlg-error']) field(id);
    fields['key-token'] = { select() { fields['key-token'].selected = true; } };
    const sent = [];
    const savedOrigin = G.ui.pageOrigin;
    G.ui.pageOrigin = () => 'https://raidsmith.test';
    const after = keyData({ keys: [keyData().keys[0]] });
    await withApi({ post: (url, body) => { sent.push([url, plain(body)]); return okRes(Object.assign({}, after, { created: { id: 'ak_new', token: KEY_TOKEN } })); } }, async (probe) => {
      G.handlers.click['lk-key-new'](el());
      assert.equal(probe.opened.length, 1);
      assert(probe.opened[0].html.includes('data-submit="lk-key-form"') && probe.opened[0].html.includes('Team KJ'));
      G.handlers.submit['lk-key-form'](keyForm('  Loot sheet  ', 't1', '30d', ['roster', 'raids']));
      await settle();
      assert.deepEqual(sent, [['/api/guild/g1/api-keys', { name: 'Loot sheet', teamId: 't1', datasets: ['roster', 'raids'], expiresIn: '30d' }]]);
      assert.equal(probe.opened.length, 2);
      assert(probe.opened[1].html.includes('value="' + KEY_TOKEN + '"') && probe.opened[1].html.includes('https://raidsmith.test/api/v1/roster.csv?key=' + KEY_TOKEN));
      assert(probe.opened[1].html.includes('/api/v1/raids.csv') && !probe.opened[1].html.includes('/api/v1/loot.csv'), 'a link for each dataset the key reads');
      assert.equal(fields['key-token'].selected, true, 'the key is selected for Ctrl+C');
      assert.equal(s.linksSettings.notice, 'API key made.');
      assert.deepEqual(plain(s.linksSettings.keys), plain(after));
      assert.equal(s.linksSettings.guests.links.length, 3, 'the other two lists are as they were');
      assert(!JSON.stringify(plain(s.linksSettings)).includes(KEY_TOKEN) && !JSON.stringify(plain(s.pageAlert)).includes(KEY_TOKEN), 'the token is not kept');
      sent.length = 0;
      G.handlers.submit['lk-key-form'](keyForm('Everything', '', 'never', ['roster']));
      await settle();
      assert.deepEqual(sent[0][1], { name: 'Everything', teamId: null, datasets: ['roster'], expiresIn: 'never' }, 'Whole guild is null');
    });
    clearFields();
    for (const id of ['dlg-err-name', 'dlg-err-teamId', 'dlg-err-datasets', 'dlg-err-expiresIn', 'dlg-error']) field(id);
    await withApi({ post: () => rejectWith(400, { error: 'bad_request', message: 'Pick what the key reads: roster.', field: 'datasets' }) }, async (probe) => {
      const form = keyForm('x', '', '30d', []);
      form.querySelector = (q) => (q === '#dlg-err-datasets' ? {} : (q === '[data-field="datasets"]' ? { setAttribute() {}, focus() {} } : null));
      G.handlers.submit['lk-key-form'](form);
      await settle();
      assert.equal(probe.opened.length, 0);
      assert.equal(fields['dlg-err-datasets'].textContent, 'Pick what the key reads: roster.');
    });
    G.ui.pageOrigin = savedOrigin;
    s.linksSettings = null; clearFields();
  });

  await check('New guest link: POSTs the choices (no label key when empty), opens a dialog with origin + path, keeps the token nowhere; the role problem and the cap show at the role field', async () => {
    const s = seed({ guests: guestData({ links: [] }) });
    clearFields();
    for (const id of ['dlg-err-roleId', 'dlg-err-teamId', 'dlg-err-expiresIn', 'dlg-err-label', 'dlg-error']) field(id);
    const after = guestData({ links: [link('gl_new')] });
    const sent = [];
    const savedOrigin = G.ui.pageOrigin;
    G.ui.pageOrigin = () => 'https://raidsmith.test';
    fields['guest-url'] = { select() { fields['guest-url'].selected = true; } };
    await withApi({ post: (url, body) => { sent.push([url, plain(body)]); return okRes(Object.assign({}, after, { created: { id: 'gl_new', token: GUEST_TOKEN, path: '/#/guest/' + GUEST_TOKEN } })); } }, async (probe) => {
      G.handlers.click['lk-guest-new'](el());
      assert(probe.opened[0].html.includes('data-submit="lk-guest-form"') && probe.opened[0].html.includes('Team KJ'));
      G.handlers.submit['lk-guest-form'](guestForm('guest', 't1', '30d', '  Recruits  '));
      await settle();
      assert.deepEqual(sent, [['/api/guild/g1/guest-links', { roleId: 'guest', teamId: 't1', expiresIn: '30d', label: 'Recruits' }]]);
      assert.equal(probe.opened.length, 2);
      assert(probe.opened[1].html.includes('value="https://raidsmith.test/#/guest/' + GUEST_TOKEN + '"') && probe.opened[1].html.includes('shown only once'));
      assert.equal(fields['guest-url'].selected, true, 'the address is selected for Ctrl+C');
      assert.equal(s.linksSettings.notice, 'Guest link made.');
      assert.deepEqual(plain(s.linksSettings.guests), plain(after));
      assert(!JSON.stringify(plain(s.linksSettings)).includes(GUEST_TOKEN) && !JSON.stringify(plain(s.pageAlert)).includes(GUEST_TOKEN), 'the token is not kept');
      sent.length = 0;
      G.handlers.submit['lk-guest-form'](guestForm('cr_loot', '', 'never', '   '));
      await settle();
      assert.deepEqual(sent, [['/api/guild/g1/guest-links', { roleId: 'cr_loot', teamId: null, expiresIn: 'never' }]]);
    });
    G.ui.pageOrigin = savedOrigin;
    const run = async (status, body) => {
      clearFields();
      for (const id of ['dlg-err-roleId', 'dlg-err-expiresIn', 'dlg-error']) field(id);
      const form = guestForm('guest', '', '7d', '');
      form.querySelector = (q) => (q === '#dlg-err-roleId' ? {} : (q === '[data-field="roleId"]' ? { setAttribute() {}, focus() {} } : null));
      await withApi({ post: () => rejectWith(status, body) }, async () => { G.handlers.submit['lk-guest-form'](form); await settle(); });
    };
    await run(400, { error: 'bad_request', message: 'That role can see nothing a guest link shows.', field: 'roleId' });
    assert.equal(fields['dlg-err-roleId'].textContent, 'That role can see nothing a guest link shows.');
    await run(400, { error: 'bad_request', message: 'A guild can have at most 50 guest links that still work. Turn some off first.', field: 'roleId' });
    assert(fields['dlg-err-roleId'].textContent.includes('at most 50 guest links'));
    await run(429, { error: 'rate_limited', message: 'Too many.', retryAfter: 30 });
    assert(fields['dlg-error'].textContent.includes('Too many'));
    s.linksSettings = null; clearFields();
  });

  await check('Turn off a key or a guest link: the question opens for a working one only, nothing is sent before the confirm, then the right DELETE runs and the page shows the list the Worker sent', async () => {
    const s = seed();
    const afterKeys = keyData({ keys: keyData().keys.map((k) => (k.id === 'ak_1' ? Object.assign({}, k, { status: 'revoked', revokedAt: NOW }) : k)) });
    const afterGuests = guestData({ links: guestData().links.map((l) => (l.id === 'gl_1' ? Object.assign({}, l, { status: 'revoked', revokedAt: NOW }) : l)) });
    const sent = [];
    await withApi({ del: (url) => { sent.push(url); return okRes(/api-keys/.test(url) ? afterKeys : afterGuests); } }, async (probe) => {
      G.handlers.click['lk-key-off'](el({ 'data-key-id': 'ak_3' }));
      G.handlers.click['lk-key-off'](el({ 'data-key-id': 'nope' }));
      assert.equal(probe.opened.length, 0, 'a key that is already off, and one that does not exist');
      G.handlers.click['lk-key-off'](el({ 'data-key-id': 'ak_1' }));
      assert.equal(probe.opened.length, 1);
      assert(probe.opened[0].html.includes('data-key-id="ak_1"') && probe.opened[0].html.includes('Turn off this key?'));
      assert.deepEqual(sent, [], 'nothing is sent before the confirm');
      const renders = probe.renders();
      G.handlers.submit['lk-key-off-form'](formEl({ 'data-key-id': 'ak_1' }));
      await settle();
      assert.deepEqual(sent, ['/api/guild/g1/api-keys/ak_1']);
      assert.equal(s.linksSettings.notice, 'Turned off Loot sheet.');
      assert.equal(s.linksSettings.keys, afterKeys);
      assert.equal(s.linksSettings.guests.links[0].status, 'active', 'the other kinds are untouched');
      assert(probe.renders() > renders, 'the page redraws');
      G.handlers.click['lk-guest-off'](el({ 'data-link': 'gl_3' }));
      G.handlers.click['lk-guest-off'](el({ 'data-link': 'nope' }));
      assert.equal(probe.opened.length, 1, 'an expired link has nothing to turn off');
      G.handlers.click['lk-guest-off'](el({ 'data-link': 'gl_1' }));
      assert.equal(probe.opened.length, 2);
      assert(probe.opened[1].html.includes('data-link="gl_1"') && probe.opened[1].html.includes('Turn off this guest link?'));
      G.handlers.submit['lk-guest-off-form'](formEl({ 'data-link': 'gl_1' }));
      await settle();
      assert.deepEqual(sent, ['/api/guild/g1/api-keys/ak_1', '/api/guild/g1/guest-links/gl_1']);
      assert.equal(s.linksSettings.notice, 'Turned off Recruits.');
      assert.equal(s.linksSettings.guests, afterGuests);
      const out = L.settingsHtml({ guildData: guildData(), data: s.linksSettings, notice: s.linksSettings.notice, now: NOW });
      assert(deskRows(group(out, 'API keys'))[0].includes('Turned off') && !deskRows(group(out, 'API keys'))[0].includes('>Turn off</button>'));
    });
    s.linksSettings = null;
  });

  await check('Turn off a raid join link: any account\'s link (the list is the guild\'s), a confirm that names the raid, then DELETE /join-links/:jid and the guild\'s list the Worker sent; a full or turned-off one has no question', async () => {
    const s = seed();
    const after = joinData({ links: joinData().links.map((l) => (l.id === 'jl_1' ? Object.assign({}, l, { status: 'revoked' }) : l)) });
    const sent = [];
    await withApi({ del: (url) => { sent.push(url); return okRes(after); } }, async (probe) => {
      G.handlers.click['lk-join-off'](el({ 'data-join-id': 'jl_2' }));
      G.handlers.click['lk-join-off'](el({ 'data-join-id': 'nope' }));
      assert.equal(probe.opened.length, 0, 'a full link, and one that does not exist');
      assert.equal(s.linksSettings.joins.links[0].createdBy.displayName, 'Cinderlow', 'the viewer did not make it');
      G.handlers.click['lk-join-off'](el({ 'data-join-id': 'jl_1' }));
      assert.equal(probe.opened.length, 1);
      assert(probe.opened[0].html.includes('data-join-id="jl_1"') && text(probe.opened[0].html).includes("Gruul's Lair"));
      assert.deepEqual(sent, [], 'nothing is sent before the confirm');
      G.handlers.submit['lk-join-off-form'](formEl({ 'data-join-id': 'jl_1' }));
      await settle();
      assert.deepEqual(sent, ['/api/guild/g1/join-links/jl_1'], 'the guild route, not the raid\'s');
      assert.equal(s.linksSettings.notice, "Turned off the sign-up link for Gruul's Lair.");
      assert.equal(s.linksSettings.joins, after);
      assert.equal(s.linksSettings.keys.keys.length, 3);
    });
    // A refusal stays in the dialog (a link another officer already turned off answers the same list: nothing to show).
    clearFields(); field('dlg-error');
    await withApi({ del: () => rejectWith(404, { error: 'not_found', message: 'That sign-up link does not exist.' }) }, async (probe) => {
      const before = s.linksSettings.joins;
      G.handlers.submit['lk-join-off-form'](formEl({ 'data-join-id': 'jl_1' }));
      await settle();
      assert.equal(fields['dlg-error'].textContent, 'That sign-up link does not exist.');
      assert.equal(s.linksSettings.joins, before, 'nothing changes');
    });
    // An answer that arrives after the viewer moved to another guild is dropped.
    const kept = s.linksSettings.joins;
    let release;
    await withApi({ del: () => new Promise((resolve) => { release = () => resolve(joinData({ links: [] })); }) }, async () => {
      G.handlers.submit['lk-join-off-form'](formEl({ 'data-join-id': 'jl_1' }));
      s.linksSettings = Object.assign({}, s.linksSettings, { gid: 'g2' });
      release();
      await settle();
    });
    assert.equal(s.linksSettings.joins, kept, 'the other guild page is not overwritten');
    s.linksSettings = null; clearFields();
  });

  await check('copy: Copy key / Copy link copy with the clipboard where there is one, else select the text; the status says which', async () => {
    clearFields();
    const written = [];
    const input = { value: 'https://raidsmith.test/#/guest/' + GUEST_TOKEN, selected: 0, focused: 0, select() { this.selected++; }, focus() { this.focused++; } };
    fields['guest-url'] = input; fields['key-token'] = input;
    field('guest-copy-status'); field('key-copy-status');
    sandbox.navigator = { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } };
    G.handlers.click['lk-guest-copy'](el());
    G.handlers.click['lk-key-copy'](el({ 'data-target': 'key-token' }));
    await settle();
    assert.deepEqual(written, [input.value, input.value]);
    assert.equal(fields['guest-copy-status'].textContent, 'Copied.'); assert.equal(fields['key-copy-status'].textContent, 'Copied.');
    delete sandbox.navigator;
    sandbox.document.execCommand = () => false;
    G.handlers.click['lk-guest-copy'](el());
    G.handlers.click['lk-key-copy'](el({ 'data-target': 'key-token' }));
    await settle();
    assert.equal(fields['guest-copy-status'].textContent, 'Press Ctrl+C to copy the selected link.');
    assert.equal(fields['key-copy-status'].textContent, 'Press Ctrl+C to copy the selected text.');
    delete sandbox.document.execCommand;
    clearFields();
  });

  await check('handlers do nothing without a loaded page (state missing or still loading)', async () => {
    G.app.state.linksSettings = null;
    await withApi({ post: () => { throw new Error('no call expected'); }, del: () => { throw new Error('no call expected'); } }, async (probe) => {
      for (const [kind, name, attrs] of [['click', 'lk-key-new'], ['click', 'lk-guest-new'], ['click', 'lk-key-off', { 'data-key-id': 'ak_1' }], ['click', 'lk-guest-off', { 'data-link': 'gl_1' }], ['click', 'lk-join-off', { 'data-join-id': 'jl_1' }]]) G.handlers[kind][name](el(attrs));
      for (const name of ['lk-key-form', 'lk-guest-form', 'lk-key-off-form', 'lk-guest-off-form', 'lk-join-off-form']) G.handlers.submit[name](formEl({}, {}));
      await settle();
      assert.equal(probe.opened.length, 0);
    });
  });

  // =========================================================================
  // through app.js: the fake page skeleton, location, history and fetch

  class FakeEl {
    constructor(id) { this.id = id || ''; this.attrs = {}; this.hidden = false; this._html = ''; this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} }; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {}
    closest() { return null; }
  }
  const SKELETON = ['guild-root', 'shell-rail', 'shell-sidebar', 'shell-topbar-lead', 'shell-topbar-plan', 'shell-topbar-account', 'shell-banner', 'gs-main', 'planner-root', 'planner-banner', 'planner-notice', 'shell-tabs', 'shell-drawer', 'guild-dialogs'];
  function makeEnv({ url, routes }) {
    const els = {};
    SKELETON.forEach((id) => { els[id] = new FakeEl(id); });
    els['planner-root']._html = '<main>PLANNER</main>';
    const body = new FakeEl('');
    body.attrs['data-page'] = 'app';
    const loc = { pathname: '/', search: '', _hash: url.slice(url.indexOf('#')) };
    const listeners = {};
    Object.defineProperty(loc, 'hash', { get: () => loc._hash, set: (v) => { loc._hash = v.charAt(0) === '#' ? v : '#' + v; (listeners.hashchange || []).forEach((fn) => fn({})); } });
    Object.defineProperty(loc, 'href', { get: () => 'http://localhost' + loc.pathname + loc.search + loc._hash });
    const history = { pushState: (st, t, u) => { loc._hash = u.slice(u.indexOf('#')); }, replaceState: (st, t, u) => { loc._hash = u.slice(u.indexOf('#')); } };
    const fetchCalls = [];
    const fetchFn = (u, init) => {
      fetchCalls.push({ url: u, method: (init && init.method) || 'GET' });
      const r = routes[u];
      if (!r) return Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve('{}') });
      return Promise.resolve({ ok: r.status < 300, status: r.status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(r.body == null ? {} : r.body)) });
    };
    const box2 = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, URL };
    box2.window = box2;
    box2.document = { body, activeElement: null, title: 'Raidsmith', getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener: (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); } };
    box2.location = loc; box2.history = history;
    const mem = (initial) => { const m = Object.assign({}, initial); return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; };
    box2.localStorage = mem({ 'raidsmith.shell.signedIn': '1' }); box2.sessionStorage = mem({});
    box2.fetch = fetchFn; box2.addEventListener = (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); };
    box2.setTimeout = () => 1; box2.clearTimeout = () => {}; box2.scrollTo = () => {}; box2.whatsNewSeen = () => true;
    vm.createContext(box2);
    for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), box2, { filename: src });
    return { G: box2.Guild, loc, fetchCalls, html: (id) => els[id].innerHTML };
  }
  const ME = { user: { id: 'u1', username: 'alice', displayName: 'Alice', avatarUrl: null, initials: 'AL', prefs: { sidebarCollapsed: false, lastGuildId: null } }, guilds: [{ id: 'g1', name: 'Vindicated' }], create: { allowed: false }, removedFrom: [], deleteImpact: { handOverFirst: [] } };
  const guildBody = (can) => ({ guild: { id: 'g1', name: 'Vindicated', realm: 'Dreamscythe', realmKind: 'realm', gameVersion: 'tbc', region: 'US', timeZone: 'America/New_York' }, teams: TEAMS.map((t) => Object.assign({ lead: null }, t)), me: { roles: [{ role: 'officer' }], can } });
  const routes = (can) => ({
    '/auth/me': { status: 200, body: ME }, '/api/guild/g1': { status: 200, body: guildBody(can) }, '/auth/bnet': { status: 200, body: { configured: true, link: null, guilds: [] } },
    '/api/guild/g1/api-keys': { status: 200, body: keyData() }, '/api/guild/g1/guest-links': { status: 200, body: guestData() }, '/api/guild/g1/join-links': { status: 200, body: joinData() },
  });
  const mainOf = async (env) => { await settle(); return env.html('gs-main'); };

  await check('app: Links and keys, and the two old addresses, read the three lists and draw the three groups inside the settings frame; the page is for guild.access', async () => {
    for (const tab of ['links', 'guests', 'dataaccess']) {
      const env = makeEnv({ url: '/#/g/g1/settings/' + tab, routes: routes({ 'guild.access': 'guild' }) });
      const main = await mainOf(env);
      assert(/<h2[^>]*id="settings-title"[^>]*>Links and keys<\/h2>/.test(main) && main.includes('aria-current="page"') && main.includes('href="#/g/g1/settings/links"'), tab + ': ' + text(main).slice(0, 200));
      assert.deepEqual(['API keys', 'Guest links', 'Raid join links'].map((t) => main.includes('<span class="gs-fg-ght">' + t + '</span>')), [true, true, true], tab);
      for (const read of ['/api/guild/g1/api-keys', '/api/guild/g1/guest-links', '/api/guild/g1/join-links']) assert.equal(env.fetchCalls.filter((c) => c.url === read).length, 1, tab + ' ' + read);
      assert(!/settings\/(guests|dataaccess)/.test(main) && !text(main).includes('Data access'), 'the list of pages has no retired page');
      assert.equal(env.G.app.state.linksSettings.gid, 'g1');
      assert.equal(env.G.app.state.linksSettings.notice, '');
    }
    const denied = makeEnv({ url: '/#/g/g1/settings/links', routes: routes({ 'guild.roles': 'guild', 'roster.view': 'guild' }) });
    assert(text(await mainOf(denied)).includes('Your role does not include this part of Guild settings.'));
    assert.equal(denied.fetchCalls.filter((c) => /api-keys|guest-links|join-links/.test(c.url)).length, 0, 'nothing is read');
  });

  await check('app: signing out clears what Links and keys kept', async () => {
    const env = makeEnv({ url: '/#/g/g1/settings/links', routes: Object.assign(routes({ 'guild.access': 'guild' }), { 'POST /auth/logout': { status: 200, body: {} } }) });
    await settle();
    assert(env.G.app.state.linksSettings);
    env.G.app.state.linksSettings.keys = { keys: [], note: 'x' };
    const src = read('js/guild/app.js');
    const reset = src.slice(src.indexOf('state.rolesSettings = null;'), src.indexOf('state.rolesSettings = null;') + 400);
    assert(/state\.linksSettings = null;/.test(reset), 'resetSession clears it with the other settings pages');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
