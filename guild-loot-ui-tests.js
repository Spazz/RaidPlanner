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
    assert.deepEqual(p('#/g/g1/loot?view=raids'), { name: 'section', gid: 'g1', section: 'loot', view: 'raids' });
    assert.deepEqual(p('#/g/g1/loot?view=items'), { name: 'section', gid: 'g1', section: 'loot', view: 'items' });
    assert.deepEqual(p('#/g/g1/loot?view=balance'), { name: 'section', gid: 'g1', section: 'loot' }, 'Balance is the default and has no parameter');
    assert.deepEqual(p('#/g/g1/loot?view=bogus'), { name: 'section', gid: 'g1', section: 'loot' });
    assert.deepEqual(p('#/g/g1/raids?view=items'), { name: 'section', gid: 'g1', section: 'raids' }, 'the view belongs to Loot');
    assert.deepEqual(p('#/g/g1/loot/p/p_1'), { name: 'lootperson', gid: 'g1', pid: 'p_1' });
    assert.deepEqual(p('#/g/g1/settings/loot'), { name: 'settings', gid: 'g1', tab: 'loot' });
    for (const bad of ['#/g/g1/loot/p', '#/g/g1/loot/p/a/b', '#/g/g1/loot/p/<x>', '#/g/g1/loot/x', '#/g/g1/loot/p/p_1/extra', '#/g/g1/loot/raids', '#/g/g1/settings/loots']) {
      assert.equal(p(bad).name, 'notfound', bad);
    }
    for (const r of [{ name: 'section', gid: 'g1', section: 'loot' }, { name: 'section', gid: 'g1', section: 'loot', view: 'raids' }, { name: 'section', gid: 'g1', section: 'loot', view: 'items' }, { name: 'lootperson', gid: 'g1', pid: 'p_1' }, { name: 'settings', gid: 'g1', tab: 'loot' }]) {
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
      { m: 'get', url: '/api/guild/g1/loot/policy' },
      { m: 'put', url: '/api/guild/g1/loot/policy', body: { teamId: null, override: { visibility: { members: 'guild' } }, version: 3 } },
      { m: 'put', url: '/api/guild/g1/loot/policy', body: { teamId: 't1', override: {}, version: 0 } },
    ]);
    s.restore();
    await L.raid('g/1', 'r 1').catch(() => {});
  });

  // ── vocabulary ─────────────────────────────────────────────────
  await check('items: quality colour class, Wowhead link by game version (tbc, classic; none for others), escaped names', () => {
    const L = G.pages.loot;
    assert.equal(L.itemUrl('tbc', 28770), 'https://www.wowhead.com/tbc/item=28770');
    assert.equal(L.itemUrl('classic', 28770), 'https://www.wowhead.com/classic/item=28770');
    assert.equal(L.itemUrl('forever', 28770), null);
    assert.equal(L.itemUrl('tbc', 0), null);
    const tbc = L.itemHtml({ itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 }, 'tbc');
    assert(tbc.includes('class="gs-item gs-q-4"') && tbc.includes('href="https://www.wowhead.com/tbc/item=28770"') && tbc.includes('rel="noopener noreferrer"') && tbc.includes('target="_blank"'));
    const forever = L.itemHtml({ itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 }, 'forever');
    assert(forever.startsWith('<span class="gs-item gs-q-4">') && !forever.includes('href'));
    assert(L.itemHtml({ itemId: 5 }, 'tbc').includes('>Item 5<'), 'no name: the id');
    assert(L.itemHtml({}, 'tbc').includes('Unknown item'));
    assert(!L.itemHtml({ itemId: 5, itemName: 'X', quality: 9 }, 'tbc').includes('gs-q-'), 'an unknown quality has no colour class');
    assert(!L.itemHtml({ itemId: 5, itemName: 'X', quality: null }, 'tbc').includes('gs-q-'));
    const hostile = L.itemHtml({ itemId: 5, itemName: HOSTILE + QUOTES, quality: 4 }, 'tbc');
    assertEscaped(hostile, 'item');
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
    assert(select.includes('data-change="loot-tag"') && select.includes('data-aid="a3"'));
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
  const pageOpts = (over, can) => Object.assign({ guildData: gd(can || OFFICER_CAN), teamId: 't1', view: 'balance', data: BALANCE, ui: { sort: null, window: null } }, over || {});
  const rowNames = html => [...html.matchAll(/<th scope="row" class="gs-cell-strong">(.*?)<\/th>/g)].map(m => stripTags(m[1]).replace('Inactive', ''));

  await check('balance: header, view switch, window switch from the team, rules line, average, table with sortable columns and aria-sort', () => {
    const out = G.pages.loot.lootHtml(pageOpts());
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Loot</h1>') && out.includes('Team KJ - 4 people'));
    assert(out.indexOf('data-action="loot-view"') < out.indexOf('data-action="loot-window"') && out.indexOf('data-action="loot-window"') < out.indexOf('class="gs-table-wrap gs-loot-table"') && out.includes('class="gs-listbar"'), 'the view switch and the window switch are the T1 segment bar, above the table');
    for (const [v, pressed] of [['balance', 'true'], ['raids', 'false'], ['items', 'false']]) assert(out.includes('data-action="loot-view" data-view="' + v + '"') && new RegExp('data-view="' + v + '" data-key="lview-' + v + '" aria-pressed="' + pressed + '"').test(out), v);
    for (const [w, pressed] of [['8', 'true'], ['12', 'false'], ['all', 'false']]) assert(new RegExp('data-window="' + w + '" data-key="lwin-' + w + '" aria-pressed="' + pressed + '"').test(out), w);
    assert(out.includes('Last 8 full reset weeks since Aug 18, 2026.') && out.includes('Counted items: MS.'));
    assert(out.includes('Team average per raid') && out.includes('>0.49<'));
    for (const col of ['name', 'raids', 'ms', 'os', 'counted', 'perRaid', 'vs']) assert(out.includes('data-action="loot-sort" data-col="' + col + '"'), col);
    assert(/aria-sort="descending"><button[^>]*data-col="perRaid"/.test(out), 'ranked by per raid, highest first');
    assert.equal((out.match(/aria-sort=/g) || []).length, 1);
    assert(out.includes('<table class="gs-table gs-table-loot" aria-label="Loot balance">') && out.includes('<ul class="gs-loot-cards" aria-label="Loot balance">'), 'table and phone cards');
    assertNoRawAttrs(out);
  });

  await check('balance: rows ranked by per raid, a person with no raids last, inactive marked; figures and the signed difference', () => {
    const out = G.pages.loot.lootHtml(pageOpts());
    assert.deepEqual(rowNames(out), ['Oldtimer', 'Aimersmay', 'Zzaps', 'Newbie']);
    const row = out.slice(out.indexOf('Aimersmay'), out.indexOf('</tr>', out.indexOf('Aimersmay')));
    assert.deepEqual([...row.matchAll(/<td class="gs-nowrap gs-num">(.*?)<\/td>/g)].map(m => m[1]), ['8', '5', '2', '5', '0.63', '+0.14']);
    const zz = out.slice(out.indexOf('Zzaps'), out.indexOf('</tr>', out.indexOf('Zzaps')));
    assert(zz.includes('>-0.32<'), 'below the average');
    const newbie = out.slice(out.indexOf('Newbie'), out.indexOf('</tr>', out.indexOf('Newbie')));
    assert.deepEqual([...newbie.matchAll(/<td class="gs-nowrap gs-num">(.*?)<\/td>/g)].map(m => m[1]), ['0', '0', '0', '0', '-', '-'], 'zero raids: no per raid, no difference');
    assert(out.includes('gs-chip gs-chip-plain">Inactive<'));
    assert(out.includes('href="#/g/g1/loot/p/p_aa"'), 'names link to the person loot page');
  });

  await check('balance: All time reads the all-time figures and the all-time average; sorting by every column, empty values last', () => {
    const L = G.pages.loot;
    const out = L.lootHtml(pageOpts({ ui: { sort: null, window: 'all' } }));
    assert(out.includes('All time. Counted items') && out.includes('>0.55<') && /data-window="all" data-key="lwin-all" aria-pressed="true"/.test(out) && /data-window="8" data-key="lwin-8" aria-pressed="false"/.test(out));
    const row = out.slice(out.indexOf('Aimersmay'), out.indexOf('</tr>', out.indexOf('Aimersmay')));
    assert.deepEqual([...row.matchAll(/<td class="gs-nowrap gs-num">(.*?)<\/td>/g)].map(m => m[1]), ['10', '6', '2', '6', '0.73', '+0.18']);
    const names = sort => rowNames(L.lootHtml(pageOpts({ ui: { sort, window: null } })));
    assert.deepEqual(names({ column: 'name', dir: 'asc' }), ['Aimersmay', 'Newbie', 'Oldtimer', 'Zzaps']);
    assert.deepEqual(names({ column: 'name', dir: 'desc' }), ['Zzaps', 'Oldtimer', 'Newbie', 'Aimersmay']);
    assert.deepEqual(names({ column: 'raids', dir: 'desc' }), ['Aimersmay', 'Zzaps', 'Oldtimer', 'Newbie']);
    assert.deepEqual(names({ column: 'ms', dir: 'asc' }), ['Newbie', 'Zzaps', 'Oldtimer', 'Aimersmay']);
    assert.deepEqual(names({ column: 'os', dir: 'desc' }), ['Aimersmay', 'Oldtimer', 'Newbie', 'Zzaps']);
    assert.deepEqual(names({ column: 'counted', dir: 'desc' }), ['Aimersmay', 'Oldtimer', 'Zzaps', 'Newbie']);
    assert.deepEqual(names({ column: 'perRaid', dir: 'asc' }), ['Zzaps', 'Aimersmay', 'Oldtimer', 'Newbie'], 'empty last in either direction');
    assert.deepEqual(names({ column: 'vs', dir: 'desc' }), ['Oldtimer', 'Aimersmay', 'Zzaps', 'Newbie']);
    assert.deepEqual(plain(L.nextSort({ column: 'perRaid', dir: 'desc' }, 'perRaid')), { column: 'perRaid', dir: 'asc' });
    assert.deepEqual(plain(L.nextSort({ column: 'perRaid', dir: 'asc' }, 'name')), { column: 'name', dir: 'asc' });
    assert.deepEqual(plain(L.nextSort(null, 'ms')), { column: 'ms', dir: 'desc' });
    assert.deepEqual(plain(L.defaultSort('count')), { column: 'counted', dir: 'desc' });
    assert.deepEqual(plain(L.defaultSort('perRaid')), { column: 'perRaid', dir: 'desc' });
  });

  await check('balance: plain counts mode drops the per-raid columns and ranks by counted; counted tags are named', () => {
    const data = Object.assign({}, BALANCE, { mode: 'count', countTags: ['MS', 'OS'] });
    const out = G.pages.loot.lootHtml(pageOpts({ data }));
    assert(!out.includes('data-col="perRaid"') && !out.includes('data-col="vs"') && !out.includes('Team average per raid'));
    assert(out.includes('data-col="raids"') && out.includes('data-col="counted"'));
    assert(/aria-sort="descending"><button[^>]*data-col="counted"/.test(out));
    assert(out.includes('Counted items: MS and OS. People are ranked by how many they have counted.'));
    assert.deepEqual(rowNames(out), ['Aimersmay', 'Oldtimer', 'Zzaps', 'Newbie']);
  });

  await check('balance: scope own shows one row, the team average and the notice; empty and denied states differ for editors and members', () => {
    const own = Object.assign({}, BALANCE, { scope: 'own', people: [BALANCE.people[0]] });
    const out = G.pages.loot.lootHtml(pageOpts({ data: own }, MEMBER_CAN));
    assert(out.includes('You see your own loot only') && out.includes('Team average per raid') && rowNames(out).length === 1);
    const empty = Object.assign({}, BALANCE, { people: [] });
    const editor = G.pages.loot.lootHtml(pageOpts({ data: empty }));
    assert(editor.includes('No loot yet') && editor.includes('Import from Gargul') && editor.includes('href="#/g/g1/raids"') && !editor.includes('<table'));
    const member = G.pages.loot.lootHtml(pageOpts({ data: empty }, MEMBER_CAN));
    assert(member.includes('No loot yet') && member.includes('your officers import') && !member.includes('Open Raids'));
    const noAwards = Object.assign({}, BALANCE, { people: [person('p_x', 'Xena', 'MAGE', 3, 0, 0, 0, 0)].map(p => { p.items.MS.all = 0; p.counted.all = 0; return p; }) });
    assert(G.pages.loot.lootHtml(pageOpts({ data: noAwards })).includes('No loot yet'), 'people but no awards at all');
    const denied = G.pages.loot.lootHtml(pageOpts({ denied: true, data: null }, MEMBER_CAN));
    assert(denied.includes('You can&#39;t see this team&#39;s loot') || denied.includes('You can\'t see this team\'s loot'));
    assert(denied.includes('Team KJ') && !denied.includes('<table'));
  });

  await check('balance: a hostile player name and a hostile team name are escaped', () => {
    const data = Object.assign({}, BALANCE, { people: [person('p_h', HOSTILE + QUOTES, 'MAGE', 4, 1, 1, 1, 0.25)] });
    const g = gd(OFFICER_CAN, { teams: [{ id: 't1', name: HOSTILE, size: 25, archived: false, players: 1, leads: [] }, { id: 't2', name: 'Other', size: 25, archived: false, players: 1, leads: [] }] });
    const out = G.pages.loot.lootHtml(pageOpts({ data, guildData: g }));
    assertEscaped(out, 'balance');
    assertNoRawAttrs(out);
  });

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

  await check('by raid: one row per raid linking to the raid page, counts, a chip for winners not on the roster; phone cards; empty state', () => {
    const out = G.pages.loot.lootHtml(pageOpts({ view: 'raids', data: RAIDS }));
    assert(/data-view="raids" data-key="lview-raids" aria-pressed="true"/.test(out) && !out.includes('data-action="loot-window"'));
    assert(out.includes('href="#/g/g1/raids/r/r2"') && out.includes('Sun Oct 11') && out.includes('BT clear - Black Temple') && out.includes('2 winners not on the roster'));
    assert(out.includes('<td>Gruul</td>') && out.includes('<span class="gs-muted">-</span>'));
    assert(out.includes('<ul class="gs-loot-cards" aria-label="Loot by raid">') && out.includes('<table class="gs-table gs-table-lootraids"'));
    assert(G.pages.loot.lootHtml(pageOpts({ view: 'raids', data: { raids: [] } })).includes('No loot yet'));
    assertNoRawAttrs(out);
  });

  await check('by item: an expandable row per item with its awards (raid link, winner, tag); unknown names and zero awards still render', () => {
    const out = G.pages.loot.lootHtml(pageOpts({ view: 'items', data: ITEMS }));
    assert(out.includes('<ul class="gs-loot-items" aria-label="Loot by item">') && (out.match(/<details class="gs-loot-item">/g) || []).length === 2);
    assert(out.includes('class="gs-item gs-q-4"') && out.includes('2 awards &middot; last Oct 10, 2026'));
    assert(out.includes('href="#/g/g1/raids/r/r2"') && out.includes('Sun Oct 11') && out.includes('>Thoren<') && out.includes('Not on roster') && out.includes('is-de'));
    assert(out.includes('>Item 5<') && out.includes('1 award') && out.includes('No awards listed.'));
    assert(G.pages.loot.lootHtml(pageOpts({ view: 'items', data: { items: [] } })).includes('No loot yet'));
    assertEscaped(G.pages.loot.lootHtml(pageOpts({ view: 'items', data: { items: [Object.assign({}, ITEMS.items[0], { itemName: HOSTILE })] } })), 'items');
    assertNoRawAttrs(out);
  });

  // ── Loot section: loading and handlers ─────────────────────────
  await check('loot load: the view decides the call; 403 is the denied state; a rejected week count falls back to the default; a team change resets the window', withState(async (S) => {
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    const realTeamFor = ctx.Guild.app.teamFor;
    ctx.Guild.app.teamFor = () => 't1';
    const L = G.pages.loot;
    let s = stub((m, url) => Promise.resolve(/balance/.test(url) ? BALANCE : /raids/.test(url) ? RAIDS : ITEMS));
    await L.load({ name: 'section', gid: 'g1', section: 'loot' }, gdata);
    await L.load({ name: 'section', gid: 'g1', section: 'loot', view: 'raids' }, gdata);
    await L.load({ name: 'section', gid: 'g1', section: 'loot', view: 'items' }, gdata);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/balance?team=t1', '/api/guild/g1/loot/raids?team=t1', '/api/guild/g1/loot/items?team=t1']);
    assert.equal(G.app.state.att.loot.view, 'items');
    assert(L.main({ name: 'section', gid: 'g1', section: 'loot' }, gdata).includes('Loading'), 'the data is for another view: loading');
    assert(L.main({ name: 'section', gid: 'g1', section: 'loot', view: 'items' }, gdata).includes('Loot by item'));
    s.restore();

    G.app.state.att.lootUi.window = 12;
    s = stub((m, url) => (/weeks=12/.test(url) ? Promise.reject(new G.api.ApiError(400, { error: 'invalid', field: 'weeks' })) : Promise.resolve(BALANCE)));
    await L.load({ name: 'section', gid: 'g1', section: 'loot' }, gdata);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/balance?team=t1&weeks=12', '/api/guild/g1/loot/balance?team=t1']);
    assert.equal(G.app.state.att.lootUi.window, null);
    s.restore();

    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await L.load({ name: 'section', gid: 'g1', section: 'loot' }, gdata);
    assert.equal(G.app.state.att.loot.denied, true);
    assert(/You can(&#39;|')t see this team(&#39;|')s loot/.test(L.main({ name: 'section', gid: 'g1', section: 'loot' }, gdata)));
    s.restore();

    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom' })));
    await assert.rejects(L.load({ name: 'section', gid: 'g1', section: 'loot' }, gdata), err => err.status === 500);
    s.restore();

    G.app.state.att.lootUi.window = 12;
    ctx.Guild.app.teamFor = () => 't2';
    s = stub(() => Promise.resolve(BALANCE));
    await L.load({ name: 'section', gid: 'g1', section: 'loot' }, gdata);
    assert.equal(s.calls[0].url, '/api/guild/g1/loot/balance?team=t2', 'a window belongs to one team');
    s.restore();
    ctx.Guild.app.teamFor = realTeamFor;
  }));

  await check('loot handlers: the view buttons navigate, the window buttons refetch (All time does not), sort toggles', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const went = [];
    const realGo = G.app.go, realRoute = G.app.routeAll, realRender = G.app.render;
    let routed = 0, rendered = 0;
    G.app.go = h => went.push(h); G.app.routeAll = () => { routed++; return Promise.resolve(); }; G.app.render = () => { rendered++; };
    G.handlers.click['loot-view'](el({ 'data-view': 'raids' }));
    G.handlers.click['loot-view'](el({ 'data-view': 'items' }));
    G.handlers.click['loot-view'](el({ 'data-view': 'balance' }));
    assert.deepEqual(went, ['#/g/g1/loot?view=raids', '#/g/g1/loot?view=items', '#/g/g1/loot']);
    G.handlers.click['loot-window'](el({ 'data-window': '12' }));
    assert.equal(G.app.state.att.lootUi.window, 12);
    assert.equal(routed, 1);
    G.handlers.click['loot-window'](el({ 'data-window': 'all' }));
    assert.equal(G.app.state.att.lootUi.window, 'all');
    assert.equal(routed, 1, 'All time needs no request');
    assert.equal(rendered, 1);
    G.app.state.att.loot = { gid: 'g1', data: BALANCE };
    G.handlers.click['loot-sort'](el({ 'data-col': 'name' }));
    assert.deepEqual(plain(G.app.state.att.lootUi.sort), { column: 'name', dir: 'asc' });
    G.handlers.click['loot-sort'](el({ 'data-col': 'name' }));
    assert.deepEqual(plain(G.app.state.att.lootUi.sort), { column: 'name', dir: 'desc' });
    G.handlers.click['loot-sort'](el({ 'data-col': 'ms' }));
    assert.deepEqual(plain(G.app.state.att.lootUi.sort), { column: 'ms', dir: 'desc' });
    G.app.go = realGo; G.app.routeAll = realRoute; G.app.render = realRender;
  }));

  // ── the Loot card of a raid ────────────────────────────────────
  await check('raid card: award rows with time in the guild zone, quality item link, winner chips, tag select for editors, flag chips, note, delete', () => {
    const out = raidPage(okState());
    assert(out.includes('<h2 class="gs-h2" id="loot-h">Loot awards</h2>') && out.includes('4 items'));
    assert(out.includes('<ul class="gs-loot-list" aria-label="Loot awarded on this raid">') && (out.match(/<li class="gs-loot-row"/g) || []).length === 4);
    assert(out.includes('8:12 PM CT') && out.includes('8:20 PM CT'), 'times in America/Chicago, with the zone written');
    assert(out.includes('class="gs-item gs-q-4"') && out.includes('href="https://www.wowhead.com/tbc/item=28770"') && out.includes('class="gs-item gs-q-3"'));
    assert(out.includes('data-change="loot-tag" data-aid="a3"') && !/<span class="gs-loot-tag"><span class="gs-sr">Tag: <\/span><span class="gs-chip gs-chip-tag"/.test(out), 'editors get selects');
    assert(out.includes('Prio') && out.includes('Soft-res') && out.includes('Off-spec roll') && !/>TMB</.test(out.slice(out.indexOf('a1')).split('a2')[0]));
    assert(out.includes('Note: Rolled off-spec') && out.includes('>Edit note<') && out.includes('>Add note<'));
    assert(out.includes('data-action="loot-delete" data-aid="a1"') && out.includes('aria-label="Delete the award of Nathrezim Mindblade"'));
    assert(out.includes('>Guest<') && out.includes('Not on roster'));
    assert(out.indexOf('Loot awards</h2>') > out.indexOf('People</h2>'), 'after the People card');
    assertNoRawAttrs(out);
  });

  await check('raid card: editors get Import from Gargul; viewers get chips and no edit controls; the review link needs attendance.review', () => {
    const editor = raidPage(okState());
    assert(editor.includes('data-action="loot-import-open"') && editor.includes('Import from Gargul'));
    assert(editor.includes('1 award goes to a winner who is not on the roster. Link them in the Review queue') && editor.includes('href="#/g/g1/attendance/review"'));
    const viewerState = okState({}, false);
    const viewer = raidPage(viewerState, MEMBER_CAN, { data: Object.assign({}, DETAIL, { can: { edit: false, review: false, seeAttendance: true } }) });
    assert(!viewer.includes('loot-import-open') && !viewer.includes('data-change="loot-tag"') && !viewer.includes('loot-delete') && !viewer.includes('loot-note'));
    assert(viewer.includes('gs-chip gs-chip-tag is-os') && viewer.includes('Off-spec roll'), 'a tag chip with the officer-set look');
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
    assert.deepEqual(plain(R.mergeCommit({ inserted: 1, updated: 1, unchanged: 1, skippedOtherRaid: 1, skippedOtherDay: 1 }, { inserted: 2, updated: 0, unchanged: 5 })), { inserted: 3, updated: 1, unchanged: 6, skippedOtherRaid: 1, skippedOtherDay: 1 });
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
    assert.deepEqual(plain(x.ui.result), { inserted: 1201, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 3 });
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
    assert.deepEqual(plain(x.ui.result), { inserted: 6, updated: 1, unchanged: 2, skippedOtherRaid: 1, skippedOtherDay: 3 });
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
    assert(L.lootHtml(pageOpts({ data })).includes('>+0.14<'), 'shown with two decimals');
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
  await check('edit: a tag change sends only the tag, replaces the award from the reply, and a failure shows the page alert', withState(async (S) => {
    const x = raidSetup(S);
    const done = countRenders();
    let s = stub(() => Promise.resolve({ award: Object.assign({}, AWARDS[0], { tag: 'DE', tagSetBy: 'officer' }) }));
    const sel = { value: 'DE', disabled: false, getAttribute: k => ({ 'data-aid': 'a1' })[k] };
    G.handlers.change['loot-tag'](sel);
    await tick();
    assert.deepEqual(s.calls[0], { m: 'patch', url: '/api/guild/g1/loot/a1', body: { tag: 'DE' } });
    assert.deepEqual([x.data.awards[0].tag, x.data.awards[0].tagSetBy, x.data.awards.length], ['DE', 'officer', 4]);
    s.restore();
    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'No.' })));
    const realHandle = G.app.handleError;
    let handled = null;
    G.app.handleError = (err, o) => { handled = [err.status, o]; };
    G.handlers.change['loot-tag'](Object.assign({}, sel, { disabled: false }));
    await tick();
    assert.deepEqual(plain(handled), [403, { pageAlert: true }]);
    G.app.handleError = realHandle; s.restore(); done();
  }));

  await check('edit: the note dialog is filled from the award, trims, caps at 200 characters and clears with an empty note; delete asks first', withState(async (S) => {
    const x = raidSetup(S);
    const done = countRenders();
    const opened = [];
    const realOpen = G.ui.openDialog, realRun = G.ui.runDialog, realSet = G.ui.setText;
    G.ui.openDialog = html => { opened.push(html); return null; };
    G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    const errs = {};
    G.ui.setText = (id, text) => { errs[id] = text; };
    G.handlers.click['loot-note'](el({ 'data-aid': 'a3' }));
    assert(opened[0].includes('data-submit="loot-note-form"') && opened[0].includes('data-aid="a3"') && opened[0].includes('value="Rolled off-spec"') && opened[0].includes('maxlength="200"'));
    assert(opened[0].includes('Note on Eye of Gruul'));
    const form = (note, aid) => ({ getAttribute: k => ({ 'data-aid': aid || 'a3' })[k], elements: { note: { value: note, focus() {} } } });
    const s = stub((m, url, body) => Promise.resolve({ award: Object.assign({}, AWARDS[2], { note: body.note || null }) }));
    G.handlers.submit['loot-note-form'](form('x'.repeat(201)));
    assert(/200 characters/.test(errs['dlg-err-note']) && !s.calls.length);
    G.handlers.submit['loot-note-form'](form('  Kept for the alt  '));
    await tick();
    assert.deepEqual(s.calls[0], { m: 'patch', url: '/api/guild/g1/loot/a3', body: { note: 'Kept for the alt' } });
    assert.equal(x.data.awards[2].note, 'Kept for the alt');
    G.handlers.submit['loot-note-form'](form('   '));
    await tick();
    assert.deepEqual(s.calls[1].body, { note: '' }, 'an empty note clears it');

    G.handlers.click['loot-delete'](el({ 'data-aid': 'a2' }));
    assert(opened[1].includes('Delete this award?') && opened[1].includes('Warp Slicer awarded to Kaelith-Ashmere') && opened[1].includes('data-submit="loot-delete-form"') && opened[1].includes('gs-btn-danger'));
    s.restore();
    const s2 = stub(() => Promise.resolve({ ok: true }));
    G.handlers.submit['loot-delete-form'](form('', 'a2'));
    await tick();
    assert.deepEqual(s2.calls[0], { m: 'del', url: '/api/guild/g1/loot/a2', body: {} });
    assert.deepEqual(x.data.awards.map(a => a.id), ['a1', 'a3', 'a4']);
    s2.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun; G.ui.setText = realSet; done();
  }));

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

  await check('person loot page: header, totals, awards grouped by raid newest first with the character name and no self link', () => {
    const out = G.pages.personLoot.personLootHtml({ guildData: gd(OFFICER_CAN), pid: 'p_th', data: PERSON_LOOT });
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Thoren</h1>') && out.includes('Loot history') && out.includes('href="#/g/g1/roster/p/p_th"'));
    assert(out.includes('<dt>Main spec</dt><dd>5</dd>') && out.includes('<dt>Off-spec</dt><dd>1</dd>'));
    assert.deepEqual([...out.matchAll(/<h2 class="gs-h2" id="pl-raid-\d+-h">([^<]*)</g)].map(m => m[1]), ['Sun Oct 11', 'Sat Oct 10', 'Sat Oct 3']);
    assert.deepEqual([...out.matchAll(/href="([^"]*)">Open raid</g)].map(m => m[1]), ['#/g/g1/raids/r/r2', '#/g/g1/raids/r/r1', '#/g/g1/raids/r/r0']);
    assert(out.includes('Thorenalt') && !out.includes('href="#/g/g1/loot/p/p_th"'), 'the character, not a link to this page');
    assert.deepEqual(plain(G.pages.personLoot.groupByRaid(PERSON_LOOT.awards).map(g => g.awards.length)), [2, 2, 2]);
    assert.deepEqual(plain(G.pages.personLoot.groupByRaid(null)), []);
    assertNoRawAttrs(out);
    const empty = G.pages.personLoot.personLootHtml({ guildData: gd(OFFICER_CAN), pid: 'p_th', data: { person: { id: 'p_th', name: HOSTILE, status: 'raider' }, awards: [], totals: { MS: 0, OS: 0, DE: 0, BANK: 0 } } });
    assert(empty.includes('No loot yet') && empty.includes('No loot is recorded for this person yet.'));
    assertEscaped(empty, 'person loot');
  });

  await check('person loot card: totals, the last five awards and an All loot link; empty, own and denied wording', () => {
    const P = G.pages.personLoot;
    const gdata = gd(OFFICER_CAN);
    const record = { person: { id: 'p_th', isMe: false } };
    const out = P.cardHtml({ guildData: gdata, pid: 'p_th', record, state: { data: PERSON_LOOT, denied: false } });
    assert(out.includes('<h2 class="gs-h2" id="loot-card-h">Loot</h2>') && out.includes('<dt>Main spec</dt><dd>5</dd>'));
    assert.equal((out.match(/<li class="gs-loot-row"/g) || []).length, 5, 'the last 5 of 6');
    assert(!out.includes('Dragonspine Trophy') && out.includes('Brutality Blade'));
    assert(out.includes('<a href="#/g/g1/loot/p/p_th">All loot</a>'));
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
    s.restore();
    await assert.rejects(Promise.resolve().then(() => { const s2 = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' }))); return G.pages.personLoot.load({ pid: 'p_x' }, g1).finally(() => s2.restore()); }), err => err.status === 403);
  }));

  // ── Settings > Loot ────────────────────────────────────────────
  const LOOT_DEFAULTS = { visibility: { members: 'ownTeams' }, balance: { mode: 'perRaid', countTags: ['MS'] } };
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
    assert.equal(SL.GROUPS.length, 2);
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
    const editor = L.awardRowHtml(gd(OFFICER_CAN), DE_AWARD, { edit: true, when: 'time' });
    assert(stripTags(editor).includes('Disenchanted') && editor.includes('>DE<'));
    assert(!editor.includes('data-change="loot-tag"') && !editor.includes('<select'), 'an officer cannot re-tag a disenchant: no select, the chip stays');
    assert(editor.includes('data-action="loot-note" data-aid="d1"') && editor.includes('data-action="loot-delete" data-aid="d1"'), 'a note and delete still work');
    assert(editor.includes('href="https://www.wowhead.com/tbc/item=22520"') && editor.includes('Kel&#39;Thuzad'), 'the item is still linked and escaped');
    const viewer = L.awardRowHtml(gd(MEMBER_CAN), DE_AWARD, { when: 'time' });
    assert(stripTags(viewer).includes('Disenchanted') && viewer.includes('>DE<') && !viewer.includes('data-action'));
    // The person pages show a character, never a disenchant, but the row builder must not break on one.
    assert(stripTags(L.awardRowHtml(gd(OFFICER_CAN), DE_AWARD, { character: true, when: 'date' })).includes('Disenchanted'));
    // A normal award keeps its select.
    assert(L.awardRowHtml(gd(OFFICER_CAN), AWARDS[0], { edit: true }).includes('data-change="loot-tag"'));
    // Hostile text in the item name stays escaped on a disenchant.
    assertEscaped(L.awardRowHtml(gd(OFFICER_CAN), Object.assign({}, DE_AWARD, { itemName: HOSTILE, note: HOSTILE + QUOTES }), { edit: true }), 'disenchant');
  });

  await check('disenchants: the raid card lists them, counts them as items and not as winners off the roster; the delete dialog names the item; the preview labels the row', withState(async (S) => {
    const state = okState();
    state.data.awards = AWARDS.concat([DE_AWARD]);
    const out = raidPage(state);
    assert(out.includes('5 items') && (out.match(/<li class="gs-loot-row"/g) || []).length === 5);
    assert(stripTags(out.slice(out.indexOf('id="loot-d1"'))).includes('Disenchanted'));
    assert(out.includes('1 award goes to a winner who is not on the roster'), 'only Veyla; the disenchant is nobody\'s');
    assert(!out.includes('2 awards go to a winner'));
    // The delete dialog does not say "awarded to null".
    const gdata = gd(OFFICER_CAN);
    S.guilds.g1 = gdata; S.currentGid = 'g1';
    S.att.raid = { gid: 'g1', rid: 'r1', data: DETAIL };
    S.att.raidLoot = state;
    const opened = [];
    const realOpen = G.ui.openDialog;
    G.ui.openDialog = html => { opened.push(html); return null; };
    G.handlers.click['loot-delete'](el({ 'data-aid': 'd1' }));
    G.ui.openDialog = realOpen;
    assert(opened[0].includes('Delete this award?') && opened[0].includes("The Phylactery of Kel&#39;Thuzad (disenchanted) is removed") && !opened[0].includes('awarded to'), opened[0]);
    // A refused row of a paste is named as a disenchant, not "to null".
    const R = G.pages.raidLoot;
    const parsed = { awards: [{ itemName: 'Warp Slicer', itemId: 9, winnerName: null, disenchanted: true }, { itemName: null, itemId: 10, winnerName: null, disenchanted: true }], awardRows: [3, 5] };
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Award 1: x', field: 'awards', index: 0 }), parsed), 'Row 3 of the paste (Warp Slicer (disenchanted)) was refused: x');
    assert.equal(R.describeError(new G.api.ApiError(400, { message: 'Award 2: x', field: 'awards', index: 1 }), parsed), 'Row 5 of the paste (item 10 (disenchanted)) was refused: x');
    assert(!/null/.test(R.describeError(new G.api.ApiError(400, { message: 'Award 2: x', field: 'awards', index: 1 }), parsed)));
  }));

  await check('disenchants: By raid has a Disenchanted column and card figure; By item names the item\'s disenchant; an older reply without the count still renders', () => {
    const L = G.pages.loot;
    const raids = { raids: [
      { raidId: 'r2', raidOn: '2026-10-11', title: 'BT clear', zone: 'Black Temple', awards: 9, counted: 7, unmatched: 2, disenchanted: 3 },
      { raidId: 'r1', raidOn: '2026-10-10', title: null, zone: 'Gruul', awards: 4, counted: 4, unmatched: 0, disenchanted: 0 },
    ] };
    const out = L.lootHtml(pageOpts({ view: 'raids', data: raids }));
    assert(out.includes('<th scope="col">Disenchanted</th>'));
    const rows = out.split('<tr>').filter(r => r.includes('gs-raid-link'));
    assert(rows[0].includes('<td class="gs-num">3</td>') && rows[1].includes('<span class="gs-muted">-</span>'), 'a count, or a dash for none');
    assert.equal((out.match(/<dt>Disenchanted<\/dt><dd>3<\/dd>/g) || []).length, 1, 'the phone card shows it only when there is one');
    assert(!out.includes('<dt>Disenchanted</dt><dd>0</dd>'));
    const old = L.lootHtml(pageOpts({ view: 'raids', data: { raids: [{ raidId: 'r2', raidOn: '2026-10-11', title: null, zone: 'Gruul', awards: 1, counted: 1, unmatched: 0 }] } }));
    assert(old.includes('href="#/g/g1/raids/r/r2"') && !old.includes('undefined') && !old.includes('NaN'));
    const items = { items: [{ itemId: 22520, itemName: "The Phylactery of Kel'Thuzad", quality: 4, count: 2, lastAwardedAt: 1791774300000, awards: [
      { id: 'd1', raidId: 'r2', raidOn: '2026-10-11', awardedAt: 1791774300000, tag: 'DE', tagSetBy: null, winner: { name: null, realm: null, class: null }, match: { kind: 'disenchanted' } },
      { id: 'a5', raidId: 'r1', raidOn: '2026-10-10', awardedAt: 1791681160000, tag: 'MS', tagSetBy: null, winner: AWARDS[0].winner, match: AWARDS[0].match },
    ] }] };
    const byItem = L.lootHtml(pageOpts({ view: 'items', data: items }));
    const subrows = [...byItem.matchAll(/<li class="gs-loot-subrow">([\s\S]*?)<\/li>/g)].map(m => stripTags(m[1]));
    assert.equal(subrows.length, 2);
    assert(subrows[0].includes('Disenchanted') && subrows[0].includes('DE') && !subrows[0].includes('Not on roster') && !subrows[0].includes('Guest'));
    assert(subrows[1].includes('Thoren'));
    assertNoRawAttrs(byItem);
  });

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
    const names = ['gargul', 'pages-loot', 'pages-person-loot', 'pages-raid-loot', 'pages-settings-loot'];
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
    const src = ['pages-loot', 'pages-person-loot', 'pages-raid-loot', 'pages-settings-loot'].map(n => read('js/guild/' + n + '.js')).join('\n');
    assert(!/G\.api\.(get|post|put|patch|del)\(/.test(src), 'loot pages go through G.api.loot, not raw paths');
    // The loot block of api.js (the sign-up and schedule calls after it have their own routes and their own suite).
    const api = read('js/guild/api.js');
    const lootBlock = api.slice(api.indexOf('G.api.loot = {'), api.indexOf('// Every sign-up and raid-schedule call'));
    const paths = [...lootBlock.matchAll(/guildPath\(gid, '([^']*)'/g)].map(m => m[1]);
    assert(paths.length >= 9, 'the loot block was found');
    const contract = ['/raids/', '/loot/', '/loot/balance', '/loot/raids', '/loot/items', '/loot/person/', '/loot/policy'];
    for (const p of paths) assert(contract.some(c => p.startsWith(c)), 'unknown route ' + p);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
