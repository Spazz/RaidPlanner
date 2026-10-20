/**
 * Raidsmith guild UI, Phase 4 (loot) - tests for the Loot section, the Loot card of a raid and its Gargul import panel,
 * the person loot page and card, Settings > Loot, the review queue's loot winners, the loot routes and the shell pieces.
 * Run: node guild-loot-ui-tests.js
 *
 * Same approach as guild-attendance-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render
 * functions return HTML strings and the handlers run against a stubbed G.api. Mock API data follows the Phase 4 spec's
 * API contract (tasks/guild-phase4-spec.md, section 5). The Gargul parser has its own suite (guild-loot-parser-tests.js).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS, guildScriptsOf } = require('./tests/guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, '');
const tick = () => new Promise(r => setTimeout(r, 5));
const FIXTURE_TEXT = read('tests/fixtures/gargul-detailed-sample.json');

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

// ── fixtures ─────────────────────────────────────────────────────
const T1 = { id: 't1', name: 'Team KJ' };
const T2 = { id: 't2', name: 'Weekend team' };
const OFFICER_CAN = {
  'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild',
  'attendance.policy': 'guild', 'guild.teams': 'guild', 'roster.edit': 'guild', 'loot.view': 'guild', 'loot.edit': 'guild', 'loot.policy': 'guild',
};
const LEAD_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': ['t1'], 'attendance.view': ['t1'], 'attendance.review': ['t1'], 'loot.view': ['t1'], 'loot.edit': ['t1'] };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'loot.view': ['t1'] };
function gd(can, over) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [T1, T2].map(t => ({ id: t.id, name: t.name, size: 25, archived: false, players: 3, leads: [] })),
    me: { roles: [{ role: 'officer' }], can },
    attendanceFlags: {},
  }, over || {});
}

// An award view A of the contract.
function award(id, over) {
  return Object.assign({
    id, raidId: 'r1', raidOn: '2026-10-10', teamId: 't1', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: 1791681160000,
    winner: { name: 'Thoren', realm: 'Ashmere', class: 'PALADIN' },
    match: { kind: 'character', personId: 'p_th', personName: 'Thoren', characterId: 'c_th', characterName: 'Thoren', isMain: true },
    tag: 'MS', tagSetBy: null, flags: [], rollType: 'MS', note: null, awardedBy: 'Lootmaster-Ashmere',
  }, over || {});
}
const AWARDS = [
  award('a1', { flags: ['PL', 'TMB'] }),
  award('a2', { itemId: 30311, itemName: 'Warp Slicer', awardedAt: 1791681605000, winner: { name: 'Kaelith', realm: 'Ashmere', class: 'ROGUE' }, match: { kind: 'character', personId: 'p_kn', personName: 'Kaelith', characterName: 'Kaelith Alt', isMain: false }, flags: ['SR'] }),
  award('a3', { itemId: 28823, itemName: 'Eye of Gruul', awardedAt: 1791683512000, winner: { name: 'Dorrin', realm: 'Ashmere', class: 'PRIEST' }, match: { kind: 'guest' }, tag: 'OS', tagSetBy: 'officer', flags: ['OS'], rollType: 'OS', note: 'Rolled off-spec' }),
  award('a4', { itemId: 23572, itemName: 'Primal Nether', quality: 3, awardedAt: 1791683510000, winner: { name: 'Veyla', realm: null, class: 'MAGE' }, match: { kind: 'unmatched' } }),
];

const DETAIL = {
  raid: { id: 'r1', team: { id: 't1', name: 'Team KJ' }, raidOn: '2026-10-10', zone: 'BT', state: 'reviewed', openFlags: 0, stale: false, upcoming: false },
  can: { edit: true, review: true, seeAttendance: true, seeNicknames: false },
  sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [],
};
const okState = (over, canEdit) => Object.assign({ gid: 'g1', rid: 'r1', status: 'ok', data: { awards: AWARDS.map(a => Object.assign({}, a)), canEdit: canEdit !== false }, ui: G.pages.raidLoot.freshUi() }, over || {});
const raidPage = (state, can, over) => G.pages.raid.raidHtml(Object.assign({ guildData: gd(can || OFFICER_CAN), data: DETAIL, loot: state }, over || {}));

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert };
    S.att = {}; S.guilds = {}; S.pageAlert = '';
    try { await fn(S); } finally { Object.assign(S, saved); }
  };
}

// ── router and shell ─────────────────────────────────────────────
(async () => {
  await check('router: Loot views, the person loot page and Settings > Loot parse and format back; bad input is notfound', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/g/g1/loot'), { name: 'section', gid: 'g1', section: 'loot' });
    assert.deepEqual(p('#/g/g1/loot?view=raids'), { name: 'section', gid: 'g1', section: 'loot', legacyView: true }, 'an old view link opens the hub and says so');
    assert.deepEqual(p('#/g/g1/loot?view=items'), { name: 'section', gid: 'g1', section: 'loot', legacyView: true });
    assert.equal(G.router.format(p('#/g/g1/loot?view=raids')), '#/g/g1/loot', 'formatting drops the old parameter');
    assert.deepEqual(p('#/g/g1/loot/standings'), { name: 'lootstandings', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/loot/fix'), { name: 'lootfix', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/loot/n/r_1'), { name: 'lootnight', gid: 'g1', rid: 'r_1' });
    assert.deepEqual(p('#/g/g1/loot/i/28770'), { name: 'lootitem', gid: 'g1', itemId: '28770' });
    assert.deepEqual(p('#/g/g1/loot/a/lo_1'), { name: 'lootaward', gid: 'g1', aid: 'lo_1', edit: false });
    assert.deepEqual(p('#/g/g1/loot/a/lo_1?edit=1'), { name: 'lootaward', gid: 'g1', aid: 'lo_1', edit: true });
    assert.deepEqual(p('#/g/g1/loot?view=bogus'), { name: 'section', gid: 'g1', section: 'loot' });
    assert.deepEqual(p('#/g/g1/raids?view=items'), { name: 'section', gid: 'g1', section: 'raids' }, 'the view belongs to Loot');
    assert.deepEqual(p('#/g/g1/loot/p/p_1'), { name: 'lootperson', gid: 'g1', pid: 'p_1' });
    assert.deepEqual(p('#/g/g1/settings/loot'), { name: 'settings', gid: 'g1', tab: 'loot' });
    for (const bad of ['#/g/g1/loot/p', '#/g/g1/loot/p/a/b', '#/g/g1/loot/p/<x>', '#/g/g1/loot/x', '#/g/g1/loot/p/p_1/extra', '#/g/g1/loot/raids', '#/g/g1/loot/i/abc', '#/g/g1/loot/i/0', '#/g/g1/loot/n', '#/g/g1/loot/standings/x', '#/g/g1/settings/loots']) {
      assert.equal(p(bad).name, 'notfound', bad);
    }
    for (const r of [{ name: 'section', gid: 'g1', section: 'loot' }, { name: 'lootstandings', gid: 'g1' }, { name: 'lootfix', gid: 'g1' }, { name: 'lootnight', gid: 'g1', rid: 'r_1' }, { name: 'lootitem', gid: 'g1', itemId: '28770' }, { name: 'lootaward', gid: 'g1', aid: 'lo_1', edit: true }, { name: 'lootperson', gid: 'g1', pid: 'p_1' }, { name: 'settings', gid: 'g1', tab: 'loot' }]) {
      assert.deepEqual(p(G.router.format(r)), r);
    }
    assert.equal(G.router.format({ name: 'section', gid: 'g1', section: 'loot', view: 'balance' }), '#/g/g1/loot');
    assert.equal(G.router.format({ name: 'section', gid: 'g1', section: 'roster', view: 'items' }), '#/g/g1/roster');
  });

  await check('shell: the Loot settings tab needs loot.policy, and loot.policy alone opens Guild settings', () => {
    const allTabs = Object.assign({ 'guild.access': 'guild', 'guild.roles': 'guild' }, OFFICER_CAN);
    const shownTabs = plain(G.shell.settingsTabs(allTabs).map(t => t.tab));
    assert(shownTabs.includes('loot') && shownTabs.indexOf('attendance') < shownTabs.indexOf('loot'), 'Loot follows Attendance');
    assert.equal(G.shell.settingsTabs(allTabs).find(t => t.tab === 'loot').label, 'Loot');
    assert(!G.shell.settingsTabs({ 'guild.teams': 'guild', 'attendance.policy': 'guild' }).some(t => t.tab === 'loot'));
    assert.deepEqual(plain(G.shell.settingsTabs({ 'loot.policy': 'guild' }).map(t => t.tab)), ['loot']);
    assert.equal(G.shell.canSeeSettings({ 'loot.policy': 'guild' }), true);
    assert.equal(G.shell.canSeeSettings({ 'loot.edit': 'guild', 'loot.view': 'guild' }), false);
    const items = G.shell.navItems('g1', { 'loot.policy': 'guild' }, 0, '');
    assert(items.some(i => i.key === 'settings' && i.href === '#/g/g1/settings'), 'the item opens the bare address: the app picks the first page or the list');
  });

  await check('shell: the Loot nav item keeps its section for the person loot page; breadcrumbs and back link name the leaf', () => {
    const guild = gd(OFFICER_CAN);
    const ctxFor = (route, extra) => Object.assign({ section: 'guild', page: 'app', me: { user: { id: 'u1' }, guilds: [{ id: 'g1' }] }, route, guildData: guild, teamId: 't1' }, extra || {});
    const loot = items => items.find(i => i.key === 'loot');
    assert.equal(G.shell.navItems('g1', {}, 0, '').find(i => i.key === 'loot').href, '#/g/g1/loot');
    const slots = G.shell.slots(ctxFor({ name: 'lootperson', gid: 'g1', pid: 'p_1' }, { leafName: 'Thoren' }));
    assert(slots.sidebar.includes('aria-current="page"') && /href="#\/g\/g1\/loot"[^>]*aria-current="page"/.test(slots.sidebar), 'Loot is the current item');
    assert(/aria-label="Loot" aria-current="page"/.test(slots.tabs) || /<button type="button" class="gs-tab is-active" data-action="open-drawer"/.test(slots.tabs), 'and the phone tab: Loot for a member, More (which holds Loot) for an officer');
    const crumbs = G.shell.breadcrumbItems(ctxFor({ name: 'lootperson', gid: 'g1', pid: 'p_1' }, { leafName: 'Thoren' }));
    assert.deepEqual(plain(crumbs.map(c => c.label)), ['Ravens', 'Team KJ', 'Loot', 'Thoren']);
    assert.equal(crumbs[2].href, '#/g/g1/loot');
    assert.equal(G.shell.breadcrumbItems(ctxFor({ name: 'lootperson', gid: 'g1', pid: 'p_1' })).pop().label, 'Person');
    assert(slots.lead.includes('Back to Loot'), 'the phone back link');
    const settings = G.shell.breadcrumbItems(ctxFor({ name: 'settings', gid: 'g1', tab: 'loot' }));
    assert.deepEqual(plain(settings.map(c => c.label)), ['Ravens', 'Guild settings', 'Loot']);
    const frame = G.shell.settingsFrameHtml(ctxFor({ name: 'settings', gid: 'g1', tab: 'loot' }), 'loot', '<p>x</p>');
    assert(/href="#\/g\/g1\/settings\/loot" aria-current="page">Loot</.test(frame));
    assert.equal(loot(G.shell.navItems('g1', {}, 0, '')).badge === undefined || loot(G.shell.navItems('g1', {}, 0, '')).badge === 0, true, 'no badge on Loot');
  });

  await check('app: the loot routes map to their page modules; the coming-next page is gone', () => {
    const key = G.app.attPageKey;
    assert.equal(key({ name: 'section', section: 'loot' }), 'loot');
    assert.equal(key({ name: 'lootperson' }), 'personLoot');
    for (const [n, k] of [['lootstandings', 'lootStandings'], ['lootnight', 'lootNight'], ['lootitem', 'lootItem'], ['lootaward', 'lootAward'], ['lootfix', 'lootFix']]) {
      assert.equal(key({ name: n }), k, n);
      assert.equal(typeof G.pages[k].load, 'function', k);
      assert.equal(typeof G.pages[k].main, 'function', k);
    }
    assert.equal(key({ name: 'settings', tab: 'loot' }), 'settingsLoot');
    assert.equal(key({ name: 'settings', tab: 'attendance' }), 'settingsAtt');
    assert.equal(key({ name: 'section', section: 'roster' }), null);
    for (const k of ['loot', 'personLoot', 'settingsLoot']) assert.equal(typeof G.pages[k].load, 'function', k);
    for (const k of ['loot', 'personLoot', 'settingsLoot']) assert.equal(typeof G.pages[k].main, 'function', k);
    assert.equal(G.pages.empty, undefined);
  });

  // ── api helper ─────────────────────────────────────────────────
  await check('api: every loot call hits the contract path and method with the contract body', async () => {
    const s = stub(() => Promise.resolve({}));
    const L = G.api.loot;
    await L.raid('g1', 'r1');
    await L.preview('g1', 'r1', [{ checksum: 'x' }]);
    await L.commit('g1', 'r1', [{ checksum: 'x' }], true);
    await L.commit('g1', 'r1', [], undefined);
    await L.update('g1', 'a1', { tag: 'OS' });
    await L.remove('g1', 'a1');
    await L.balance('g1', 't1', 12);
    await L.balance('g1', 't1', null);
    await L.raids('g1', 't1');
    await L.items('g1', 't1');
    await L.person('g1', 'p_1');
    await L.hub('g1', 't1');
    await L.item('g1', 't1', 28770);
    await L.award('g1', 'a1');
    await L.fix('g1', 't1');
    await L.keep('g1', 'r1', 28770, 'thoren|ashmere');
    await L.update('g1', 'a1', { winnerName: 'Healthas', itemId: 5, itemName: 'x', raidId: 'r2', note: 'n', updatedAt: 7 });
    await L.policy('g1');
    await L.savePolicy('g1', null, { visibility: { members: 'guild' } }, 3);
    await L.savePolicy('g1', 't1', {}, 0);
    assert.deepEqual(plain(s.calls), [
      { m: 'get', url: '/api/guild/g1/raids/r1/loot' },
      { m: 'post', url: '/api/guild/g1/raids/r1/loot/preview', body: { awards: [{ checksum: 'x' }] } },
      { m: 'post', url: '/api/guild/g1/raids/r1/loot', body: { awards: [{ checksum: 'x' }], includeOtherDay: true } },
      { m: 'post', url: '/api/guild/g1/raids/r1/loot', body: { awards: [], includeOtherDay: false } },
      { m: 'patch', url: '/api/guild/g1/loot/a1', body: { tag: 'OS' } },
      { m: 'del', url: '/api/guild/g1/loot/a1', body: {} },
      { m: 'get', url: '/api/guild/g1/loot/balance?team=t1&weeks=12' },
      { m: 'get', url: '/api/guild/g1/loot/balance?team=t1' },
      { m: 'get', url: '/api/guild/g1/loot/raids?team=t1' },
      { m: 'get', url: '/api/guild/g1/loot/items?team=t1' },
      { m: 'get', url: '/api/guild/g1/loot/person/p_1' },
      { m: 'get', url: '/api/guild/g1/loot/hub?team=t1' },
      { m: 'get', url: '/api/guild/g1/loot/items/28770?team=t1' },
      { m: 'get', url: '/api/guild/g1/loot/a/a1' },
      { m: 'get', url: '/api/guild/g1/loot/fix?team=t1' },
      { m: 'post', url: '/api/guild/g1/loot/fix/keep', body: { raidId: 'r1', itemId: 28770, winnerKey: 'thoren|ashmere' } },
      { m: 'patch', url: '/api/guild/g1/loot/a1', body: { winnerName: 'Healthas', itemId: 5, itemName: 'x', raidId: 'r2', note: 'n', updatedAt: 7 } },
      { m: 'get', url: '/api/guild/g1/loot/policy' },
      { m: 'put', url: '/api/guild/g1/loot/policy', body: { teamId: null, override: { visibility: { members: 'guild' } }, version: 3 } },
      { m: 'put', url: '/api/guild/g1/loot/policy', body: { teamId: 't1', override: {}, version: 0 } },
    ]);
    s.restore();
    await L.raid('g/1', 'r 1').catch(() => {});
  });

  // ── vocabulary ─────────────────────────────────────────────────
  await check('items: quality colour class, Wowhead link by game version (tbc, classic, forever; none for others), escaped names', () => {
    const L = G.pages.loot;
    assert.equal(L.itemUrl('tbc', 28770), 'https://www.wowhead.com/tbc/item=28770');
    assert.equal(L.itemUrl('classic', 28770), 'https://www.wowhead.com/classic/item=28770');
    assert.equal(L.itemUrl('forever', 28770), 'https://www.wowhead.com/forever/item=28770');
    assert.equal(L.itemUrl('retail', 28770), null);
    assert.equal(L.itemUrl('tbc', 0), null);
    const tbc = L.itemHtml({ itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 }, 'tbc');
    assert(tbc.includes('class="gs-item gs-q-4"') && tbc.includes('href="https://www.wowhead.com/tbc/item=28770"') && tbc.includes('rel="noopener noreferrer"') && tbc.includes('target="_blank"'));
    const unknown = L.itemHtml({ itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 }, 'retail');
    assert(unknown.startsWith('<span class="gs-item gs-q-4">') && !unknown.includes('href') && !unknown.includes('data-wowhead'), 'a version Wowhead is not asked about: plain text');
    assert(L.itemHtml({ itemId: 5 }, 'tbc').includes('>Item 5<'), 'no name: the id');
    assert(L.itemHtml({}, 'tbc').includes('Unknown item'));
    assert(!L.itemHtml({ itemId: 5, itemName: 'X', quality: 9 }, 'tbc').includes('gs-q-'), 'an unknown quality has no colour class');
    assert(!L.itemHtml({ itemId: 5, itemName: 'X', quality: null }, 'tbc').includes('gs-q-'));
    const hostile = L.itemHtml({ itemId: 5, itemName: HOSTILE + QUOTES, quality: 4 }, 'tbc');
    assertEscaped(hostile, 'item');
  });

  await check('look: the column-head style never reaches the row-header cells (item names), and a head icon keeps the name beside it', () => {
    const css = read('guild.css');
    assert(css.includes('.gs-loot-page .gs-dtable thead th {') && !css.includes('.gs-loot-page .gs-dtable th {'), 'the Loot column-head rule is scoped to thead th (a row-header th is an item name)');
    assert(css.includes('.gs-pagehead-icon + .gs-pagehead-title { flex: 1 1 auto; }'), 'the title grows next to its icon on every width');
  });

  await check('look: an open row menu is never cut off by its panel, and opens on screen on both widths', () => {
    const css = read('guild.css');
    assert(css.includes('.gs-hd-panel:has([data-menu] [aria-expanded="true"]) { overflow: visible; }'), 'a clipping panel lets an open menu out');
    const phone = css.slice(css.indexOf('@media (max-width: 760px) {'));
    assert(phone.includes('.gs-dtable td .gs-menu-list { left: 0; right: auto; }'), 'on a phone card the More sits at the left edge, so its menu opens rightward');
  });

  await check('quality colours: each passes 4.5:1 on the panel, card and hover backgrounds', () => {
    const css = read('guild.css');
    const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    for (let q = 0; q <= 7; q++) {
      const m = new RegExp('\\.gs-q-' + q + ', \\.guild-page a\\.gs-q-' + q + ' \\{ color: (#[0-9a-f]{6}); \\}').exec(css);
      assert(m, 'rule for quality ' + q);
      for (const bg of ['#191b1d', '#202325', '#262a2d']) assert(contrast(m[1], bg) >= 4.5, `q${q} ${m[1]} on ${bg}: ${contrast(m[1], bg).toFixed(2)}`);
    }
  });

  await check('winner: a person links to their loot, an alt shows the character, a guest and an unmatched name get a chip', () => {
    const L = G.pages.loot;
    const person = L.winnerHtml('g1', AWARDS[1].winner, AWARDS[1].match);
    assert(person.includes('href="#/g/g1/loot/p/p_kn"') && person.includes('>Kaelith<') && person.includes('Kaelith Alt') && person.includes('gs-class-rogue'));
    const main = L.winnerHtml('g1', AWARDS[0].winner, AWARDS[0].match);
    assert(!main.includes('gs-char-sub'), 'the main character needs no second name');
    const guest = L.winnerHtml('g1', AWARDS[2].winner, AWARDS[2].match);
    assert(guest.includes('>Guest<') && guest.includes('Dorrin-Ashmere') && !guest.includes('href'));
    const unm = L.winnerHtml('g1', AWARDS[3].winner, AWARDS[3].match);
    assert(unm.includes('Not on roster') && unm.includes('>Veyla<') && !unm.includes('Veyla-'), 'a realm-less name has no dash');
    const hostile = L.winnerHtml('g1', { name: HOSTILE, realm: QUOTES, class: 'MAGE' }, { kind: 'unmatched' });
    assertEscaped(hostile, 'winner');
    assertEscaped(L.winnerHtml('g1', { name: 'X', class: 'MAGE' }, { kind: 'character', personId: 'p_1', personName: HOSTILE, characterName: QUOTES }), 'person');
  });

  await check('tags and flags: chips for viewers, a select for editors; TMB hides behind Prio / Wishlist', () => {
    const L = G.pages.loot;
    assert(L.tagChipHtml('MS').includes('>MS<') && !L.tagChipHtml('MS').includes('is-'));
    assert(L.tagChipHtml('OS', 'officer').includes('is-os') && L.tagChipHtml('OS', 'officer').includes('set by an officer'));
    assert(L.tagChipHtml('BANK').includes('>Bank<') && L.tagChipHtml('BANK').includes('is-bank'));
    assert(L.tagChipHtml('DE').includes('>DE<'));
    const select = L.tagSelectHtml(AWARDS[2]);
    assert(select.includes('data-change="ln-tag"') && select.includes('data-aid="a3"'));
    for (const t of ['MS', 'OS', 'DE', 'BANK']) assert(select.includes('<option value="' + t + '"' + (t === 'OS' ? ' selected' : '') + '>'), t);
    assert(/<label class="gs-sr" for="tag-a3">/.test(select), 'labelled');
    const flags = stripTags(L.flagChipsHtml(['OS', 'SR', 'WL', 'PL', 'TMB']));
    assert.equal(flags, 'Off-spec rollSoft-resWishlistPrio');
    assert.equal(stripTags(L.flagChipsHtml(['TMB'])), 'TMB');
    assert.equal(L.flagChipsHtml([]), '');
    assert.equal(L.flagChipsHtml(['bogus']), '');
    assert.equal(L.flagChipsHtml(null), '');
  });

  // ── Loot section: Balance ──────────────────────────────────────
  function person(personId, name, cls, raids, ms, os, counted, perRaid, extra) {
    return Object.assign({
      personId, name, class: cls, status: 'raider', raids: { window: raids, all: raids + 2 },
      items: { MS: { window: ms, all: ms + 1 }, OS: { window: os, all: os }, DE: { window: 0, all: 0 }, BANK: { window: 0, all: 0 } },
      counted: { window: counted, all: counted + 1 }, perRaid: { window: perRaid, all: perRaid == null ? null : perRaid + 0.1 }, vsTeam: null,
    }, extra || {});
  }
  const BALANCE = {
    team: { id: 't1', name: 'Team KJ' }, window: { weeks: 8, switchWeeks: [8, 12], from: '2026-08-18' }, mode: 'perRaid', countTags: ['MS'], scope: 'team',
    people: [
      person('p_zz', 'Zzaps', 'DRUID', 6, 1, 0, 1, 0.17),
      person('p_aa', 'Aimersmay', 'HUNTER', 8, 5, 2, 5, 0.63),
      person('p_new', 'Newbie', 'MAGE', 0, 0, 0, 0, null),
      person('p_old', 'Oldtimer', 'WARRIOR', 3, 2, 1, 2, 0.67, { status: 'inactive' }),
    ],
    teamAverage: { window: 0.49, all: 0.55 },
  };
  // ── By raid / By item ──────────────────────────────────────────
  const RAIDS = { raids: [
    { raidId: 'r2', raidOn: '2026-10-11', title: 'BT clear', zone: 'Black Temple', awards: 9, counted: 7, unmatched: 2 },
    { raidId: 'r1', raidOn: '2026-10-10', title: null, zone: 'Gruul', awards: 4, counted: 4, unmatched: 0 },
  ] };
  const ITEMS = { items: [
    { itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, count: 2, lastAwardedAt: 1791681160000, awards: [
      { id: 'a1', raidId: 'r2', raidOn: '2026-10-11', awardedAt: 1791681160000, tag: 'MS', tagSetBy: null, winner: { name: 'Thoren', realm: 'Ashmere', class: 'PALADIN' }, match: AWARDS[0].match },
      { id: 'a9', raidId: 'r1', raidOn: '2026-10-10', awardedAt: 1791600000000, tag: 'DE', tagSetBy: 'officer', winner: { name: 'Veyla', realm: null, class: 'MAGE' }, match: { kind: 'unmatched' } },
    ] },
    { itemId: 5, itemName: null, quality: null, count: 1, lastAwardedAt: null, awards: [] },
  ] };

  const standOpts = (over, can) => Object.assign({ guildData: gd(can || OFFICER_CAN), state: { status: 'ok', teamId: 't1', data: BALANCE } }, over || {});
  const resetUi = () => { G.app.state.att = G.app.state.att || {}; G.app.state.att.lootUi = { sort: 'due', window: null, windowTeam: null, showAll: false }; };
  const standNames = html => [...html.matchAll(/<th scope="row" class="gs-dtable-primary">(.*?)<\/th>/g)].map(m => stripTags(m[1]).replace(/You$/, '').trim());
  const segPressed = (html, action, value) => new RegExp('aria-pressed="(true|false)" data-action="' + action + '" data-value="' + value + '"').exec(html)[1];

  await check('standings: header with a back link, order and window switches, a table ranked most due first with the rank column', withState(async () => {
    resetUi();
    const out = G.pages.lootStandings.standingsHtml(standOpts());
    assert(out.includes('>Standings</h1>') && out.includes('Team KJ - 4 people') && out.includes('MS items per raid attended, the lowest is the most due'));
    assert(out.includes('class="gs-back-link" href="#/g/g1/loot"'));
    assert.equal(segPressed(out, 'lstand-sort', 'due'), 'true');
    assert.equal(segPressed(out, 'lstand-sort', 'name'), 'false');
    for (const [w, pressed] of [['8', 'true'], ['12', 'false'], ['all', 'false']]) assert.equal(segPressed(out, 'loot-window', w), pressed, w);
    assert.deepEqual(standNames(out), ['Zzaps', 'Aimersmay', 'Oldtimer', 'Newbie'], 'lowest per raid first, a person with no figure last');
    assert(out.includes('<table class="gs-dtable" aria-label="Loot standings">') && out.includes('MS per raid') && out.includes('href="#/g/g1/loot/p/p_aa"'));
    assertNoRawAttrs(out);
  }));

  await check('standings: name order, the all-time window, the viewer keeps their place as You, plain counts mode, own scope', withState(async () => {
    resetUi();
    G.app.state.att.lootUi.sort = 'name';
    assert.deepEqual(standNames(G.pages.lootStandings.standingsHtml(standOpts())), ['Aimersmay', 'Newbie', 'Oldtimer', 'Zzaps']);
    G.app.state.att.lootUi.sort = 'due';
    G.app.state.att.lootUi.window = 'all';
    const all = G.pages.lootStandings.standingsHtml(standOpts());
    assert.equal(segPressed(all, 'loot-window', 'all'), 'true');
    assert(all.includes('>0.73<') && all.includes('>10<'), 'the all-time figures');
    G.app.state.att.lootUi.window = null;
    const me = Object.assign({}, BALANCE, { people: BALANCE.people.map(p => Object.assign({}, p, { isMe: p.personId === 'p_old' })) });
    const pinned = G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: me } }));
    assert.deepEqual(standNames(pinned), standNames(G.pages.lootStandings.standingsHtml(standOpts())), 'the viewer is not moved: same order as without a You row');
    assert.notEqual(standNames(pinned).indexOf('Oldtimer'), 0, 'Oldtimer is not first');
    assert(pinned.includes('<span class="gs-you">You</span>') && pinned.includes('gs-dtable-row is-you'));
    const rank = [...pinned.matchAll(/<td class="is-right" data-label="Raids">/g)];
    assert(rank.length >= 4);
    const count = G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: Object.assign({}, BALANCE, { mode: 'count', countTags: ['MS', 'OS'] }) } }));
    assert(count.includes('data-label="Counted"') && !count.includes('data-label="MS per raid"') && count.includes('counted items, the lowest is the most due'));
    const own = Object.assign({}, BALANCE, { scope: 'own', people: [BALANCE.people[0]] });
    const ownOut = G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: own } }, MEMBER_CAN));
    assert(ownOut.includes('You see your own loot only') && standNames(ownOut).length === 1);
  }));

  await check('standings: 16 rows then Show all, an empty team, a 403 reads as a plain sentence, hostile names are escaped', withState(async () => {
    resetUi();
    const many = Object.assign({}, BALANCE, { people: Array.from({ length: 20 }, (_, i) => person('p_' + i, 'Raider' + String(i).padStart(2, '0'), 'MAGE', 5, i, 0, i, i / 5)) });
    const out = G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: many } }));
    assert.equal(standNames(out).length, 16);
    assert(out.includes('Showing 16 of 20 people') && out.includes('data-action="lstand-showall"') && out.includes('Show all 20'));
    G.app.state.att.lootUi.showAll = true;
    assert.equal(standNames(G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: many } }))).length, 20);
    resetUi();
    assert(G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: Object.assign({}, BALANCE, { people: [] }) } })).includes('No loot yet'));
    const denied = G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'denied', teamId: 't1', data: null } }, MEMBER_CAN));
    assert(/Your guild doesn(&#39;|')t show standings to members\./.test(denied) && !denied.includes('<table'));
    const bad = Object.assign({}, BALANCE, { people: [person('p_h', HOSTILE + QUOTES, 'MAGE', 4, 1, 1, 1, 0.25)] });
    assertEscaped(G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: bad } })), 'standings');
  }));

  // ── Loot hub ───────────────────────────────────────────────────
  const night = (id, raidOn, awards) => ({ raid: { id, raidOn, title: id === 'r2' ? 'BT clear' : null, zone: id === 'r2' ? 'Black Temple' : 'Gruul' }, awards });
  const NIGHTS = [night('r2', '2026-10-11', [award('h1', { raidId: 'r2', raidOn: '2026-10-11' }), award('h2', { raidId: 'r2', raidOn: '2026-10-11', itemId: 30311, itemName: 'Warp Slicer', tag: 'OS' }), award('h3', { raidId: 'r2', raidOn: '2026-10-11', itemId: 30311, itemName: 'Warp Slicer', winner: { name: 'Kaelith', realm: 'Ashmere', class: 'ROGUE' }, match: { kind: 'character', personId: 'p_kn', personName: 'Kaelith', characterName: 'Kaelith', isMain: true } })]),
    night('r1', '2026-10-10', [award('h4', { raidId: 'r1', raidOn: '2026-10-10', itemId: 28823, itemName: 'Eye of Gruul', editedFields: ['winner'] })])];
  const hubData = (over) => Object.assign({
    team: { id: 't1', name: 'Team KJ' }, level: 'full', can: { edit: false, rules: false, standings: false, itemLookup: false },
    me: { personId: 'p_th', totals: { MS: 2, OS: 1, DE: 0, BANK: 0 }, byNight: [NIGHTS[0].awards.slice(0, 2), NIGHTS[1].awards].map((aw, i) => ({ raid: NIGHTS[i].raid, awards: aw })) },
    nights: NIGHTS, standingsTop: null, fix: null,
  }, over || {});
  const hubState = (hub, over) => Object.assign({ gid: 'g1', teamId: 't1', status: 'ok', hub, raids: RAIDS.raids, balance: null, items: ITEMS.items, ui: { allNights: false, query: '' } }, over || {});
  const hubPage = (hub, can, over) => G.pages.lootHub.hubHtml({ guildData: gd(can || MEMBER_CAN), state: hubState(hub, over) });
  const OFFICER_HUB = () => hubData({ level: 'full', can: { edit: true, rules: true, standings: true, itemLookup: true }, me: null, fix: { duplicates: 3, unknown: 0 },
    standingsTop: BALANCE.people.slice(0, 3), standingsCount: 4, standingsInfo: { mode: 'perRaid', countTags: ['MS'], weeks: 8 } });
  const cardIds = html => [...html.matchAll(/<section class="gs-hd-panel gs-pr-panel" id="(lhub-[a-z]+)"/g)].map(m => m[1]);

  await check('hub: an officer gets Who is due, Latest raid nights, Look up an item and Needs fixing, and the Loot rules link', withState(async () => {
    const out = hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE });
    assert.deepEqual(cardIds(out), ['lhub-due', 'lhub-nights', 'lhub-items', 'lhub-fix']);
    assert(out.includes('>Loot</h1>') && out.includes('Team KJ - 13 awards from 2 raid nights'));
    assert(out.includes('href="#/g/g1/settings/loot"') && out.includes('>Loot rules<'), 'the rules link for loot.policy');
    assert(out.includes('Who is due') && out.includes('The lowest figure is the most due') && out.includes('Full standings, 4 people') && out.includes('href="#/g/g1/loot/standings"'));
    const dueCard = out.slice(out.indexOf('id="lhub-due"'), out.indexOf('id="lhub-nights"'));
    assert(dueCard.indexOf('Zzaps') < dueCard.indexOf('Aimersmay') && dueCard.indexOf('Aimersmay') > 0, 'most due first');
    assert(!dueCard.includes('Oldtimer'), 'inactive people are left off the card');
    assert(out.includes('href="#/g/g1/loot/n/r2"') && out.includes('3 awards - BT clear - Black Temple') && out.includes('All 2 raid nights'));
    assert(out.includes('Item name or ID') && out.includes('Dropped more than once on Sun Oct 11') && out.includes('href="#/g/g1/loot/i/30311"') && out.includes('2 awards on that night'));
    assert(out.includes('Needs fixing') && out.includes('<span class="gs-hd-chip is-rose">3 to fix</span>') && out.includes('3 found') && out.includes('Review the 3 possible duplicates') && out.includes('href="#/g/g1/loot/fix"'));
    assert(!out.includes('My loot'), 'officers have no My loot card');
    assertNoRawAttrs(out);
  }));

  await check('hub: a Team Lead has no Loot rules link; the cards follow what the Worker allows (can.standings, can.itemLookup, fix)', withState(async () => {
    const lead = hubData({ can: { edit: true, rules: false, standings: true, itemLookup: true }, me: null, fix: { duplicates: 0, unknown: 0 } });
    const out = hubPage(lead, LEAD_CAN, { balance: BALANCE });
    assert(!out.includes('>Loot rules<') && !out.includes('settings/loot'));
    assert(out.includes('Needs fixing') && out.includes('None') && !out.includes('Review the'), 'nothing to fix: no button');
    const noItems = hubPage(hubData({ can: { edit: true, rules: false, standings: false, itemLookup: false }, me: null, fix: { duplicates: 1, unknown: 1 } }), LEAD_CAN);
    assert.deepEqual(cardIds(noItems), ['lhub-nights', 'lhub-fix']);
  }));

  await check('hub: a member sees My loot on the left (first) and the latest raid nights on the right, with who received what; standings and look-up only when on', withState(async () => {
    const out = hubPage(hubData());
    assert.deepEqual(cardIds(out), ['lhub-mine', 'lhub-nights']);
    assert(out.indexOf('id="lhub-mine"') < out.indexOf('id="lhub-nights"'), 'My loot LEFT, nights RIGHT');
    assert(out.includes('the latest raid nights and your own loot'));
    const mine = out.slice(out.indexOf('id="lhub-mine"'), out.indexOf('id="lhub-nights"'));
    assert(mine.includes('2 MS') && mine.includes('1 OS') && mine.includes('Open my loot page') && mine.includes('href="#/g/g1/loot/p/p_th"') && mine.includes('>Edited<'));
    const nights = out.slice(out.indexOf('id="lhub-nights"'));
    assert(nights.includes('Newest first - who received what') && (nights.match(/<li class="gs-lt-night"><details/g) || []).length === 2);
    assert(/<li class="gs-lt-night"><details open>/.test(nights) && nights.indexOf(' open>') < nights.indexOf('Sat Oct 10') , 'the newest night is open, the older one folded');
    assert(nights.includes('<span class="gs-you">You</span>') && nights.includes('>Kaelith<'), 'who received what, with You');
    assert(!nights.includes('All 2 raid nights'));
    const earlier = hubPage(hubData(), MEMBER_CAN, { raids: RAIDS.raids.concat([{ raidId: 'r0', raidOn: '2026-10-03', title: null, zone: 'SSC', awards: 6 }]) });
    assert(earlier.includes('Earlier raid nights') && !earlier.includes('id="lhub-all"'));
    assert(!out.includes('Who is due') && !out.includes('Look up an item') && !out.includes('Needs fixing') && !out.includes('Loot rules'));
    const on = hubPage(hubData({ can: { edit: false, rules: false, standings: true, itemLookup: true } }), MEMBER_CAN, { balance: BALANCE });
    assert.deepEqual(cardIds(on), ['lhub-mine', 'lhub-nights', 'lhub-due', 'lhub-items']);
    const half = hubPage(hubData({ can: { edit: false, rules: false, standings: true, itemLookup: false } }), MEMBER_CAN, { balance: BALANCE });
    assert.deepEqual(cardIds(half), ['lhub-mine', 'lhub-nights', 'lhub-due']);
    const other = hubPage(hubData({ can: { edit: false, rules: false, standings: false, itemLookup: true } }), MEMBER_CAN);
    assert.deepEqual(cardIds(other), ['lhub-mine', 'lhub-nights', 'lhub-items']);
    assert(!on.includes('Who is due') === false && on.includes('Look up an item'));
  }));

  await check('hub: level own shows My loot only; a member without a roster entry and an empty team get their own wording', withState(async () => {
    const own = hubPage(hubData({ level: 'own' }), MEMBER_CAN, { raids: null, items: null });
    assert.deepEqual(cardIds(own), ['lhub-mine']);
    assert(own.includes('your own loot') && !own.includes('Earlier raid nights') && !own.includes('Latest raid nights'));
    const none = hubPage(hubData({ me: null }));
    assert(none.includes('You are not on this team\'s roster, so there is no loot to list for you.') === false ? none.includes('no loot to list for you') : true);
    const fresh = hubPage(hubData({ me: { personId: 'p_th', totals: { MS: 0, OS: 0, DE: 0, BANK: 0 }, byNight: [] }, nights: [] }), MEMBER_CAN, { raids: [] });
    assert(fresh.includes('Your loot shows here after your first award is imported.') && fresh.includes('No loot is recorded for this team yet.'));
    const emptyOfficer = hubPage(hubData({ can: { edit: true, rules: false, standings: false, itemLookup: false }, me: null, nights: [], fix: { duplicates: 0, unknown: 0 } }), OFFICER_CAN, { raids: [] });
    assert(emptyOfficer.includes('No loot yet') && emptyOfficer.includes('Import from Gargul'));
    const denied = G.pages.lootHub.hubHtml({ guildData: gd(MEMBER_CAN), state: { gid: 'g1', teamId: 't1', status: 'denied' } });
    assert(/You can(&#39;|')t see this team(&#39;|')s loot/.test(denied));
  }));

  await check('hub: All N raid nights expands the card in place from the raid list; members get Earlier raid nights', withState(async () => {
    const closed = hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE });
    assert(closed.includes('data-action="lhub-nights"') && closed.includes('aria-expanded="false"') && !closed.includes('id="lhub-all"'));
    const open = hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE, ui: { allNights: true, query: '' } });
    assert(open.includes('id="lhub-all"') && open.includes('href="#/g/g1/loot/n/r1"') && open.includes('Show fewer') && open.includes('9 awards'));
    const member = hubPage(hubData(), MEMBER_CAN, { raids: RAIDS.raids.concat([{ raidId: 'r0', raidOn: '2026-10-03', title: null, zone: 'SSC', awards: 6 }]), ui: { allNights: true, query: '' } });
    const list = member.slice(member.indexOf('id="lhub-all"'));
    assert(list.includes('href="#/g/g1/loot/n/r0"') && !list.includes('href="#/g/g1/loot/n/r2"'), 'only the nights not shown above');
  }));

  await check('hub: Look up an item searches the item list by name or id and links to the item page; hostile text is escaped', withState(async () => {
    const found = G.pages.lootHub.searchMatches(ITEMS.items, 'mind');
    assert.deepEqual(plain(found.map(i => i.itemId)), [28770]);
    assert.deepEqual(plain(G.pages.lootHub.searchMatches(ITEMS.items, '5').map(i => i.itemId)), [5], 'an id matches exactly');
    assert.deepEqual(plain(G.pages.lootHub.searchMatches(ITEMS.items, '')), []);
    const out = hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE, ui: { allNights: false, query: 'mind' } });
    assert(out.includes('value="mind"') && out.includes('href="#/g/g1/loot/i/28770"') && out.includes('2 awards'));
    const unknown = hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE, ui: { allNights: false, query: '99999' } });
    assert(unknown.includes('Open item 99999') && unknown.includes('href="#/g/g1/loot/i/99999"'));
    const nothing = hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE, ui: { allNights: false, query: 'zzzz' } });
    assert(nothing.includes('No item with that name has been awarded.'));
    const evil = hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE, ui: { allNights: false, query: HOSTILE + QUOTES }, items: [{ itemId: 7, itemName: HOSTILE, quality: 4, count: 1 }] });
    assertEscaped(evil, 'hub search');
    const hostileNight = hubData({ nights: [night('r9', '2026-10-12', [award('x1', { raidId: 'r9', itemName: HOSTILE, winner: { name: HOSTILE, realm: null, class: 'MAGE' }, match: { kind: 'unmatched' } })])] });
    assertEscaped(hubPage(hostileNight, MEMBER_CAN), 'hub nights');
  }));

  // ── hub and standings data ─────────────────────────────────────
  await check('hub load: reads the hub, then the raid list and the items as the hub allows (Who is due comes from the hub itself); level own reads the hub only; 403 is the denied state', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    const realTeamFor = ctx.Guild.app.teamFor;
    ctx.Guild.app.teamFor = () => 't1';
    const route = { name: 'section', gid: 'g1', section: 'loot' };
    let reply = OFFICER_HUB();
    let s = stub((m, url) => Promise.resolve(/hub/.test(url) ? reply : /balance/.test(url) ? BALANCE : /loot\/raids/.test(url) ? RAIDS : ITEMS));
    await G.pages.loot.load(route, gdata);
    assert.deepEqual(s.calls.map(c => c.url).sort(), ['/api/guild/g1/loot/hub?team=t1', '/api/guild/g1/loot/items?team=t1', '/api/guild/g1/loot/raids?team=t1'], 'no second balance fetch');
    const x = G.app.state.att.lootHub;
    assert.equal(x.status, 'ok'); assert.equal(x.raids.length, 2); assert.equal(x.items.length, 2); assert.equal(x.balance.people.length, 3); assert.equal(x.balance.count, 4);
    const page = G.pages.loot.main(route, gdata);
    assert(page.includes('id="lhub-due"') && page.includes('Full standings, 4 people'), 'the card uses standingsTop and standingsCount');
    s.restore();
    reply = hubData({ level: 'own' });
    s = stub((m, url) => Promise.resolve(reply));
    await G.pages.loot.load(route, gdata);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/hub?team=t1'], 'level own: nothing else is read');
    s.restore();
    reply = hubData({ can: { edit: false, rules: false, standings: false, itemLookup: false } });
    s = stub((m, url) => Promise.resolve(/hub/.test(url) ? reply : RAIDS));
    await G.pages.loot.load(route, gdata);
    assert.deepEqual(s.calls.map(c => c.url).sort(), ['/api/guild/g1/loot/hub?team=t1', '/api/guild/g1/loot/raids?team=t1'], 'a member with both settings off reads the hub and the raid list');
    s.restore();
    s = stub((m, url) => (/hub/.test(url) ? Promise.resolve(OFFICER_HUB()) : Promise.reject(new G.api.ApiError(500, { error: 'boom' }))));
    await G.pages.loot.load(route, gdata);
    assert.equal(G.app.state.att.lootHub.status, 'ok', 'the extras may fail without losing the hub');
    assert.equal(G.app.state.att.lootHub.balance.people.length, 3, 'Who is due needs nothing but the hub');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await G.pages.loot.load(route, gdata);
    assert.equal(G.app.state.att.lootHub.status, 'denied');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom' })));
    await assert.rejects(G.pages.loot.load(route, gdata), err => err.status === 500);
    s.restore();
    assert(G.pages.loot.main(route, Object.assign({}, gdata, { guild: Object.assign({}, gdata.guild, { id: 'other' }) })).includes('Loading'), 'the data is for another guild: loading');
    ctx.Guild.app.teamFor = realTeamFor;
  }));

  await check('hub load: an old ?view= link tidies the address to the plain hub', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    const realTeamFor = ctx.Guild.app.teamFor;
    ctx.Guild.app.teamFor = () => null;
    const replaced = [];
    ctx.window = { history: { replaceState: (a, b, url) => replaced.push(url) }, location: { pathname: '/guild.html', search: '' } };
    await G.pages.loot.load({ name: 'section', gid: 'g1', section: 'loot', legacyView: true }, gdata);
    await G.pages.loot.load({ name: 'section', gid: 'g1', section: 'loot' }, gdata);
    delete ctx.window;
    ctx.Guild.app.teamFor = realTeamFor;
    assert.deepEqual(replaced, ['/guild.html#/g/g1/loot']);
  }));

  await check('standings load: reads the balance, falls back when a week count is refused, 403 is the denied state, a team change resets the window', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    resetUi();
    const realTeamFor = ctx.Guild.app.teamFor;
    ctx.Guild.app.teamFor = () => 't1';
    const L = G.pages.lootStandings;
    const route = { name: 'lootstandings', gid: 'g1' };
    let s = stub(() => Promise.resolve(BALANCE));
    await L.load(route, gdata);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/balance?team=t1']);
    assert(L.main(route, gdata).includes('>Standings</h1>'));
    s.restore();
    G.app.state.att.lootUi.window = 12;
    s = stub((m, url) => (/weeks=12/.test(url) ? Promise.reject(new G.api.ApiError(400, { error: 'invalid', field: 'weeks' })) : Promise.resolve(BALANCE)));
    await L.load(route, gdata);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/balance?team=t1&weeks=12', '/api/guild/g1/loot/balance?team=t1']);
    assert.equal(G.app.state.att.lootUi.window, null);
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await L.load(route, gdata);
    assert.equal(G.app.state.att.lootStand.status, 'denied');
    assert(/Your guild doesn(&#39;|')t show standings to members\./.test(L.main(route, gdata)));
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom' })));
    await assert.rejects(L.load(route, gdata), err => err.status === 500);
    s.restore();
    G.app.state.att.lootUi.window = 12;
    ctx.Guild.app.teamFor = () => 't2';
    s = stub(() => Promise.resolve(BALANCE));
    await L.load(route, gdata);
    assert.equal(s.calls[0].url, '/api/guild/g1/loot/balance?team=t2', 'a window belongs to one team');
    s.restore();
    ctx.Guild.app.teamFor = realTeamFor;
  }));

  await check('hub and standings handlers: the nights card toggles, the search redraws only its results, order and window switch', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    resetUi();
    const realRoute = G.app.routeAll, realRender = G.app.render;
    let routed = 0, rendered = 0;
    G.app.routeAll = () => { routed++; return Promise.resolve(); }; G.app.render = () => { rendered++; };
    G.app.state.att.lootHub = hubState(OFFICER_HUB());
    G.handlers.click['lhub-nights']();
    assert.equal(G.app.state.att.lootHub.ui.allNights, true);
    G.handlers.click['lhub-nights']();
    assert.equal(G.app.state.att.lootHub.ui.allNights, false);
    const box = { innerHTML: '' };
    ctx.document = { getElementById: id => (id === 'lhub-results' ? box : null), querySelector: () => null, querySelectorAll: () => [] };
    G.handlers.input['lhub-search']({ value: 'mind' });
    assert.equal(G.app.state.att.lootHub.ui.query, 'mind');
    assert(box.innerHTML.includes('href="#/g/g1/loot/i/28770"'));
    assert.equal(rendered, 2, 'typing does not redraw the page');
    ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    G.handlers.click['lstand-sort'](el({ 'data-value': 'name' }));
    assert.equal(G.app.state.att.lootUi.sort, 'name');
    G.handlers.click['lstand-sort'](el({ 'data-value': 'due' }));
    assert.equal(G.app.state.att.lootUi.sort, 'due');
    G.handlers.click['lstand-showall']();
    assert.equal(G.app.state.att.lootUi.showAll, true);
    rendered = 0;
    G.handlers.click['loot-window'](el({ 'data-value': '12' }));
    assert.equal(G.app.state.att.lootUi.window, 12);
    assert.equal(routed, 1);
    G.handlers.click['loot-window'](el({ 'data-value': 'all' }));
    assert.equal(G.app.state.att.lootUi.window, 'all');
    assert.equal(routed, 1, 'All time needs no request');
    assert.equal(rendered, 1);
    G.app.routeAll = realRoute; G.app.render = realRender;
  }));

  // ── the Loot card of a raid ────────────────────────────────────
  await check('raid card: a compact summary - counts by tag, the first awards read-only, and a link to the loot page of the night', () => {
    const out = raidPage(okState());
    assert(out.includes('<h2 class="gs-h2" id="loot-h">Loot awards</h2>') && out.includes('4 items'));
    assert(out.includes('<p class="gs-fine" id="loot-counts">3 MS &middot; 1 OS</p>'), 'counts by tag');
    assert(out.includes('<ul class="gs-loot-sublist" aria-label="Loot awarded on this raid">') && (out.match(/<li class="gs-loot-subrow"/g) || []).length === 4);
    assert(out.includes('id="loot-open-night" href="#/g/g1/loot/n/r1">Open the night\'s loot</a>'));
    assert(out.includes('class="gs-item gs-q-4"') && out.includes('href="https://www.wowhead.com/tbc/item=28770"') && out.includes('class="gs-item gs-q-3"'));
    assert(out.includes('>Guest<') && out.includes('Not on roster') && out.includes('gs-chip gs-chip-tag is-os'));
    assert(!out.includes('data-change="loot-tag"') && !out.includes('loot-delete') && !out.includes('loot-note') && !out.includes('gs-loot-row'), 'changes happen on the night page');
    assert(out.indexOf('Loot awards</h2>') > out.indexOf('People</h2>'), 'after the People card');
    const many = okState();
    many.data.awards = Array.from({ length: 8 }, (_, i) => award('m' + i));
    const long = raidPage(many);
    assert((long.match(/<li class="gs-loot-subrow"/g) || []).length === 5 && long.includes('And 3 more.'));
    assertNoRawAttrs(out);
  });

  await check('raid card: editors keep Import from Gargul and Add award; viewers get no edit buttons; the review link needs attendance.review', () => {
    const editor = raidPage(okState());
    assert(editor.includes('data-action="loot-import-open"') && editor.includes('Import from Gargul') && editor.includes('data-action="loot-add-open"'));
    assert(editor.includes('1 award goes to a winner who is not on the roster. Link them in the Review queue') && editor.includes('href="#/g/g1/attendance/review"'));
    const viewerState = okState({}, false);
    const viewer = raidPage(viewerState, MEMBER_CAN, { data: Object.assign({}, DETAIL, { can: { edit: false, review: false, seeAttendance: true } }) });
    assert(!viewer.includes('loot-import-open') && !viewer.includes('loot-add-open') && !viewer.includes('data-change="loot-tag"') && !viewer.includes('loot-delete') && !viewer.includes('loot-note'));
    assert(viewer.includes('id="loot-open-night"'), 'members can read the night too');
    assert(viewer.includes('An officer can link them.') && !viewer.includes('Review queue'));
    const lead = raidPage(okState(), LEAD_CAN);
    assert(lead.includes('Review queue'));
  });

  await check('raid card: empty states, no card for an upcoming raid or without loot access, an error card with a retry', () => {
    const empty = okState();
    empty.data.awards = [];
    const e = raidPage(empty);
    assert(e.includes('No loot is recorded for this raid yet. Import a Gargul export to add it, or add an award by hand.') && e.includes('0 items'));
    const v = raidPage(Object.assign(okState({}, false), { data: { awards: [], canEdit: false } }), MEMBER_CAN);
    assert(v.includes('No loot is recorded for this raid yet.') && !v.includes('Import a Gargul'));
    assert(!raidPage(null).includes('id="loot-h"'), 'not loaded');
    assert(!raidPage({ gid: 'g1', rid: 'r1', status: 'none' }).includes('id="loot-h"'), 'upcoming or hidden');
    const err = raidPage({ gid: 'g1', rid: 'r1', status: 'error', error: 'Could not reach Raidsmith.' });
    assert(err.includes('Could not reach Raidsmith.') && err.includes('data-action="loot-reload"') && !err.includes('gs-loot-list'));
    const hostile = okState();
    hostile.data.awards = [award('ah', { itemName: HOSTILE, winner: { name: QUOTES, realm: HOSTILE, class: 'MAGE' }, match: { kind: 'unmatched' }, note: HOSTILE + QUOTES, rollType: HOSTILE })];
    assertEscaped(raidPage(hostile), 'raid card');
    assertNoRawAttrs(raidPage(hostile));
  });

  // ── the Gargul import panel ────────────────────────────────────
  const COUNTS = { new: 7, update: 1, same: 2, otherRaid: 1, otherDay: 3 };
  function previewRows() {
    const parsed = G.gargul.parse(FIXTURE_TEXT);
    const statuses = ['new', 'new', 'new', 'update', 'same', 'same', 'otherRaid', 'otherDay', 'otherDay', 'otherDay', 'new', 'new', 'new', 'new'];
    // The disenchant of the fixture (row 14 of the paste) has no winner: the Worker answers match.kind 'disenchanted' and the tag DE.
    const match = (a, i) => (a.disenchanted ? { kind: 'disenchanted' } : i % 3 === 0 ? { kind: 'unmatched' } : { kind: 'character', personId: 'p_x', personName: a.winnerName, characterName: a.winnerName });
    return { parsed, rows: parsed.awards.map((a, i) => Object.assign({}, a, { status: statuses[i], match: match(a, i), tag: a.disenchanted ? 'DE' : a.flags.includes('OS') ? 'OS' : 'MS' })) };
  }
  function panel(over) {
    const x = okState();
    Object.assign(x.ui, { open: true }, over || {});
    return raidPage(x);
  }

  await check('import panel: input stage has a paste box, a file picker, Preview and Close; instructions name the Detailed (JSON) setting', () => {
    const out = panel({ text: 'abc' + HOSTILE });
    assert(out.includes('<h3 class="gs-h3" id="gl-title">Import from Gargul</h3>') && out.includes('Detailed (JSON)') && out.includes('/gl export'));
    assert(/<textarea[^>]*id="gl-paste"[^>]*data-input="loot-paste"/.test(out) && out.includes('abc&lt;img src=x onerror=1&gt;'), 'the pasted text survives a redraw, escaped');
    assert(/<input class="gs-input" type="file" id="gl-file" accept="\.json,\.txt,application\/json,text\/plain" data-change="loot-file"/.test(out));
    assert(out.includes('data-action="loot-preview"') && out.includes('>Preview<') && out.includes('data-action="loot-import-close"'));
    assert(!out.includes('data-action="loot-import-open"'), 'the open button hides while the panel is open');
    assertNoRawAttrs(out);
    assert(panel({ error: 'This is not JSON.' }).includes('<p class="gs-alert" role="alert" id="gl-error">This is not JSON.</p>'));
    assert(panel({ busy: true }).includes('Reading...') && /data-action="loot-preview"[^>]*disabled/.test(panel({ busy: true })));
  });

  await check('import panel: preview stage shows counts, status chips, the skipped rows, the other-day checkbox (off) and the Import button', () => {
    const { parsed, rows } = previewRows();
    const out = panel({ stage: 'preview', parsed, preview: { rows, counts: COUNTS } });
    assert(out.includes('14 awards read from 15 rows.') && out.includes('1 row was left out of the paste'));
    assert(out.includes('Row 9 (Eye of Gruul to Halric-Ashmere): Missing checksum') && !out.includes('Row 14') && !out.includes('Disenchanted item (no winner)'), 'the disenchant is no longer left out');
    for (const [label, n] of [['New', 7], ['Updated', 1], ['Unchanged', 2], ['On other raids', 1], ['On other days', 3]]) assert(out.includes('<dt>' + label + '</dt><dd>' + n + '</dd>'), label);
    for (const chip of ['>New<', '>Update<', '>Same<', '>Other raid<', '>Other day<']) assert(out.includes('gs-pill') && out.includes(chip), chip);
    assert(out.includes('<input type="checkbox" id="gl-other" data-change="loot-other" data-key="gl-other"><label for="gl-other">Include 3 awards from other days</label>'), 'unchecked');
    assert(out.includes('>Import 8 awards<') && !/<button[^>]*disabled[^>]*data-action="loot-commit"/.test(out));
    assert(out.includes('8 awards will be imported.') && out.includes('Nothing is saved yet.') && out.includes('class="gs-commitbar is-inline"'), 'the T5 commit bar, inside the panel');
    assert(/<li class="gs-step is-current" aria-current="step">(?:(?!<\/li>)[\s\S])*Preview/.test(out), 'step 2 of 3');
    const previewList = out.slice(out.indexOf('data-scroll-key="loot-preview"'));
    const previewHtml = previewList.slice(0, previewList.indexOf('</ul>'));
    assert(previewList.length > 0 && (previewHtml.match(/<li class="gs-loot-row"/g) || []).length === 14);
    const deRow = previewHtml.split('<li class="gs-loot-row"').filter(r => r.includes('id="loot-74190331205118463934"'));
    assert.equal(deRow.length, 1, 'the disenchant is a row of the preview');
    assert(stripTags(deRow[0]).includes('Disenchanted') && deRow[0].includes('>DE<') && !deRow[0].includes('Not on roster') && !deRow[0].includes('<select'), 'named as a disenchant, tagged DE, no winner chip');
    assert(out.includes('Oct 10, 8:12 PM'), 'date and time in the guild zone');
    assert(out.includes('Not on roster') && out.includes('data-action="loot-back"'));
    const included = panel({ stage: 'preview', parsed, preview: { rows, counts: COUNTS }, includeOtherDay: true });
    assert(included.includes(' checked><label for="gl-other">') && included.includes('>Import 11 awards<'));
    const nothing = panel({ stage: 'preview', parsed, preview: { rows, counts: { new: 0, update: 0, same: 14, otherRaid: 0, otherDay: 0 } } });
    assert(/<button[^>]*disabled[^>]*data-action="loot-commit"/.test(nothing) && nothing.includes('There is nothing new to import.') && !nothing.includes('gl-other'));
    assert(panel({ stage: 'preview', parsed, preview: { rows, counts: COUNTS }, busy: true }).includes('Importing...'));
    assertNoRawAttrs(out);
  });

  await check('import panel: the result line and the done stage', () => {
    const R = G.pages.raidLoot;
    assert.equal(R.resultLine({ inserted: 10, updated: 2, unchanged: 3, skippedOtherRaid: 1, skippedOtherDay: 4 }), 'Imported 10 new awards and 2 updates. 3 were already here. 1 award on other raids was left out. 4 awards from other days were left out.');
    assert.equal(R.resultLine({ inserted: 1, updated: 0, unchanged: 1, skippedOtherRaid: 0, skippedOtherDay: 0 }), 'Imported 1 new award. 1 was already here.');
    assert.equal(R.resultLine({ inserted: 0, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 0 }), 'Nothing new was imported.');
    const out = panel({ stage: 'done', result: { inserted: 2, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 1 } });
    assert(out.includes('id="gl-result"') && out.includes('Imported 2 new awards.') && out.includes('Import another export') && !out.includes('gl-paste'));
    assert.deepEqual(plain(R.mergeCommit({ inserted: 1, updated: 1, unchanged: 1, skippedOtherRaid: 1, skippedOtherDay: 1 }, { inserted: 2, updated: 0, unchanged: 5 })), { inserted: 3, updated: 1, unchanged: 6, skippedOtherRaid: 1, skippedOtherDay: 1, conflicts: { kept: 0, exported: 0 }, deleted: { kept: 0, readded: 0 } });
    assert.deepEqual(plain(R.mergeCommit({ inserted: 0, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 0, conflicts: { kept: 1, exported: 0 }, deleted: { kept: 0, readded: 1 } }, { conflicts: { kept: 2, exported: 3 }, deleted: { kept: 4, readded: 5 } })).conflicts, { kept: 3, exported: 3 });
    assert.equal(R.resultLine({ inserted: 1, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 0, conflicts: { kept: 2, exported: 1 }, deleted: { kept: 1, readded: 1 } }), "Imported 1 new award. Conflicts: 2 kept as the officer's, 1 taken from the export. Deleted awards: 1 kept deleted, 1 added back.");
    const merged = R.mergePreview({ rows: [{ a: 1 }], counts: { new: 1 } }, { rows: [{ a: 2 }], counts: { new: 2, same: 1 } });
    assert.deepEqual(plain(merged), { rows: [{ a: 1 }, { a: 2 }], counts: { new: 3, same: 1 } });
    assert.deepEqual(plain(R.mergePreview({ rows: [], counts: {} }, null)), { rows: [], counts: {} });
  });

  // ── import flow ────────────────────────────────────────────────
  function raidSetup(S, over) {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.raid = { gid: 'g1', rid: 'r1', data: DETAIL };
    S.att.raidLoot = okState(over);
    return S.att.raidLoot;
  }
  let renders = 0;
  const countRenders = () => { const real = G.app.render; renders = 0; G.app.render = () => { renders++; }; return () => { G.app.render = real; }; };

  await check('import flow: Preview parses in the browser, posts the normalized awards once, and shows the stage; nothing is committed', withState(async (S) => {
    const x = raidSetup(S);
    x.ui.open = true; x.ui.text = FIXTURE_TEXT;
    const done = countRenders();
    const s = stub((m, url, body) => Promise.resolve({ rows: body.awards.map(a => Object.assign({}, a, { status: 'new', match: { kind: 'unmatched' }, tag: 'MS' })), counts: { new: 14, update: 0, same: 0, otherRaid: 0, otherDay: 0 } }));
    G.handlers.click['loot-preview']();
    await tick();
    assert.equal(s.calls.length, 1);
    assert.deepEqual([s.calls[0].m, s.calls[0].url], ['post', '/api/guild/g1/raids/r1/loot/preview']);
    assert.equal(s.calls[0].body.awards.length, 14);
    assert.deepEqual(Object.keys(s.calls[0].body), ['awards']);
    assert.equal(s.calls[0].body.awards[0].checksum, '74190331205118463920');
    const sentDe = s.calls[0].body.awards.filter(a => a.disenchanted);
    assert.equal(sentDe.length, 1, 'the disenchant goes to the Worker as an award of its own');
    assert.deepEqual([sentDe[0].winnerName, sentDe[0].winnerRealm, sentDe[0].winnerClass, sentDe[0].checksum], [null, null, null, '74190331205118463934']);
    assert.equal(x.ui.stage, 'preview');
    assert.equal(x.ui.preview.rows.length, 14);
    assert.equal(x.ui.parsed.skipped.length, 1);
    assert.equal(x.ui.text, '', 'the big paste is dropped once read');
    assert.equal(x.ui.busy, false);
    assert(renders >= 2);
    s.restore(); done();
  }));

  await check('import flow: bad text never reaches the Worker; an export with nothing usable says why; a Worker error is shown and the paste stays', withState(async (S) => {
    const x = raidSetup(S);
    x.ui.open = true;
    const done = countRenders();
    const s = stub(() => Promise.reject(new G.api.ApiError(400, { error: 'invalid', message: 'Too many awards.' })));
    x.ui.text = 'dateTime,character,itemID\n1,2,3';
    G.handlers.click['loot-preview']();
    assert(/Detailed \(JSON\)/.test(x.ui.error) && x.ui.stage === 'input' && x.ui.text.startsWith('dateTime'));
    x.ui.text = JSON.stringify([{ foo: 1 }, { checksum: 'AAAAAAAAAA' }]);
    G.handlers.click['loot-preview']();
    assert(/None of the 2 rows can be imported\. First problem: Missing checksum\./.test(x.ui.error), x.ui.error);
    x.ui.text = '[]';
    G.handlers.click['loot-preview']();
    assert.equal(x.ui.error, 'The export holds no awards.');
    assert.equal(s.calls.length, 0, 'no request for any of those');
    x.ui.text = FIXTURE_TEXT;
    G.handlers.click['loot-preview']();
    await tick();
    assert.equal(x.ui.error, 'Too many awards.');
    assert.equal(x.ui.stage, 'input');
    assert.equal(x.ui.text, FIXTURE_TEXT, 'the paste is kept to try again');
    assert.equal(x.ui.busy, false);
    s.restore(); done();
  }));

  await check('import flow: more than 500 awards go in requests of 500, merged in order, for the preview and for the commit', withState(async (S) => {
    const x = raidSetup(S);
    x.ui.open = true;
    const many = Array.from({ length: 1201 }, (_, i) => ({ checksum: 'CHK' + String(i).padStart(10, '0'), itemID: 30311, awardedTo: 'Thoren-Ashmere', timestamp: 1791681160 + i, itemLink: '|cffa335ee|Hitem:30311|h[Warp Slicer]|h|r' }));
    x.ui.text = JSON.stringify(many);
    const done = countRenders();
    let s = stub((m, url, body) => Promise.resolve({ rows: body.awards.map(a => Object.assign({}, a, { status: 'new', match: { kind: 'unmatched' }, tag: 'MS' })), counts: { new: body.awards.length, update: 0, same: 0, otherRaid: 0, otherDay: 0 } }));
    G.handlers.click['loot-preview']();
    await tick();
    assert.deepEqual(s.calls.map(c => c.body.awards.length), [500, 500, 201]);
    assert.equal(x.ui.preview.rows.length, 1201);
    assert.equal(x.ui.preview.counts.new, 1201);
    assert.equal(x.ui.preview.rows[1200].checksum, 'CHK0000001200', 'order kept');
    s.restore();

    x.ui.includeOtherDay = true;
    s = stub((m, url, body) => (m === 'post' ? Promise.resolve({ inserted: body.awards.length, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 1, awards: [] }) : Promise.resolve({ awards: AWARDS, canEdit: true })));
    G.handlers.click['loot-commit']();
    await tick();
    const posts = s.calls.filter(c => c.m === 'post');
    assert.deepEqual(posts.map(c => [c.url, c.body.awards.length, c.body.includeOtherDay]), [['/api/guild/g1/raids/r1/loot', 500, true], ['/api/guild/g1/raids/r1/loot', 500, true], ['/api/guild/g1/raids/r1/loot', 201, true]]);
    assert.deepEqual(plain(x.ui.result), { inserted: 1201, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 3, conflicts: { kept: 0, exported: 0 }, deleted: { kept: 0, readded: 0 } });
    assert.equal(x.ui.stage, 'done');
    assert.equal(s.calls[s.calls.length - 1].m, 'get', 'the awards are read again after the import');
    assert.equal(x.data.awards.length, 4);
    s.restore(); done();
  }));

  await check('import flow: Import sends includeOtherDay false until the box is ticked; a failure reloads the list and says the import stopped', withState(async (S) => {
    const x = raidSetup(S);
    x.ui.open = true;
    const { parsed, rows } = previewRows();
    Object.assign(x.ui, { stage: 'preview', parsed, preview: { rows, counts: COUNTS } });
    const done = countRenders();
    G.handlers.change['loot-other']({ checked: true });
    assert.equal(x.ui.includeOtherDay, true);
    G.handlers.change['loot-other']({ checked: false });
    assert.equal(x.ui.includeOtherDay, false);
    let s = stub((m, url) => (m === 'post' ? Promise.resolve({ inserted: 6, updated: 1, unchanged: 2, skippedOtherRaid: 1, skippedOtherDay: 3, awards: [] }) : Promise.resolve({ awards: [AWARDS[0]], canEdit: true })));
    G.handlers.click['loot-commit']();
    await tick();
    assert.equal(s.calls[0].body.includeOtherDay, false);
    assert.equal(s.calls[0].body.awards.length, 14);
    assert.deepEqual(plain(x.ui.result), { inserted: 6, updated: 1, unchanged: 2, skippedOtherRaid: 1, skippedOtherDay: 3, conflicts: { kept: 0, exported: 0 }, deleted: { kept: 0, readded: 0 } });
    assert.equal(x.data.awards.length, 1);
    s.restore();

    Object.assign(x.ui, { stage: 'preview', parsed, preview: { rows, counts: COUNTS }, result: null, busy: false });
    s = stub((m) => (m === 'post' ? Promise.reject(new G.api.ApiError(409, { error: 'raid_not_started', message: 'This raid has not started yet.' })) : Promise.resolve({ awards: AWARDS, canEdit: true })));
    G.handlers.click['loot-commit']();
    await tick();
    assert(x.ui.error.startsWith('This raid has not started yet. The import stopped'), x.ui.error);
    assert.equal(x.ui.stage, 'preview');
    assert.equal(x.data.awards.length, 4);
    assert.equal(x.ui.busy, false);
    s.restore(); done();
  }));

  await check('import flow: a request the Worker refuses names the row of the paste, counting from the start of its 500-award chunk', withState(async (S) => {
    const x = raidSetup(S);
    x.ui.open = true;
    const done = countRenders();
    const rows = Array.from({ length: 600 }, (_, i) => ({ checksum: 'CHK' + String(i).padStart(10, '0'), itemID: 30311, awardedTo: 'Thoren-Ashmere', timestamp: 1791681160 + i, itemLink: '|cffa335ee|Hitem:30311|h[Warp Slicer]|h|r' }));
    x.ui.text = JSON.stringify([{ foo: 1 }].concat(rows));
    let n = 0;
    const s = stub((m, url, body) => {
      n++;
      if (n === 2) return Promise.reject(new G.api.ApiError(400, { error: 'bad_request', message: 'Award 3: the winner needs a character name (2 to 12 letters).', field: 'awards', index: 2, awardField: 'winnerName' }));
      return Promise.resolve({ rows: [], counts: { new: body.awards.length } });
    });
    G.handlers.click['loot-preview']();
    await tick();
    assert.equal(x.ui.stage, 'input');
    assert.equal(x.ui.error, 'Row 504 of the paste (Warp Slicer to Thoren) was refused: the winner needs a character name (2 to 12 letters).', 'index 2 of the second request is award 502, which sits on row 504 (row 1 was skipped)');
    s.restore();
    const R = G.pages.raidLoot;
    const parsed = { awards: [{ itemName: null, itemId: 9, winnerName: 'Kaelith' }], awardRows: [4] };
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Award 1: checksum must be 8 to 40 characters without spaces.', field: 'awards', index: 0 }), parsed), 'Row 4 of the paste (item 9 to Kaelith) was refused: checksum must be 8 to 40 characters without spaces.');
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Send at least one award.', field: 'awards' }), parsed), 'Send at least one award.', 'no index: the Worker\'s words');
    assert.equal(R.describeError(new G.api.ApiError(500, { message: 'Boom.' }), parsed), 'Boom.');
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Award 9: x', field: 'awards', index: 8 }), parsed), 'Award 9: x', 'an index outside the paste is left alone');
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Award 1: x', field: 'awards', index: 0 }), null), 'Award 1: x');
    done();
  }));

  await check('balance: the Worker\'s vsTeam is the window difference; the all-time difference is worked out from the all-time average', () => {
    const L = G.pages.loot;
    const data = Object.assign({}, BALANCE, { people: [Object.assign({}, BALANCE.people[1], { perRaid: { window: 0.625, all: 0.7 }, vsTeam: 0.135 })] });
    const win = L.balanceRows(data, 'window')[0];
    assert.equal(win.vs, 0.135, 'the Worker\'s own number');
    assert.equal(L.balanceRows(data, 'all')[0].vs.toFixed(2), '0.15');
    assert.equal(L.balanceRows(Object.assign({}, data, { people: [Object.assign({}, data.people[0], { perRaid: { window: null, all: null }, vsTeam: null })] }), 'window')[0].vs, null);
  });

  await check('import flow: the file picker fills the paste box (text() or FileReader), a big file is refused; open, close and back reset the panel', withState(async (S) => {
    const x = raidSetup(S);
    const done = countRenders();
    G.handlers.click['loot-import-open']();
    assert.equal(x.ui.open, true);
    G.handlers.change['loot-file']({ files: [{ size: 10, text: () => Promise.resolve('[1,2]') }] });
    await tick();
    assert.equal(x.ui.text, '[1,2]');
    G.handlers.change['loot-file']({ files: [{ size: G.gargul.MAX_FILE_CHARS + 1, text: () => Promise.resolve('x') }] });
    assert(/larger than 8 MB/.test(x.ui.error));
    assert.equal(x.ui.text, '[1,2]');
    G.handlers.change['loot-file']({ files: [{ size: 10, text: () => Promise.reject(new Error('nope')) }] });
    await tick();
    assert.equal(x.ui.error, 'Could not read that file.');
    G.handlers.change['loot-file']({ files: [] });
    G.handlers.input['loot-paste']({ value: 'typed' });
    assert.equal(x.ui.text, 'typed');
    x.ui.stage = 'done';
    G.handlers.click['loot-back']();
    assert.deepEqual([x.ui.open, x.ui.stage, x.ui.text], [true, 'input', '']);
    G.handlers.click['loot-import-close']();
    assert.equal(x.ui.open, false);
    done();
  }));

  // ── per-award edits ────────────────────────────────────────────
  await check('raid card data: loaded with the raid; upcoming raids and viewers without access get no card; other errors keep a retry', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    const R = G.pages.raidLoot;
    let s = stub(() => Promise.resolve({ awards: AWARDS, canEdit: true }));
    await R.loadFor(gdata, DETAIL);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/raids/r1/loot']);
    assert.equal(R.stateFor('g1', 'r1').status, 'ok');
    assert.equal(R.stateFor('g1', 'other'), null);
    const ui = R.stateFor('g1', 'r1').ui;
    ui.open = true;
    await R.loadFor(gdata, DETAIL, { keepUi: true });
    assert.equal(R.stateFor('g1', 'r1').ui, ui, 'Try again on the card keeps the open panel');
    await R.loadFor(gdata, DETAIL);
    assert.notEqual(R.stateFor('g1', 'r1').ui, ui, 'opening the raid page again starts the panel afresh');
    assert.deepEqual(plain(R.stateFor('g1', 'r1').ui), plain(R.freshUi()));
    s.restore();
    s = stub(() => Promise.resolve({}));
    await R.loadFor(gdata, { raid: Object.assign({}, DETAIL.raid, { upcoming: true, id: 'r9' }) });
    assert.equal(s.calls.length, 0, 'no request for an upcoming raid');
    assert.equal(R.stateFor('g1', 'r9').status, 'none');
    s.restore();
    for (const [status, want] of [[403, 'denied'], [404, 'none']]) {
      s = stub(() => Promise.reject(new G.api.ApiError(status, { error: 'x' })));
      await R.loadFor(gdata, DETAIL);
      assert.equal(R.stateFor('g1', 'r1').status, want, String(status));
      s.restore();
    }
    assert(/You can(&#39;|')t see this team(&#39;|')s loot/.test(raidPage({ gid: 'g1', rid: 'r1', status: 'denied' })) && !raidPage({ gid: 'g1', rid: 'r1', status: 'denied' }).includes('gs-loot-list'), 'a 403 is a short note in the card');
    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom', message: 'Server trouble.' })));
    await R.loadFor(gdata, DETAIL);
    assert.deepEqual([R.stateFor('g1', 'r1').status, R.stateFor('g1', 'r1').error], ['error', 'Server trouble.']);
    s.restore();
  }));

  await check('raid page: the detail load fetches the loot after the detail, and the page main passes its state to the card', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    const SIGNUPS = { raid: { id: 'r1', teamId: 't1', startsAt: 1, upcoming: false, locked: false, closed: 'started' }, can: { edit: true, self: false, seeList: true, seeNicknames: true }, me: null, counts: null, entries: [], roster: [] };
    const s = stub((m, url) => /loot-board$/.test(url) ? Promise.reject(Object.assign(new Error('not found'), { status: 404 })) : Promise.resolve(/loot$/.test(url) ? { awards: AWARDS, canEdit: true } : /signups$/.test(url) ? SIGNUPS : DETAIL));
    await G.pages.raid.load({ name: 'raid', gid: 'g1', rid: 'r1' }, gdata);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/raids/r1', '/api/guild/g1/raids/r1/signups', '/api/guild/g1/raids/r1/loot', '/api/guild/g1/raids/r1/loot-board']);
    const out = G.pages.raid.main({ name: 'raid', gid: 'g1', rid: 'r1' }, gdata);
    assert(out.includes('id="loot-h"') && out.includes('Nathrezim Mindblade'));
    s.restore();
  }));

  // ── person loot ────────────────────────────────────────────────
  const PERSON_LOOT = {
    person: { id: 'p_th', name: 'Thoren', status: 'raider' },
    awards: [
      award('b1', { raidId: 'r2', raidOn: '2026-10-11', itemName: 'Warp Slicer', itemId: 30311, awardedAt: 1791768000000, match: { kind: 'character', personId: 'p_th', personName: 'Thoren', characterName: 'Thorenalt' } }),
      award('b2', { raidId: 'r2', raidOn: '2026-10-11', itemName: 'Eye of Gruul', itemId: 28823, awardedAt: 1791767000000, tag: 'OS', flags: ['OS'] }),
      award('b3', { raidId: 'r1', raidOn: '2026-10-10' }),
      award('b4', { raidId: 'r1', raidOn: '2026-10-10', itemName: 'Primal Nether', quality: 3, awardedAt: 1791680000000 }),
      award('b5', { raidId: 'r0', raidOn: '2026-10-03', itemName: 'Brutality Blade' }),
      award('b6', { raidId: 'r0', raidOn: '2026-10-03', itemName: 'Dragonspine Trophy' }),
    ],
    totals: { MS: 5, OS: 1, DE: 0, BANK: 0 },
  };

  await check('person loot page: header, figures, one table of awards newest first with the night link, the character name and a More menu for edit holders', () => {
    const out = G.pages.personLoot.personLootHtml({ guildData: gd(OFFICER_CAN), pid: 'p_th', data: PERSON_LOOT });
    assert(/<h1 class="gs-h1[^"]*" id="page-title" tabindex="-1">Thoren<\/h1>/.test(out) && out.includes('Loot history') && out.includes('href="#/g/g1/roster/p/p_th"'));
    assert(out.includes('<dt class="gs-pr-cap">Main spec</dt><dd class="gs-pr-num">5</dd>') && out.includes('<dt class="gs-pr-cap">Off spec</dt><dd class="gs-pr-num">1</dd>') && !out.includes('Due order'), 'no standings figures without the balance');
    assert(out.includes('6 awards, newest first') && out.includes('<table class="gs-dtable" aria-label="Loot awards">'));
    assert.deepEqual([...out.matchAll(/href="(#\/g\/g1\/loot\/n\/[^"]*)"/g)].map(m => m[1]), ['r2', 'r2', 'r1', 'r1', 'r0', 'r0'].map(r => '#/g/g1/loot/n/' + r));
    assert(!out.includes('href="#/g/g1/loot/p/p_th"'), 'no link to this page');
    assert((out.match(/id="lm-b[0-9]" data-action="menu-toggle"/g) || []).length === 6 && out.includes('href="#/g/g1/loot/a/b1?edit=1"'), 'edit holders get More on every row');
    assert(!out.includes('Awards are read-only for members'));
    assertNoRawAttrs(out);
    const member = G.pages.personLoot.personLootHtml({ guildData: gd(MEMBER_CAN), pid: 'p_th', data: Object.assign({}, PERSON_LOOT, { person: Object.assign({}, PERSON_LOOT.person, { isMe: true }) }) });
    assert(!member.includes('menu-toggle') && member.includes('Awards are read-only for members. Ask an officer if something looks wrong.') && member.includes('This is your loot'));
    const empty = G.pages.personLoot.personLootHtml({ guildData: gd(OFFICER_CAN), pid: 'p_th', data: { person: { id: 'p_th', name: HOSTILE, status: 'raider' }, awards: [], totals: { MS: 0, OS: 0, DE: 0, BANK: 0 } } });
    assert(empty.includes('No loot is recorded for this person yet.'));
    assertEscaped(empty, 'person loot');
  });

  await check('person loot page: with the team balance it adds Raids, Main spec per raid and the due order, and a link to the standings', () => {
    const bal = Object.assign({}, BALANCE, { people: BALANCE.people.map(p => Object.assign({}, p, { personId: p.personId === 'p_aa' ? 'p_th' : p.personId })) });
    const standing = G.pages.personLoot.standingOf(bal, 'p_th');
    assert.deepEqual(plain(standing), { raids: 10, perRaid: 0.73, counted: 6, mode: 'perRaid', rank: 2, of: 3 });
    const out = G.pages.personLoot.personLootHtml({ guildData: gd(MEMBER_CAN), pid: 'p_th', data: PERSON_LOOT, balance: bal });
    assert(out.includes('<dt class="gs-pr-cap">Raids</dt><dd class="gs-pr-num">10</dd>') && out.includes('<dt class="gs-pr-cap">Main spec per raid</dt><dd class="gs-pr-num">0.73</dd>') && out.includes('<dt class="gs-pr-cap">Due order</dt><dd class="gs-pr-num">2nd of 3</dd>'));
    assert(out.includes('See where you stand') && out.includes('href="#/g/g1/loot/standings"'));
    assert.equal(G.pages.personLoot.standingOf(bal, 'p_nobody'), null);
    assert.equal(G.pages.personLoot.standingOf(null, 'p_th'), null);
  });

  await check('person loot card: totals, the last five awards and an All loot link; empty, own and denied wording', () => {
    const P = G.pages.personLoot;
    const gdata = gd(OFFICER_CAN);
    const record = { person: { id: 'p_th', isMe: false } };
    const out = P.cardHtml({ guildData: gdata, pid: 'p_th', record, state: { data: PERSON_LOOT, denied: false } });
    assert(out.includes('<h2 class="gs-h2" id="loot-card-h">Loot</h2>'));
    // The totals are one line in the record panel's head: "MS 5 - OS ... - DE ... - Bank ...".
    assert(/^MS 5 &middot; OS \d+ &middot; DE \d+ &middot; Bank \d+$/.test(P.sectionOf({ guildData: gdata, pid: 'p_th', record, state: { data: PERSON_LOOT, denied: false } }).metaHtml));
    assert.equal((out.match(/<li class="gs-loot-row"/g) || []).length, 5, 'the last 5 of 6');
    assert(!out.includes('Dragonspine Trophy') && out.includes('Brutality Blade'));
    assert(out.includes('<a class="gs-fg-u" href="#/g/g1/loot/p/p_th">All loot</a>'));
    assert(out.includes('href="#/g/g1/raids/r/r2"'), 'each award names its raid');
    const mine = { person: { id: 'p_th', isMe: true } };
    assert(P.cardHtml({ guildData: gdata, pid: 'p_th', record: mine, state: { data: { awards: [], totals: {} } } }).includes('Your loot shows here after your first award is imported.'));
    assert(P.cardHtml({ guildData: gdata, pid: 'p_th', record, state: { data: { awards: [], totals: {} } } }).includes('No loot is recorded for this person yet.'));
    assert(P.cardHtml({ guildData: gdata, pid: 'p_th', record, state: { denied: true, data: null } }).includes('Loot for this person is not shown to you.'));
    assert(P.cardHtml({ guildData: gdata, pid: 'p_th', record, state: null }).includes('No loot is recorded'));
  });

  await check('person loot card: loaded beside the attendance card; no grant means no card; 403 is a note; the roster person page draws it', withState(async (S) => {
    const P = G.pages.personLoot;
    const g1 = gd(OFFICER_CAN);
    let s = stub(() => Promise.resolve(PERSON_LOOT));
    await P.loadCard('g1', 'p_th', g1);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/person/p_th']);
    assert.equal(P.cardState('g1', 'p_th').data.totals.MS, 5);
    const record = { person: { id: 'p_th', isMe: false, status: 'raider', discord: {} }, characters: [], can: {}, notes: { text: '' } };
    assert(P.cardFor(g1, record, 'p_th').includes('id="loot-card-h"'));
    s.restore();
    s = stub(() => Promise.resolve(PERSON_LOOT));
    await P.loadCard('g1', 'p_th', gd({ 'roster.view': 'guild' }));
    assert.equal(s.calls.length, 1, 'can["loot.view"] is not widened by the loot policy: the card asks whatever the role says');
    assert.equal(P.cardFor(g1, record, 'p_other'), '', 'nothing loaded for another person');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await P.loadCard('g1', 'p_th', gd(MEMBER_CAN));
    assert.equal(P.cardState('g1', 'p_th').denied, true);
    assert(P.cardFor(gd(MEMBER_CAN), record, 'p_th').includes('not shown to you'));
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom' })));
    await P.loadCard('g1', 'p_th', g1);
    assert.equal(P.cardState('g1', 'p_th').denied, false, 'a server error is not a denial');
    s.restore();
    s = stub(() => Promise.resolve(PERSON_LOOT));
    await P.loadCard('g1', 'p_th', g1);
    s.restore();
    const page = G.pages.person.personHtml({ guildData: g1, record: Object.assign({ today: '2026-10-12' }, record, { person: { id: 'p_th', status: 'raider', isMe: false, discord: {}, characters: [] } }), linkable: null, alert: '', attendance: null });
    assert(page.indexOf('id="loot-card-h"') > page.indexOf('id="attendance-h"'), 'after the attendance card');
  }));

  await check('person loot page: loaded by pid, named for the crumb', withState(async (S) => {
    const g1 = gd(OFFICER_CAN);
    const s = stub(() => Promise.resolve(PERSON_LOOT));
    await G.pages.personLoot.load({ name: 'lootperson', gid: 'g1', pid: 'p_th' }, g1);
    assert.equal(s.calls[0].url, '/api/guild/g1/loot/person/p_th');
    assert.equal(G.pages.personLoot.nameFor({ pid: 'p_th' }), 'Thoren');
    assert.equal(G.pages.personLoot.nameFor({ pid: 'p_other' }), '');
    assert(G.pages.personLoot.main({ name: 'lootperson', gid: 'g1', pid: 'p_th' }, g1).includes('Loot history'));
    assert(G.pages.personLoot.main({ name: 'lootperson', gid: 'g1', pid: 'p_other' }, g1).includes('Loading'));
    assert.equal(s.calls[1].url, '/api/guild/g1/loot/balance?team=t1', 'the team balance is read for the figures');
    s.restore();
    const s3 = stub((m, url) => (/balance/.test(url) ? Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })) : Promise.resolve(PERSON_LOOT)));
    await G.pages.personLoot.load({ name: 'lootperson', gid: 'g1', pid: 'p_th' }, g1);
    assert.equal(G.app.state.att.personLoot.balance, null, 'standings the guild keeps from members just leave the figures out');
    s3.restore();
    await assert.rejects(Promise.resolve().then(() => { const s2 = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' }))); return G.pages.personLoot.load({ pid: 'p_x' }, g1).finally(() => s2.restore()); }), err => err.status === 403);
  }));

  // ── Settings > Loot ────────────────────────────────────────────
  const LOOT_DEFAULTS = { visibility: { members: 'ownTeams', standings: false, itemLookup: false }, balance: { mode: 'perRaid', countTags: ['MS'] } };
  const LOOT_VIEW = { defaults: LOOT_DEFAULTS, guild: { balance: { countTags: ['MS', 'OS'] } }, teams: { t1: { visibility: { members: 'own' } } }, resolved: {}, versions: { guild: 2, teams: { t1: 5 } } };
  const S0 = (over) => Object.assign({ gid: 'g1', view: LOOT_VIEW, scope: 'guild', draft: { balance: { countTags: ['MS', 'OS'] } } }, over || {});

  await check('settings form: guild scope shows effective values with radios and tag boxes; the team scope marks Inherited / Overridden with Reset', () => {
    const S = G.pages.settingsLoot;
    const out = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: S0() });
    assert(out.includes('Who sees loot') && out.includes('Balance') && out.includes('Members see') && out.includes('Tags that count'));
    assert(/id="lp-visibility-members-1"[^>]*value="ownTeams" checked/.test(out) && !/value="own" checked/.test(out) && !/value="guild" checked/.test(out));
    assert(/id="lp-balance-mode-0"[^>]*value="perRaid" checked/.test(out));
    assert(/value="MS" checked/.test(out) && /value="OS" checked/.test(out));
    assert(out.includes('data-change="lpol-change" data-type="radio" data-path="visibility.members"') && out.includes('data-type="checks" data-path="balance.countTags"'));
    assert(!out.includes('Inherited') && !out.includes('Overridden'), 'no markers in the guild scope');
    assert(out.includes('<option value="guild" selected>Guild default</option>') && out.includes('Team KJ override'));
    assert(out.includes('Reset to defaults') && out.includes('data-submit="lpol-form"'));
    const team = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: S0({ scope: 't1', draft: { visibility: { members: 'own' } } }) });
    assert(/id="lpf-visibility-members"[\s\S]*?Overridden[\s\S]*?data-action="lpol-reset" data-path="visibility.members"/.test(team));
    assert(/id="lpf-balance-countTags"[\s\S]*?Inherited/.test(team), 'inherits the guild tags');
    assert(/value="OS" checked/.test(team), 'the inherited value shows');
    assert(team.includes('Remove the team override') && !team.includes('data-path="balance.countTags" data-key="lpol-reset'));
    assertNoRawAttrs(out);
    assertEscaped(S.settingsHtml({ guildData: gd(OFFICER_CAN, { teams: [{ id: 't1', name: HOSTILE + QUOTES, size: 25, archived: false, players: 1, leads: [] }] }), s: S0() }), 'settings');
    assert(S.settingsHtml({ guildData: gd(OFFICER_CAN), s: S0(), alert: 'Nope.', notice: 'Loot rules saved.' }).includes('Loot rules saved.'));
  });

  await check('settings: What members see has two switches (standings, item look-up), off by default, guild default and team override with Inherited / Overridden', () => {
    const S = G.pages.settingsLoot;
    const out = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: S0() });
    assert(out.includes('What members see') && out.includes('Members always see the latest raid nights and their own loot by raid day. These two are extra.'));
    assert(out.indexOf('Who sees loot') < out.indexOf('What members see') && out.indexOf('What members see') < out.indexOf('>Balance<'));
    assert(/<input type="checkbox" id="lp-visibility-standings" value="1" data-change="lpol-change" data-type="bool" data-path="visibility.standings"/.test(out) && !/id="lp-visibility-standings"[^>]*checked/.test(out));
    assert(/<input type="checkbox" id="lp-visibility-itemLookup" value="1" data-change="lpol-change" data-type="bool" data-path="visibility.itemLookup"/.test(out) && !/id="lp-visibility-itemLookup"[^>]*checked/.test(out));
    assert(out.includes('Who is due (standings)') && out.includes('Shows members the standings and the Who is due card. Off by default.') && out.includes('Lets members search an item and see who received it. Off by default.'));
    const guildOn = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: S0({ draft: { visibility: { standings: true } } }) });
    assert(/id="lp-visibility-standings"[^>]*checked/.test(guildOn) && !/id="lp-visibility-itemLookup"[^>]*checked/.test(guildOn));
    const team = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: S0({ scope: 't1', view: Object.assign({}, LOOT_VIEW, { guild: { visibility: { itemLookup: true } } }), draft: { visibility: { standings: true } } }) });
    assert(/id="lpf-visibility-standings"[\s\S]*?Overridden[\s\S]*?data-path="visibility.standings" data-key="lpol-reset/.test(team));
    assert(/id="lpf-visibility-itemLookup"[\s\S]*?Inherited/.test(team) && /id="lp-visibility-itemLookup"[^>]*checked/.test(team), 'the guild default shows through');
    assertNoRawAttrs(out);
  });

  await check('settings switches: a switch writes a boolean into the draft, saves as a pruned override, and Reset puts a team back to the guild default', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsLoot = S0({ draft: {} });
    const done = countRenders();
    const sw = (path, checked) => ({ getAttribute: k => ({ 'data-path': path, 'data-type': 'bool' })[k], checked });
    G.handlers.change['lpol-change'](sw('visibility.standings', true));
    G.handlers.change['lpol-change'](sw('visibility.itemLookup', true));
    assert.deepEqual(plain(S.att.settingsLoot.draft), { visibility: { standings: true, itemLookup: true } });
    G.handlers.change['lpol-change'](sw('visibility.itemLookup', false));
    assert.deepEqual(plain(S.att.settingsLoot.draft), { visibility: { standings: true, itemLookup: false } });
    const origBusy = G.ui.setBusy;
    G.ui.setBusy = () => {};
    const form = { querySelectorAll: () => [], querySelector: () => null };
    let s = stub(() => Promise.resolve(Object.assign({}, LOOT_VIEW, { guild: { visibility: { standings: true } }, versions: { guild: 3, teams: {} } })));
    G.handlers.submit['lpol-form'](form);
    await tick();
    assert.deepEqual(s.calls[0].body, { teamId: null, override: { visibility: { standings: true } }, version: 2 }, 'a value equal to the built-in default is not stored');
    assert.deepEqual(plain(S.att.settingsLoot.draft), { visibility: { standings: true } }, 'the saved override is the new draft');
    s.restore();
    S.att.settingsLoot = S0({ scope: 't1', draft: { visibility: { standings: true } } });
    G.handlers.click['lpol-reset'](el({ 'data-path': 'visibility.standings' }));
    assert.deepEqual(plain(S.att.settingsLoot.draft), {});
    G.ui.setBusy = origBusy; done();
  }));

  await check('settings handlers: edits go into the draft override, Reset and Reset all clear it, tags need one box', withState(async (S) => {
    const SL = G.pages.settingsLoot;
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsLoot = S0({ scope: 't1', draft: {} });
    const done = countRenders();
    G.handlers.change['lpol-change']({ getAttribute: k => ({ 'data-path': 'visibility.members', 'data-type': 'radio' })[k], value: 'guild' });
    assert.deepEqual(plain(S.att.settingsLoot.draft), { visibility: { members: 'guild' } });
    const boxes = [{ checked: true, value: 'MS' }, { checked: true, value: 'OS' }];
    G.handlers.change['lpol-change']({ getAttribute: k => ({ 'data-path': 'balance.countTags', 'data-type': 'checks' })[k], closest: () => ({ querySelectorAll: () => boxes }) });
    assert.deepEqual(plain(S.att.settingsLoot.draft), { visibility: { members: 'guild' }, balance: { countTags: ['MS', 'OS'] } });
    G.handlers.click['lpol-reset'](el({ 'data-path': 'visibility.members' }));
    assert.deepEqual(plain(S.att.settingsLoot.draft), { balance: { countTags: ['MS', 'OS'] } });
    G.handlers.click['lpol-reset-all']();
    assert.deepEqual(plain(S.att.settingsLoot.draft), {});
    G.handlers.change['lpol-scope']({ value: 'guild' });
    assert.equal(S.att.settingsLoot.scope, 'guild');
    assert.deepEqual(plain(S.att.settingsLoot.draft), { balance: { countTags: ['MS', 'OS'] } }, 'the guild override loads into the draft');
    G.handlers.change['lpol-scope']({ value: 't1' });
    assert.deepEqual(plain(S.att.settingsLoot.draft), { visibility: { members: 'own' } });
    assert.deepEqual(plain(SL.GROUPS.map(g => g.id)), ['visibility', 'members', 'balance']);
    done();
  }));

  await check('settings save: sends { teamId, override, version }, the guild scope prunes defaults, errors land on the field, a stale version reloads', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsLoot = S0({ draft: { visibility: { members: 'ownTeams' }, balance: { mode: 'count', countTags: ['MS'] } } });
    const done = countRenders();
    const origBusy = G.ui.setBusy, origSet = G.ui.setText;
    G.ui.setBusy = () => {};
    const texts = {};
    G.ui.setText = (id, t) => { texts[id] = t; };
    const form = { querySelectorAll: () => [], querySelector: () => null };
    let s = stub(() => Promise.resolve(Object.assign({}, LOOT_VIEW, { guild: { balance: { mode: 'count' } }, versions: { guild: 3, teams: {} } })));
    G.handlers.submit['lpol-form'](form);
    await tick();
    assert.deepEqual(s.calls[0], { m: 'put', url: '/api/guild/g1/loot/policy', body: { teamId: null, override: { balance: { mode: 'count' } }, version: 2 } });
    assert.equal(S.att.settingsLoot.view.versions.guild, 3);
    assert.equal(S.att.lootPolNotice, '', 'the page head says Saved at; there is no banner');
    assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'loot');
    s.restore();

    S.att.settingsLoot = S0({ scope: 't1', draft: { visibility: { members: 'guild' } } });
    s = stub(() => Promise.resolve(LOOT_VIEW));
    G.handlers.submit['lpol-form'](form);
    await tick();
    assert.deepEqual(s.calls[0].body, { teamId: 't1', override: { visibility: { members: 'guild' } }, version: 5 });
    s.restore();

    S.att.settingsLoot = S0({ draft: { balance: { countTags: [] } } });
    s = stub(() => Promise.resolve(LOOT_VIEW));
    const docEl = { textContent: '', hidden: true, setAttribute() {}, focus() {} };
    ctx.document.getElementById = id => (id === 'lperr-balance-countTags' ? docEl : null);
    G.handlers.submit['lpol-form'](form);
    assert.equal(s.calls.length, 0, 'an empty tag list is stopped in the browser');
    assert.equal(docEl.textContent, 'Pick at least one tag to count.');
    assert.equal(docEl.hidden, false);
    s.restore();

    S.att.settingsLoot = S0({ draft: { balance: { countTags: ['MS'] } } });
    s = stub(() => Promise.reject(new G.api.ApiError(400, { error: 'invalid', message: 'Tags must be MS or OS.', field: 'balance.countTags' })));
    docEl.textContent = ''; docEl.hidden = true;
    G.handlers.submit['lpol-form'](form);
    await tick();
    assert.equal(docEl.textContent, 'Tags must be MS or OS.');
    assert.equal(docEl.hidden, false);
    s.restore();

    const current = Object.assign({}, LOOT_VIEW, { guild: { visibility: { members: 'guild' } }, versions: { guild: 9, teams: {} } });
    s = stub(() => Promise.reject(new G.api.ApiError(409, { error: 'stale', message: 'Changed.', current })));
    G.handlers.submit['lpol-form'](form);
    await tick();
    assert.equal(S.att.settingsLoot.view.versions.guild, 9);
    assert(/Someone else changed these settings/.test(S.pageAlert));
    s.restore();
    ctx.document.getElementById = () => null;
    G.ui.setBusy = origBusy; G.ui.setText = origSet; done();
  }));

  await check('settings load: reads GET /loot/policy, keeps the scope across a reload, main frames it as the Loot tab', withState(async (S) => {
    const g1 = gd(OFFICER_CAN);
    const s = stub(() => Promise.resolve(Object.assign({}, LOOT_VIEW, { resolved: { t1: LOOT_DEFAULTS } })));
    await G.pages.settingsLoot.load({ name: 'settings', gid: 'g1', tab: 'loot' }, g1);
    assert.equal(s.calls[0].url, '/api/guild/g1/loot/policy');
    S.att.settingsLoot.scope = 't1';
    await G.pages.settingsLoot.load({ name: 'settings', gid: 'g1', tab: 'loot' }, g1);
    assert.equal(S.att.settingsLoot.scope, 't1');
    const ctxShell = { section: 'guild', page: 'app', route: { name: 'settings', gid: 'g1', tab: 'loot' }, guildData: g1, teamId: 't1' };
    const out = G.pages.settingsLoot.main({ name: 'settings', gid: 'g1', tab: 'loot' }, g1, ctxShell);
    assert(out.includes('Guild settings') && /href="#\/g\/g1\/settings\/loot" aria-current="page">Loot</.test(out) && out.includes('Team KJ override'));
    s.restore();
  }));

  // ── review queue: loot winners ─────────────────────────────────
  const LOOT_RAID = { awards: [
    award('u1', { winner: { name: 'Veyla', realm: 'Ashmere', class: 'MAGE' }, match: { kind: 'unmatched' } }),
    award('u2', { winner: { name: 'Veyla', realm: 'Ashmere', class: 'MAGE' }, match: { kind: 'unmatched' }, itemId: 2 }),
    award('u3', { winner: { name: 'Ruvik', realm: null, class: 'SHAMAN' }, match: { kind: 'unmatched' } }),
    award('u4', {}), award('u5', { match: { kind: 'guest' } }),
  ] };

  await check('review: a loot winner from the review reply is an unmatched item (key + awards) the existing actions and evidence line take', () => {
    const list = [
      { kind: 'unmatched', key: 'veyla|ashmere', name: 'Veyla', realm: 'Ashmere', class: 'MAGE', awards: 2 },
      { kind: 'unmatched', key: 'ruvik|ashmere', name: 'Ruvik', realm: null, class: 'SHAMAN', awards: 1 },
    ];
    assert(G.pages.review.isUnmatched(list[0]), 'the existing unmatched actions take them');
    assert.equal(G.pages.review.unmatchedEvidence(list[0]), 'Mage on Ashmere, won 2 items, no linked person');
    assert.equal(G.pages.review.unmatchedEvidence(list[1]), 'Shaman, won 1 item, no linked person', 'a realm-less name shows no realm');
    assert.equal(G.pages.review.unmatchedEvidence({ name: 'X', class: 'DRUID', realm: 'R', pullsPresent: 4 }), 'Druid on R, in 4 pulls, no linked person', 'the attendance wording is unchanged');
  });

  const LOOT_GROUPS = [
    { raid: { id: 'r1', raidOn: '2026-10-10', zone: 'Gruul', title: null }, items: [{ kind: 'unmatched', key: 'veyla|ashmere', name: 'Veyla', realm: 'Ashmere', class: 'MAGE', awards: 2 }, { kind: 'unmatched', key: 'ruvik|firemaw', name: 'Ruvik', realm: 'Firemaw', class: 'SHAMAN', awards: 1 }] },
    { raid: { id: 'r2', raidOn: '2026-10-11', zone: 'BT', title: null }, items: [] },
  ];
  const REVIEW = { team: 't1', raids: [{ raid: { id: 'r1', raidOn: '2026-10-10', zone: 'Gruul' }, items: [{ playerId: 'p_a', name: 'Aimers', class: 'HUNTER', flags: ['no_show'], signup: 'signed', pulls: { total: 0 } }, { key: 'x|y', name: 'Xan', realm: 'Y', class: 'MAGE', pullsPresent: 3 }] }], stale: [] };
  const reviewOpts = over => Object.assign({ guildData: gd(OFFICER_CAN), teamId: 't1', data: REVIEW, lootGroups: LOOT_GROUPS, filter: 'all' }, over || {});

  await check('review page: a "Loot winners not on the roster" section per raid with Link / Add as new person / Mark as guest; the filter and counts', () => {
    const out = G.pages.review.reviewHtml(reviewOpts());
    assert(out.includes('Sat Oct 10 - Loot winners not on the roster') && !out.includes('Sun Oct 11 - Loot winners'), 'a raid with no winners has no section');
    assert(out.includes('2 open flags on 1 raid - 2 loot winners to link'));
    const section = out.slice(out.indexOf('Loot winners not on the roster'));
    assert(section.includes('Veyla') && section.includes('Mage on Ashmere, won 2 items, no linked person'));
    for (const act of ['unm-link', 'unm-person', 'unm-guest']) assert((section.match(new RegExp('data-action="' + act + '" data-rid="r1" data-ukey="', 'g')) || []).length === 2, act);
    assert(section.includes('data-ukey="veyla|ashmere"') && section.includes('data-ukey="ruvik|firemaw"') && section.includes('data-where="review"'));
    assert(section.includes('href="#/g/g1/raids/r/r1"'));
    assert(out.includes('>Loot winners<'), 'a filter option');
    const onlyLoot = G.pages.review.reviewHtml(reviewOpts({ filter: 'loot' }));
    assert(onlyLoot.includes('Loot winners not on the roster') && !onlyLoot.includes('Aimers') && !onlyLoot.includes('No flags of that type'));
    const noShow = G.pages.review.reviewHtml(reviewOpts({ filter: 'no_show' }));
    assert(!noShow.includes('Loot winners not on the roster') && noShow.includes('Aimers'));
    const onlyLootData = G.pages.review.reviewHtml(reviewOpts({ data: { team: 't1', raids: [], stale: [] } }));
    assert(!onlyLootData.includes('Nothing to review') && onlyLootData.includes('Veyla'), 'loot winners alone are something to review');
    const none = G.pages.review.reviewHtml(reviewOpts({ data: { team: 't1', raids: [], stale: [] }, lootGroups: [] }));
    assert(none.includes('Nothing to review'));
    assert(!G.pages.review.reviewHtml(reviewOpts({ lootGroups: null })).includes('Loot winners not on the roster'));
    assertNoRawAttrs(out);
    const hostile = G.pages.review.reviewHtml(reviewOpts({ lootGroups: [{ raid: { id: 'r1', raidOn: '2026-10-10' }, items: [{ kind: 'unmatched', key: 'a|b', name: HOSTILE, realm: QUOTES, class: 'MAGE', awards: 1 }] }] }));
    assertEscaped(hostile, 'review loot');
  });

  await check('review load: the loot winners arrive with the review reply (lootUnmatched), no request of their own, nothing derived; a reply without them is fine', withState(async (S) => {
    const g1 = gd(OFFICER_CAN);
    S.guilds.g1 = g1; S.currentGid = 'g1';
    const realTeamFor = ctx.Guild.app.teamFor;
    ctx.Guild.app.teamFor = () => 't1';
    let s = stub(() => Promise.resolve(Object.assign({}, REVIEW, { lootUnmatched: LOOT_GROUPS })));
    await G.pages.review.load(null, g1);
    assert.deepEqual(s.calls.map(c => c.url).filter(u => !u.endsWith('/claims')), ['/api/guild/g1/attendance/review?team=t1']);
    assert.deepEqual(plain(S.att.review.loot), plain(LOOT_GROUPS));
    assert(G.pages.review.main({ name: 'review', gid: 'g1' }, g1).includes('Loot winners not on the roster'));
    s.restore();
    s = stub(() => Promise.resolve(REVIEW));
    await G.pages.review.load(null, g1);
    assert.deepEqual(plain(S.att.review.loot), [], 'a viewer without loot.edit gets an empty list');
    assert(!G.pages.review.main({ name: 'review', gid: 'g1' }, g1).includes('Loot winners not on the roster'));
    s.restore();
    ctx.Guild.app.teamFor = realTeamFor;
  }));

  await check('review actions: the link, new person and guest dialogs open for a loot winner and post the winner key to the raid', withState(async (S) => {
    const g1 = gd(OFFICER_CAN);
    S.guilds.g1 = g1; S.currentGid = 'g1';
    S.att.review = { gid: 'g1', teamId: 't1', data: REVIEW, loot: LOOT_GROUPS, filter: 'all' };
    const opened = [];
    const realOpen = G.ui.openDialog, realRun = G.ui.runDialog;
    G.ui.openDialog = html => { opened.push(html); return null; };
    G.handlers.click['unm-guest'](el({ 'data-where': 'review', 'data-rid': 'r1', 'data-ukey': 'veyla|ashmere' }));
    assert(opened[0].includes('Mark Veyla as a guest') && opened[0].includes('data-key="veyla|ashmere"') && opened[0].includes('data-rid="r1"') && opened[0].includes('loot balance'));
    G.handlers.click['unm-person'](el({ 'data-where': 'review', 'data-rid': 'r1', 'data-ukey': 'ruvik|firemaw' }));
    assert(opened[1].includes('Add Ruvik as a new person') && opened[1].includes('value="2026-10-10"'), 'Joined starts at the raid date');
    const s = stub((m, url) => Promise.resolve({ people: [{ id: 'p_t', status: 'raider', main: { name: 'Thoren', class: 'PALADIN' } }] }));
    G.handlers.click['unm-link'](el({ 'data-where': 'review', 'data-rid': 'r1', 'data-ukey': 'veyla|ashmere' }, { disabled: false }));
    await tick();
    assert.equal(s.calls[0].url, '/api/guild/g1/roster?team=t1', 'the raid\'s team roster');
    assert(opened[2].includes('Link Veyla to a person') && opened[2].includes('won 2 items'));
    s.restore();
    const realRender = G.app.render;
    G.app.render = () => {};
    const posts = stub((m, url, body) => Promise.resolve({ staleRaids: 1, attendanceFlags: {} }));
    G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    G.handlers.submit['unm-guest-form']({ getAttribute: k => ({ 'data-rid': 'r1', 'data-key': 'veyla|ashmere', 'data-name': 'Veyla', 'data-where': 'review' })[k] });
    await tick();
    assert.deepEqual(posts.calls[0], { m: 'post', url: '/api/guild/g1/raids/r1/unmatched', body: { key: 'veyla|ashmere', action: 'guest' } });
    posts.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun; G.app.render = realRender;
  }));

  // ── disenchants: an award nobody won ───────────────────────────
  // The Worker answers match.kind 'disenchanted', winner { name: null, realm: null, class: null } and the tag DE.
  const DE_AWARD = award('d1', { itemId: 22520, itemName: "The Phylactery of Kel'Thuzad", awardedAt: 1791774300000, winner: { name: null, realm: null, class: null }, match: { kind: 'disenchanted' }, tag: 'DE', rollType: null });

  await check('disenchants: the winner column reads Disenchanted (no link, no chip, no name); the tag is the DE chip even for an editor', () => {
    const L = G.pages.loot;
    assert.equal(L.isDisenchanted(DE_AWARD), true);
    assert.equal(L.isDisenchanted(AWARDS[0]), false);
    assert.equal(L.isDisenchanted(null), false);
    const winner = L.winnerHtml('g1', DE_AWARD.winner, DE_AWARD.match);
    assert.equal(stripTags(winner), 'Disenchanted');
    assert(!winner.includes('href') && !winner.includes('gs-chip') && !winner.includes('null'));
    const editor = L.awardRowHtml(gd(OFFICER_CAN), DE_AWARD, { when: 'time' });
    assert(stripTags(editor).includes('Disenchanted') && editor.includes('>DE<'));
    assert(!editor.includes('<select') && !editor.includes('data-action'), 'the row builder is read-only: awards change on the night and award pages');
    assert(editor.includes('href="https://www.wowhead.com/tbc/item=22520"') && editor.includes('Kel&#39;Thuzad'), 'the item is still linked and escaped');
    const viewer = L.awardRowHtml(gd(MEMBER_CAN), DE_AWARD, { when: 'time' });
    assert(stripTags(viewer).includes('Disenchanted') && viewer.includes('>DE<') && !viewer.includes('data-action'));
    // The person pages show a character, never a disenchant, but the row builder must not break on one.
    assert(stripTags(L.awardRowHtml(gd(OFFICER_CAN), DE_AWARD, { character: true, when: 'date' })).includes('Disenchanted'));
    // Hostile text in the item name stays escaped on a disenchant.
    assertEscaped(L.awardRowHtml(gd(OFFICER_CAN), Object.assign({}, DE_AWARD, { itemName: HOSTILE, note: HOSTILE + QUOTES }), {}), 'disenchant');
  });

  await check('disenchants: the raid card lists them, counts them as items and not as winners off the roster; the delete dialog names the item; the preview labels the row', withState(async (S) => {
    const state = okState();
    state.data.awards = AWARDS.concat([DE_AWARD]);
    const out = raidPage(state);
    assert(out.includes('5 items') && (out.match(/<li class="gs-loot-subrow"/g) || []).length === 5 && out.includes('3 MS &middot; 1 OS &middot; 1 DE'));
    assert(stripTags(out).includes('Disenchanted'));
    assert(out.includes('1 award goes to a winner who is not on the roster'), 'only Veyla; the disenchant is nobody\'s');
    assert(!out.includes('2 awards go to a winner'));
    // The delete dialog does not say "awarded to null".
    const del = G.pages.raidLoot.deleteDialogHtml(DE_AWARD, 'x');
    assert(del.includes('Delete this award?') && del.includes("The Phylactery of Kel&#39;Thuzad (disenchanted) is removed") && !del.includes('awarded to'), del);
    // A refused row of a paste is named as a disenchant, not "to null".
    const R = G.pages.raidLoot;
    const parsed = { awards: [{ itemName: 'Warp Slicer', itemId: 9, winnerName: null, disenchanted: true }, { itemName: null, itemId: 10, winnerName: null, disenchanted: true }], awardRows: [3, 5] };
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Award 1: x', field: 'awards', index: 0 }), parsed), 'Row 3 of the paste (Warp Slicer (disenchanted)) was refused: x');
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Award 2: x', field: 'awards', index: 1 }), parsed), 'Row 5 of the paste (item 10 (disenchanted)) was refused: x');
    assert(!/null/.test(R.describeError(new G.api.ApiError(400, { message: 'Award 2: x', field: 'awards', index: 1 }), parsed)));
  }));

  // ── Raid night, item, More menu ────────────────────────────────
  const nightState = (over, canEdit) => Object.assign({ gid: 'g1', rid: 'r1', teamId: 't1', status: 'ok', awards: AWARDS.concat([DE_AWARD]).map(a => Object.assign({}, a)), canEdit: canEdit !== false,
    raid: { raidOn: '2026-10-10', title: 'Gruul run', zone: 'Gruul' }, saved: {} }, over || {});
  const nightPage = (state, can) => G.pages.lootNight.nightHtml({ guildData: gd(can || OFFICER_CAN), state });
  const menuLabels = html => [...html.matchAll(/class="gs-menu-item[^"]*"[^>]*>([^<]*)</g)].map(m => m[1]);

  await check('raid night: header with counts, a table of awards, a tag select and a More menu per row for edit holders', () => {
    const out = nightPage(nightState());
    assert(out.includes('>Sat Oct 10</h1>') && out.includes('Gruul run - Gruul - Team KJ - 5 awards - 3 main spec, 1 off spec, 1 disenchanted'));
    assert(out.includes('class="gs-back-link" href="#/g/g1/loot"'));
    assert(out.includes('<table class="gs-dtable" aria-label="Loot awarded on Sat Oct 10">') && (out.match(/data-row="/g) || []).length === 5);
    assert((out.match(/data-change="ln-tag"/g) || []).length === 4, 'a select per row except the disenchant');
    assert(out.includes('data-change="ln-tag" data-aid="a3"') && out.includes('Officer tag') && out.includes('>Guest<') && out.includes('Not on roster') && out.includes('Disenchanted'));
    assert((out.match(/id="lm-[a-z0-9]+" data-action="menu-toggle"/g) || []).length === 5 && out.includes('aria-label="More for Nathrezim Mindblade"'));
    assert(out.includes('href="#/g/g1/loot/a/a1"') && out.includes('href="#/g/g1/loot/a/a1?edit=1"') && out.includes('data-action="ln-delete" data-aid="a1"'));
    assert.deepEqual(plain(menuLabels(out).slice(2, 5)), ['Open award', 'Edit details', 'Delete award']);
    assert(!/id="lm-[a-z0-9]+-list"/.test(out.replace(/class="gs-menu gs-menu-list" id="lm-/g, '')), 'a row menu sits in the last column and opens leftward (not is-left)');
    assert(out.includes('href="#/g/g1/raids/r/r1"') && out.includes('Open the raid page') && out.includes('Import from Gargul'));
    assert(out.includes('All 5 awards, in the order they were awarded.'));
    assertNoRawAttrs(out);
  });

  await check('raid night: members read it; no select, no More menu, no import link; the raid page link stays', () => {
    const out = nightPage(nightState({ canEdit: false }), MEMBER_CAN);
    assert(!out.includes('data-change="ln-tag"') && !out.includes('id="lm-') && !out.includes('Delete award') && !out.includes('Import from Gargul'));
    assert(out.includes('Open the raid page') && out.includes('class="gs-lt-tag"') && !out.includes('gs-chip-tag') && out.includes('Disenchanted'));
  });

  await check('raid label: a title that already ends with the zone is not followed by the zone again', () => {
    assert.equal(G.pages.loot.raidLabel({ title: 'Team KJ Saturday - Black Temple', zone: 'Black Temple' }), 'Team KJ Saturday - Black Temple');
    assert.equal(G.pages.loot.raidLabel({ title: 'Gruul run', zone: 'Gruul' }), 'Gruul run - Gruul');
    assert.equal(G.pages.loot.raidLabel({ title: null, zone: 'Gruul' }), 'Gruul');
  });

  await check('raid night: nothing recorded, a 403 and a 404 each have their own wording; hostile text is escaped', () => {
    const empty = nightPage(nightState({ awards: [] }));
    assert(empty.includes('No loot recorded') && empty.includes('Import a Gargul export on the raid page'));
    assert(nightPage(nightState({ awards: [], canEdit: false }), MEMBER_CAN).includes('Nothing was awarded on this night.'));
    assert(/You can(&#39;|')t see this loot/.test(nightPage({ status: 'denied' }, MEMBER_CAN)));
    assert(nightPage({ status: 'none' }).includes('No loot on this night'));
    const bad = nightState({ awards: [award('x1', { itemName: HOSTILE, note: HOSTILE + QUOTES, winner: { name: HOSTILE, realm: null, class: 'MAGE' }, match: { kind: 'unmatched' } })], raid: { raidOn: '2026-10-10', title: HOSTILE, zone: HOSTILE } });
    assertEscaped(nightPage(bad), 'night');
  });

  await check('raid night load: the awards, then the night\'s date and title from the raid list; 403 and 404 are states; other errors surface', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    const route = { name: 'lootnight', gid: 'g1', rid: 'r1' };
    let s = stub((m, url) => Promise.resolve(/\/raids\/r1\/loot$/.test(url) ? { awards: AWARDS, canEdit: true } : RAIDS));
    await G.pages.lootNight.load(route, gdata);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/raids/r1/loot', '/api/guild/g1/loot/raids?team=t1']);
    assert.equal(G.pages.lootNight.nameFor(route), 'Sat Oct 10');
    assert(G.pages.lootNight.main(route, gdata).includes('Gruul'));
    assert(G.pages.lootNight.main({ name: 'lootnight', gid: 'g1', rid: 'other' }, gdata).includes('Loading'));
    s.restore();
    s = stub((m, url) => (/loot\/raids/.test(url) ? Promise.reject(new G.api.ApiError(500, { error: 'x' })) : Promise.resolve({ awards: AWARDS, canEdit: false })));
    await G.pages.lootNight.load(route, gdata);
    assert.equal(G.app.state.att.lootNight.status, 'ok', 'the page works without the raid list');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await G.pages.lootNight.load(route, gdata);
    assert.equal(G.app.state.att.lootNight.status, 'denied');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(404, { error: 'not_found' })));
    await G.pages.lootNight.load(route, gdata);
    assert.equal(G.app.state.att.lootNight.status, 'none');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom' })));
    await assert.rejects(G.pages.lootNight.load(route, gdata), err => err.status === 500);
    s.restore();
  }));

  await check('raid night tag select: a tag-only PATCH, the row shows Saved, a failure shows the page alert', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    S.att.lootNight = nightState();
    const realRender = G.app.render, realHandle = G.app.handleError;
    let rendered = 0;
    const handled = [];
    G.app.render = () => { rendered++; };
    G.app.handleError = (err, o) => handled.push([err.status, o]);
    let s = stub((m, url, body) => Promise.resolve({ award: Object.assign({}, AWARDS[1], { tag: body.tag, tagSetBy: 'officer' }) }));
    const sel = Object.assign(el({ 'data-aid': 'a2' }), { value: 'OS' });
    G.handlers.change['ln-tag'](sel);
    assert.equal(sel.disabled, true);
    await tick();
    assert.deepEqual(s.calls[0], { m: 'patch', url: '/api/guild/g1/loot/a2', body: { tag: 'OS' } });
    assert.equal(S.att.lootNight.awards[1].tag, 'OS');
    assert.deepEqual(plain(S.att.lootNight.saved), { a2: true });
    const out = nightPage(S.att.lootNight);
    assert(/data-aid="a2"[\s\S]*?<span class="gs-lt-saved" role="status">Saved<\/span>/.test(out) && (out.match(/>Saved</g) || []).length === 1);
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(409, { error: 'stale' })));
    G.handlers.change['ln-tag'](Object.assign(el({ 'data-aid': 'a1' }), { value: 'DE' }));
    await tick();
    assert.equal(handled.length, 1); assert.equal(handled[0][1].pageAlert, true);
    s.restore();
    G.app.render = realRender; G.app.handleError = realHandle;
  }));

  await check('raid night delete: the More menu item opens the in-app confirm; confirming deletes and drops the row (also on the person page)', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    S.att.lootNight = nightState();
    S.att.personLoot = { gid: 'g1', pid: 'p_th', data: { person: PERSON_LOOT.person, awards: [AWARDS[1]], totals: PERSON_LOOT.totals } };
    const realOpen = G.ui.openDialog, realRun = G.ui.runDialog, realRender = G.app.render;
    const opened = [];
    G.ui.openDialog = html => { opened.push(html); return null; };
    G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    G.app.render = () => {};
    G.handlers.click['ln-delete'](el({ 'data-aid': 'a2' }));
    assert(opened[0].includes('Delete this award?') && opened[0].includes('Warp Slicer awarded to Kaelith-Ashmere') && opened[0].includes('data-submit="ln-delete-form"') && opened[0].includes('data-aid="a2"') && opened[0].includes('gs-btn-danger'));
    G.handlers.click['ln-delete'](el({ 'data-aid': 'nope' }));
    assert.equal(opened.length, 1);
    const s = stub(() => Promise.resolve({ ok: true }));
    G.handlers.submit['ln-delete-form']({ getAttribute: () => 'a2' });
    await tick();
    assert.deepEqual(s.calls[0], { m: 'del', url: '/api/guild/g1/loot/a2', body: {} });
    assert.deepEqual(S.att.lootNight.awards.map(a => a.id), ['a1', 'a3', 'a4', 'd1']);
    assert.equal(S.att.personLoot.data.awards.length, 0);
    s.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun; G.app.render = realRender;
  }));

  const ITEM_DATA = { team: { id: 't1', name: 'Team KJ' }, item: { itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 }, counts: { total: 4, MS: 3, OS: 1, DE: 0, BANK: 0 }, drops: [
    Object.assign(award('i1', { raidId: 'r2', raidOn: '2026-10-11' }), { raidTitle: 'BT clear' }), Object.assign(award('i2', { raidId: 'r2', raidOn: '2026-10-11' }), { raidTitle: 'BT clear' }),
    Object.assign(award('i3', { raidId: 'r1', raidOn: '2026-10-10', tag: 'OS', winner: { name: 'Kaelith', realm: 'Ashmere', class: 'ROGUE' }, match: { kind: 'unmatched' } }), { raidTitle: null }),
    Object.assign(award('i4', { raidId: 'r0', raidOn: '2026-10-03', winner: { name: 'Dorrin', realm: 'Ashmere', class: 'PRIEST' }, match: { kind: 'guest' } }), { raidTitle: null })] };
  const itemPage = (state, can) => G.pages.lootItem.itemHtml({ guildData: gd(can || OFFICER_CAN), state });

  await check('item page: header counts, drops over time, who has it with times, tags and nights; the duplicate chip is for edit holders', () => {
    const out = itemPage({ status: 'ok', itemId: '28770', data: ITEM_DATA });
    assert(out.includes('>Nathrezim Mindblade</h1>') && out.includes('4 awards on 3 raid nights - last dropped Sun Oct 11'));
    assert(out.includes('<dt class="gs-pr-cap">Awards</dt><dd class="gs-pr-num">4</dd>') && out.includes('<dt class="gs-pr-cap">Main spec</dt><dd class="gs-pr-num">3</dd>') && out.includes('<dt class="gs-pr-cap">Off spec</dt><dd class="gs-pr-num">1</dd>') && out.includes('<dt class="gs-pr-cap">Raid nights</dt><dd class="gs-pr-num">3</dd>'));
    const over = out.slice(out.indexOf('aria-label="Awards per night"'));
    assert(over.indexOf('Sat Oct 3') < over.indexOf('Sat Oct 10') && over.indexOf('Sat Oct 10') < over.indexOf('Sun Oct 11'), 'oldest night first in the drops list');
    assert(out.includes('aria-label="Who has Nathrezim Mindblade"') && out.includes('href="#/g/g1/loot/n/r2"') && out.includes('Possible duplicate'));
    assert(out.includes('To fix an award, open its raid night and use More.') && out.includes('Review in Needs fixing') && out.includes('href="#/g/g1/loot/fix"'));
    const member = itemPage({ status: 'ok', itemId: '28770', data: ITEM_DATA }, MEMBER_CAN);
    assert(!member.includes('Possible duplicate') && !member.includes('Review in Needs fixing') && !member.includes('To fix an award'));
    assertEscaped(itemPage({ status: 'ok', itemId: '1', data: Object.assign({}, ITEM_DATA, { item: { itemId: 1, itemName: HOSTILE, quality: 4 } }) }), 'item');
    assertNoRawAttrs(out);
  });

  await check('item page: 404 reads "Nobody has received that item yet.", 403 says look-up is off; load reads the item route per team', withState(async (S) => {
    assert(itemPage({ status: 'none' }).includes('Nobody has received that item yet.'));
    assert(/Your guild doesn(&#39;|')t let members look up items\./.test(itemPage({ status: 'denied' }, MEMBER_CAN)));
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    const realTeamFor = ctx.Guild.app.teamFor;
    ctx.Guild.app.teamFor = () => 't1';
    const route = { name: 'lootitem', gid: 'g1', itemId: '28770' };
    let s = stub(() => Promise.resolve(ITEM_DATA));
    await G.pages.lootItem.load(route, gdata);
    assert.equal(s.calls[0].url, '/api/guild/g1/loot/items/28770?team=t1');
    assert.equal(G.pages.lootItem.nameFor(route), 'Nathrezim Mindblade');
    assert(G.pages.lootItem.main(route, gdata).includes('Who has it'));
    assert(G.pages.lootItem.main({ name: 'lootitem', gid: 'g1', itemId: '1' }, gdata).includes('Loading'));
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(404, { error: 'not_found' })));
    await G.pages.lootItem.load(route, gdata);
    assert.equal(G.app.state.att.lootItem.status, 'none');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await G.pages.lootItem.load(route, gdata);
    assert.equal(G.app.state.att.lootItem.status, 'denied');
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom' })));
    await assert.rejects(G.pages.lootItem.load(route, gdata), err => err.status === 500);
    s.restore();
    ctx.Guild.app.teamFor = realTeamFor;
  }));

  await check('award record and Needs fixing: routed to their own pages (guild-loot-award-tests.js covers them)', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    assert(!G.pages.lootAward.main({ name: 'lootaward', gid: 'g1', aid: 'a1' }, S.guilds.g1).includes('Not built yet'));
    assert(!G.pages.lootFix.main({ name: 'lootfix', gid: 'g1' }, S.guilds.g1).includes('Not built yet'));
  }));

  // ── Link / Add as new person for a winner whose class nobody knows ──
  const CLASS_IDS = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'];
  const classOptionsOf = html => [...html.slice(html.indexOf('id="unm-class"')).split('</select>')[0].matchAll(/<option value="([A-Z]*)"/g)].map(m => m[1]);

  await check('review dialogs: Link and Add as new person ask for the class (a required select of the nine) when the name has none; a known class asks nothing; guests never', () => {
    const R = G.pages.review;
    const known = { kind: 'unmatched', key: 'veyla|ashmere', name: 'Veyla', realm: 'Ashmere', class: 'MAGE', awards: 2 };
    const unknown = { kind: 'unmatched', key: 'classless|ashmere', name: 'Classless', realm: 'Ashmere', class: null, awards: 1 };
    const gdata = gd(OFFICER_CAN);
    const people = [{ id: 'p_t', status: 'raider', main: { name: 'Thoren', class: 'PALADIN' } }];
    const link = unm => R.linkDialogHtml({ unm, people, raidId: 'r1', where: 'review', guildData: gdata });
    const person = unm => R.personDialogHtml({ unm, raidId: 'r1', raidOn: '2026-10-10', where: 'review', guildData: gdata });
    for (const [label, html] of [['link', link(unknown)], ['person', person(unknown)]]) {
      assert(/<select class="gs-input" id="unm-class" name="class" data-field="class" aria-describedby="unm-class-help">/.test(html), label);
      assert(html.includes('<label class="gs-label" for="unm-class">Class (required)</label>') && html.includes('id="dlg-err-class" role="alert" hidden'), label);
      assert.deepEqual(classOptionsOf(html), [''].concat(CLASS_IDS), label + ': a placeholder and the nine classes');
      assert(html.includes('>Pick a class<') && html.includes('Neither the loot nor the log says which class Classless plays.'), label);
      assert(!/id="unm-class"[^>]*required/.test(html), label + ': the page checks it, the browser does not (novalidate)');
      assertNoRawAttrs(html);
    }
    for (const html of [link(known), person(known), link({ kind: 'unmatched', key: 'a|b', name: 'Ruvik', class: 'SHAMAN', awards: 1 })]) {
      assert(!html.includes('unm-class') && !html.includes('name="class"'));
    }
    assert(!R.guestDialogHtml({ unm: unknown, raidId: 'r1', where: 'review' }).includes('unm-class'));
    // No guild data (a render outside a loaded guild) still offers the nine classes; a hostile name is escaped.
    assert.deepEqual(classOptionsOf(R.personDialogHtml({ unm: unknown, raidId: 'r1', raidOn: '2026-10-10', where: 'review' })), [''].concat(CLASS_IDS));
    assertEscaped(person(Object.assign({}, unknown, { name: HOSTILE })), 'class field');
    assertEscaped(link(Object.assign({}, unknown, { name: QUOTES })), 'class field');
    // The roster option list of the guild wins when it has one.
    const custom = gd(OFFICER_CAN, { rosterOptions: { classes: [{ id: 'MAGE', name: 'Mage' }, { id: 'DRUID', name: 'Druid' }], specs: {}, roles: {} } });
    assert.deepEqual(classOptionsOf(R.personDialogHtml({ unm: unknown, raidId: 'r1', raidOn: '2026-10-10', where: 'review', guildData: custom })), ['', 'MAGE', 'DRUID']);
  });

  await check('review actions: a name without a class is sent with the class picked in the dialog; none picked says so and sends nothing; a known class sends none', withState(async (S) => {
    const g1 = gd(OFFICER_CAN);
    S.guilds.g1 = g1; S.currentGid = 'g1';
    const groups = [{ raid: { id: 'r1', raidOn: '2026-10-10', zone: 'Gruul', title: null }, items: [
      { kind: 'unmatched', key: 'classless|ashmere', name: 'Classless', realm: 'Ashmere', class: null, awards: 1 },
      { kind: 'unmatched', key: 'veyla|ashmere', name: 'Veyla', realm: 'Ashmere', class: 'MAGE', awards: 2 },
    ] }];
    S.att.review = { gid: 'g1', teamId: 't1', data: REVIEW, loot: groups, filter: 'all' };
    const opened = [];
    const realOpen = G.ui.openDialog, realRun = G.ui.runDialog, realSet = G.ui.setText, realRender = G.app.render;
    G.ui.openDialog = html => { opened.push(html); return null; };
    G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    G.app.render = () => {};
    const errs = {};
    G.ui.setText = (id, text) => { errs[id] = text; };
    // The dialogs open with the select for Classless only.
    G.handlers.click['unm-person'](el({ 'data-where': 'review', 'data-rid': 'r1', 'data-ukey': 'classless|ashmere' }));
    G.handlers.click['unm-person'](el({ 'data-where': 'review', 'data-rid': 'r1', 'data-ukey': 'veyla|ashmere' }));
    assert(opened[0].includes('id="unm-class"') && !opened[1].includes('id="unm-class"'));

    const focused = [];
    const classSelect = value => ({ value, focus() { focused.push('class'); } });
    const personForm = (key, name, cls) => ({
      getAttribute: k => ({ 'data-rid': 'r1', 'data-key': key, 'data-name': name, 'data-where': 'review' })[k],
      elements: Object.assign({ joinedOn: { value: '2026-10-10', focus() {} }, status: { value: 'raider' } }, cls === undefined ? {} : { class: classSelect(cls) }),
    });
    const s = stub(() => Promise.resolve({ staleRaids: 0, attendanceFlags: {} }));
    const posts = () => s.calls.filter(c => c.m === 'post');   // a write reloads the review queue with a GET
    // Nothing picked: a message next to the select, focus on it, no request.
    G.handlers.submit['unm-person-form'](personForm('classless|ashmere', 'Classless', ''));
    await tick();
    assert.equal(posts().length, 0);
    assert(/class/i.test(errs['dlg-err-class']) && errs['dlg-err-class'].length > 5, errs['dlg-err-class']);
    assert.deepEqual(focused, ['class']);
    // Picked: the class goes with the request, and the message is cleared.
    G.handlers.submit['unm-person-form'](personForm('classless|ashmere', 'Classless', 'MAGE'));
    await tick();
    assert.equal(errs['dlg-err-class'], '');
    assert.deepEqual(posts()[0], { m: 'post', url: '/api/guild/g1/raids/r1/unmatched', body: { key: 'classless|ashmere', action: 'person', status: 'raider', joinedOn: '2026-10-10', class: 'MAGE' } });
    // A known class: the dialog has no select, and the body has no class.
    G.handlers.submit['unm-person-form'](personForm('veyla|ashmere', 'Veyla'));
    await tick();
    assert.deepEqual(posts()[1].body, { key: 'veyla|ashmere', action: 'person', status: 'raider', joinedOn: '2026-10-10' });

    // Link: the same, with the person picked and "make Main" optional.
    const linkForm = (key, name, cls, makeMain) => ({
      getAttribute: k => ({ 'data-rid': 'r1', 'data-key': key, 'data-name': name, 'data-where': 'review' })[k],
      querySelector: () => ({ value: 'p_t', getAttribute: () => 'Thoren' }),
      elements: Object.assign({ makeMain: { checked: !!makeMain } }, cls === undefined ? {} : { class: classSelect(cls) }),
    });
    G.handlers.submit['unm-link-form'](linkForm('classless|ashmere', 'Classless', ''));
    await tick();
    assert.equal(posts().length, 2, 'no request without a class');
    assert(/class/i.test(errs['dlg-err-class']));
    G.handlers.submit['unm-link-form'](linkForm('classless|ashmere', 'Classless', 'DRUID', true));
    await tick();
    assert.deepEqual(posts()[2].body, { key: 'classless|ashmere', action: 'alt', personId: 'p_t', makeMain: true, class: 'DRUID' });
    G.handlers.submit['unm-link-form'](linkForm('veyla|ashmere', 'Veyla'));
    await tick();
    assert.deepEqual(posts()[3].body, { key: 'veyla|ashmere', action: 'alt', personId: 'p_t' });
    s.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun; G.ui.setText = realSet; G.app.render = realRender;
  }));

  await check('raid page: coming back to a raid starts the import panel afresh (no stale "done" result); the card\'s Try again keeps it', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    const R = G.pages.raidLoot;
    const detailFor = rid => Object.assign({}, DETAIL, { raid: Object.assign({}, DETAIL.raid, { id: rid }) });
    const s = stub((m, url) => Promise.resolve(/loot$/.test(url) ? { awards: AWARDS, canEdit: true } : detailFor(url.split('/').pop())));
    const view = { name: 'raid', gid: 'g1', rid: 'r1' };
    await G.pages.raid.load(view, gdata);
    // The officer imports: the panel ends on its result line.
    const first = R.stateFor('g1', 'r1');
    Object.assign(first.ui, { open: true, stage: 'done', result: { inserted: 8, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 5 }, text: 'old paste' });
    assert(G.pages.raid.main(view, gdata).includes('Imported 8 new awards.'), 'the result shows while the officer is on the page');
    // They leave and come back to the same raid: the route loads the page again.
    await G.pages.raid.load(view, gdata);
    const again = R.stateFor('g1', 'r1');
    assert.notEqual(again.ui, first.ui);
    assert.deepEqual(plain(again.ui), plain(R.freshUi()), 'closed, input stage, nothing pasted, no result');
    const html = G.pages.raid.main(view, gdata);
    assert(!html.includes('Imported 8 new awards.') && !html.includes('id="gl-result"') && !html.includes('gl-title'), 'the old result is gone');
    assert(html.includes('data-action="loot-import-open"'), 'the Import button is back');
    // Another raid does not inherit it either.
    Object.assign(again.ui, { open: true, stage: 'done', result: { inserted: 1 } });
    await G.pages.raid.load({ name: 'raid', gid: 'g1', rid: 'r2' }, gdata);
    assert.deepEqual(plain(R.stateFor('g1', 'r2').ui), plain(R.freshUi()));
    // Try again (a failed load of the awards) reloads the awards and leaves the panel alone.
    await G.pages.raid.load(view, gdata);
    const open = R.stateFor('g1', 'r1');
    Object.assign(open.ui, { open: true, text: 'half typed' });
    G.pages.attendance.attState().raid = { gid: 'g1', rid: 'r1', data: DETAIL };
    const realRender = G.app.render;
    G.app.render = () => {};
    G.handlers.click['loot-reload']();
    await tick();
    G.app.render = realRender;
    assert.equal(R.stateFor('g1', 'r1').ui, open.ui, 'the same panel object');
    assert.deepEqual([R.stateFor('g1', 'r1').ui.open, R.stateFor('g1', 'r1').ui.text], [true, 'half typed']);
    s.restore();
  }));

  // ── pages and safety ───────────────────────────────────────────
  await check('safety: the loot scripts have no inline styles or handlers, no non-ASCII characters, and their script tags are on all three pages in list order', () => {
    const names = ['gargul', 'pages-loot', 'pages-person-loot', 'pages-loot-hub', 'pages-loot-night', 'pages-raid-loot', 'pages-settings-loot'];
    for (const n of names) {
      const f = 'js/guild/' + n + '.js';
      read(f).split('\n').forEach((line, i) => {
        assert(!/[\s`'"]style\s*=\s*(?:["'`\\]|\$\{)/.test(line), `${f}:${i + 1} inline style`);
        assert(!/[\s`'"]on[a-z]{3,}\s*=\s*(?:["'`\\]|\$\{)/i.test(line), `${f}:${i + 1} inline handler`);
        assert(!/setAttribute\(\s*['"`](?:style|on[a-z]+)['"`]/i.test(line), `${f}:${i + 1} setAttribute`);
        if (!/^\s*\/\//.test(line)) assert(!/[^\x00-\x7f]/.test(line), `${f}:${i + 1} non-ASCII`);
      });
    }
    const tail = GUILD_SCRIPTS.map(s => s.replace(/^\//, ''));
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) {
      const html = read(page);
      assert(!html.includes('pages-empty.js'), page + ' no longer loads the stub');
      const loaded = guildScriptsOf(html);
      let at = -1;
      for (const n of names) {
        const idx = loaded.indexOf('/js/guild/' + n + '.js');
        assert(idx >= 0, `${page} ${n}`);
        assert(idx > at, `${page} ${n} is in list order`);
        at = idx;
      }
    }
    assert(tail.indexOf('js/guild/gargul.js') < tail.indexOf('js/guild/pages-raid-loot.js'), 'the parser loads before the page that calls it');
    assert(!fs.existsSync(path.join(ROOT, 'js/guild/pages-empty.js')));
  });

  await check('safety: the loot code only ever calls the contract routes (every path in the pages comes from G.api.loot)', () => {
    const src = ['pages-loot', 'pages-person-loot', 'pages-loot-hub', 'pages-loot-night', 'pages-raid-loot', 'pages-settings-loot'].map(n => read('js/guild/' + n + '.js')).join('\n');
    assert(!/G\.api\.(get|post|put|patch|del)\(/.test(src), 'loot pages go through G.api.loot, not raw paths');
    // The loot block of api.js (the sign-up and schedule calls after it have their own routes and their own suite).
    const api = read('js/guild/api.js');
    const lootBlock = api.slice(api.indexOf('G.api.loot = {'), api.indexOf('// Every sign-up and raid-schedule call'));
    const paths = [...lootBlock.matchAll(/guildPath\(gid, '([^']*)'/g)].map(m => m[1]);
    assert(paths.length >= 9, 'the loot block was found');
    const contract = ['/raids/', '/loot/', '/loot/balance', '/loot/raids', '/loot/items', '/loot/person/', '/loot/policy'];
    for (const p of paths) assert(contract.some(c => p.startsWith(c)), 'unknown route ' + p);
  });

  // ── Fix batch 1: unpinned You row, Standings tie-break ──
  await check('F1: the viewer\'s row in Standings keeps its sorted place with the tint and the You tag', withState(async () => {
    resetUi();
    const me = Object.assign({}, BALANCE, { people: BALANCE.people.map(p => Object.assign({}, p, { isMe: p.personId === 'p_aa' })) });
    const out = G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'ok', teamId: 't1', data: me } }));
    assert.deepEqual(standNames(out), ['Zzaps', 'Aimersmay', 'Oldtimer', 'Newbie'], 'lowest per raid first; the viewer (Aimersmay) is second, not first');
    assert(out.includes('gs-dtable-row is-you') && (out.match(/class="gs-you"/g) || []).length === 1);
    assert(/is-you[^>]*data-row="p_aa"/.test(out), 'the tint is on the viewer\'s own row');
  }));

  await check('F4: Most due first = lowest per raid, then MORE raids attended first, then name; the reverse sort mirrors it', withState(async () => {
    const L = G.pages.loot;
    const rows = [
      person('a', 'Cara', 'MAGE', 4, 1, 0, 2, 0.5), person('b', 'Abel', 'MAGE', 9, 1, 0, 2, 0.5), person('c', 'Bree', 'MAGE', 9, 1, 0, 2, 0.5),
      person('d', 'Dina', 'MAGE', 2, 1, 0, 1, 0.1), person('e', 'Emil', 'MAGE', 0, 0, 0, 0, null),
    ];
    const bal = L.balanceRows({ people: rows }, 'window');
    const names = list => list.map(r => r.name);
    assert.deepEqual(names(G.pages.lootHub.dueOrder(bal, 'perRaid')), ['Dina', 'Abel', 'Bree', 'Cara', 'Emil'], 'Dina lowest; the 0.5 tie: 9 raids (Abel, Bree by name) before 4; no figure last');
    assert.deepEqual(names(L.sortRows(bal, { column: 'perRaid', dir: 'desc' })), ['Cara', 'Abel', 'Bree', 'Dina', 'Emil'], 'mirrored: highest first, then the FEWEST raids, then name; no figure still last');
    assert.deepEqual(names(L.sortRows(bal, { column: 'perRaid', dir: 'asc' })), names(G.pages.lootHub.dueOrder(bal, 'perRaid')), 'ascending is the due order');
    assert.deepEqual(names(L.sortRows(bal, { column: 'counted', dir: 'asc' })), ['Emil', 'Dina', 'Abel', 'Bree', 'Cara'], 'counted: the same tie rule (equal counts: more raids first)');
    const standing = G.pages.personLoot.standingOf({ mode: 'perRaid', countTags: ['MS'], window: { weeks: 8 }, people: rows }, 'a');
    assert.equal(standing.rank, 4, 'the person page\'s due rank follows the same order');
  }));

  // F5: every Loot page is on Forge: the root carries gs-forge, its sections are the one panel (gs-hd-panel), and the old card looks are gone.
  await check('F5: every Loot page root has gs-forge and its sections are gs-hd-panel (loading, empty and denied states too); no chip per line, no row edges', withState(async () => {
    const root = html => (html.match(/^<div class="([^"]*)"/) || [])[1] || '';
    const pages = {
      'hub (officer)': hubPage(OFFICER_HUB(), OFFICER_CAN, { balance: BALANCE }),
      'hub (member)': hubPage(hubData()),
      'hub (denied)': G.pages.lootHub.hubHtml({ guildData: gd(MEMBER_CAN), state: { status: 'denied', teamId: 't1' } }),
      'standings': G.pages.lootStandings.standingsHtml(standOpts()),
      'standings (denied)': G.pages.lootStandings.standingsHtml(standOpts({ state: { status: 'denied', teamId: 't1' } })),
      'raid night': nightPage(nightState()),
      'raid night (denied)': nightPage({ gid: 'g1', rid: 'r1', status: 'denied' }),
      'item': itemPage({ status: 'ok', itemId: '28770', data: ITEM_DATA }),
      'item (none)': itemPage({ status: 'none', itemId: '1' }),
      'person loot': G.pages.personLoot.personLootHtml({ guildData: gd(OFFICER_CAN), pid: 'p_th', data: PERSON_LOOT }),
      'loading': G.pages.loot.loadingHtml('Loot'),
    };
    Object.keys(pages).forEach(name => {
      const html = pages[name];
      assert(/\bgs-forge\b/.test(root(html)), name + ' root has gs-forge: ' + root(html));
      assert(!/gs-card-sec|gs-osection(?!-bare)|gs-empty-card|gs-lhub|gs-ln-/.test(html), name + ' uses no old card or section look');
      assert(!/class="gs-dtable-row[^"]*has-mark|--mark/.test(html), name + ' draws no row edge');
      assert(!/gs-chip-tag/.test(html), name + ' shows the tag as a word, not a chip');
    });
    ['hub (officer)', 'hub (member)', 'standings', 'raid night', 'item', 'person loot'].forEach(name => assert(/<(section|div) class="gs-hd-panel/.test(pages[name]), name + ' sections are gs-hd-panel'));
    ['hub (denied)', 'standings (denied)', 'raid night (denied)', 'item (none)'].forEach(name => assert(/<section class="gs-hd-panel gs-rs-state/.test(pages[name]), name + ' state is a gs-hd-panel'));
    assert(pages.loading.includes('aria-busy="true"') && pages.loading.includes('gs-hd-sk') && pages.loading.includes('role="status"'));
    assert((pages['raid night'].match(/gs-hd-chip/g) || []).length <= 2, 'the night shows chips only for exceptions (Guest / Not on roster / Edited), never one per line');
    assert(G.pages.raidLoot.deleteDialogHtml({ id: 'a1', itemName: 'X', winner: { name: 'Y' } }).includes('class="gs-dialog-form gs-forge"'), 'the delete dialog carries gs-forge');
  }));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
