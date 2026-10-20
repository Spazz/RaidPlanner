/**
 * Raidsmith guild UI, PM wave 3 (recruiting and the WoW Forever launch) - tests for the Roster tabs, the class and spec intent board, recruitment
 * needs and its recruiting post, the applications inbox, Guild settings > Applications, the public apply form, the CSV import page, the buff
 * coverage panel, the Home line for new applications and the version-aware default team size in the Add team dialog.
 * Run: node guild-wave3-ui-tests.js
 *
 * Same approach as guild-wave2-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render functions return HTML strings and the
 * handlers run against a stubbed G.api and a fake document. guild-wave3-contract-tests.js runs the same pages against the real Worker.
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
    console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
let els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
function fakeEl(id, over) {
  const e = Object.assign({ id, value: '', textContent: '', hidden: false, innerHTML: '', focused: 0, attrs: {}, focus() { e.focused++; }, select() { e.selected = true; }, setAttribute(k, v) { e.attrs[k] = v; } }, over || {});
  els[id] = e;
  return e;
}
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

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
const optionsOf = (html, id) => {
  const m = new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>').exec(html);
  assert(m, 'no select #' + id);
  return [...m[1].matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map(o => ({ value: o[1], selected: !!o[2], label: o[3] }));
};

// ── fixtures ─────────────────────────────────────────────────────
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'guild.teams': 'guild', 'raids.view': 'guild' };
const LEAD_CAN = { 'roster.view': 'guild', 'roster.edit': ['t1'] };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild' };
const TEAMS = [
  { id: 't1', name: 'Team KJ', size: 20, archived: false, players: 3, leads: [] },
  { id: 't2', name: 'Weekend team', size: 40, archived: false, players: 1, leads: [] },
];
const ROSTER_OPTIONS = {
  classes: [{ id: 'WARRIOR', name: 'Warrior' }, { id: 'PRIEST', name: 'Priest' }, { id: 'MAGE', name: 'Mage' }, { id: 'DRUID', name: 'Druid' }],
  specs: { WARRIOR: ['Arms', 'Fury', 'Protection'], PRIEST: ['Discipline', 'Holy', 'Shadow'], MAGE: ['Arcane', 'Fire', 'Frost'], DRUID: ['Balance', 'Feral (DPS)', 'Feral (Tank)', 'Restoration'] },
  roles: {},
};
function gd(can, over) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Normal', region: 'US', timeZone: 'America/Chicago', gameVersion: 'forever', realmKind: 'ruleset', realmSlug: null, createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({}, t)),
    me: { roles: [], can },
    rosterOptions: ROSTER_OPTIONS,
    attendanceFlags: {},
  }, over || {});
}
const ROLES = { WARRIOR: { Arms: 'melee', Fury: 'melee', Protection: 'tank' }, PRIEST: { Holy: 'healer', Shadow: 'ranged' }, MAGE: { Fire: 'ranged' }, DRUID: { 'Feral (Tank)': 'tank' } };
const pick = (over) => Object.assign({ personId: 'p_a', name: 'Thornwick', status: 'raider', kind: 'main', class: 'WARRIOR', spec: 'Protection', role: 'tank', note: null, mine: false }, over || {});
function board(over) {
  return Object.assign({
    team: { id: 't1', name: 'Team KJ', size: 20, archived: false },
    targets: { tank: 2, healer: 5, melee: 7, ranged: 6 },
    roles: ROLES,
    gameVersion: 'forever',
    canEdit: true,
    myPersonId: 'p_a',
    rounds: [{ id: 'ir_1', title: 'WoW Forever launch', closesOn: '2026-11-04', status: 'open', createdAt: Date.UTC(2026, 9, 18), closedAt: null, mains: 2 }],
    round: { id: 'ir_1', title: 'WoW Forever launch', closesOn: '2026-11-04', status: 'open', createdAt: Date.UTC(2026, 9, 18), closedAt: null },
    canPick: true,
    picks: [pick({ mine: true, note: 'Tanking at launch' }), pick({ personId: 'p_b', name: 'Mendra', class: 'PRIEST', spec: 'Holy', role: 'healer' }), pick({ personId: 'p_a', kind: 'alt', class: 'MAGE', spec: 'Fire', role: 'ranged', mine: true })],
    undecided: [{ personId: 'p_c', name: 'Quillfeather', class: 'MAGE', status: 'raider' }],
    totals: { mains: 2, alts: 1, byRole: { tank: 1, healer: 1, melee: 0, ranged: 0 }, byClass: { WARRIOR: 1, PRIEST: 1, MAGE: 0 } },
  }, over || {});
}
const COVERAGE = {
  gameVersion: 'forever', seated: 2, size: 20,
  buffs: [{ id: 'WINDFURY', name: 'Windfury Totem', covered: false, sourceClass: 'SHAMAN', sourceSpec: 'Enhancement' }, { id: 'BATTLE_SHOUT', name: 'Battle Shout', covered: true, sourceClass: 'WARRIOR', sourceSpec: null }],
  debuffs: [{ id: 'CURSE_ELEMENTS', name: 'Curse of the Elements', covered: false, sourceClass: 'WARLOCK', sourceSpec: null }, { id: 'SUNDER_ARMOR', name: 'Sunder Armor', covered: true, sourceClass: 'WARRIOR', sourceSpec: null }],
};

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const control = (value, extra) => Object.assign({ value, checked: false, focused: 0, attrs: {}, focus() { this.focused++; }, setAttribute(k, v) { this.attrs[k] = v; } }, extra || {});
function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, apply: S.apply, imports: S.imports, roster: S.roster, rosterNotice: S.rosterNotice };
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.apply = null; S.imports = {};
    els = {};
    const realOpen = G.ui.openDialog; const realRender = G.app.render; const realTeamFor = G.app.teamFor; const realGo = G.app.go;
    const opened = [];
    G.ui.openDialog = (html, o) => { opened.push({ html, o }); return null; };
    G.app.render = () => { S.renders = (S.renders || 0) + 1; };
    G.app.teamFor = () => 't1';
    G.app.go = (hash) => { S.went = hash; };
    try { await fn(S, opened); } finally {
      Object.assign(S, saved); G.ui.openDialog = realOpen; G.app.render = realRender; G.app.teamFor = realTeamFor; G.app.go = realGo; els = {};
    }
  };
}
class ApiErr extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.message = (extra && extra.message) || code; Object.assign(this, extra || {}); this.body = extra || {}; }
}

(async () => {
  // ═══ Router and shell ═══════════════════════════════════════════
  await check('router: the Roster tabs, the apply page, the CSV import and the Applications settings tab parse and format back; the apply page works signed out', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/g/g1/roster/intent'), { name: 'intent', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/roster/recruiting'), { name: 'recruiting', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/roster/applications'), { name: 'applications', gid: 'g1' });
    assert.deepEqual(p('#/apply/g1'), { name: 'apply', gid: 'g1' });
    assert.deepEqual(p('#/g/g1/roster/import/csv'), { name: 'import', gid: 'g1', source: 'csv' });
    assert.deepEqual(p('#/g/g1/settings/applications'), { name: 'settings', gid: 'g1', tab: 'applications' });
    for (const h of ['#/g/g1/roster/intent/x', '#/g/g1/roster/board', '#/apply', '#/apply/g1/x', '#/g/g1/roster/import/xlsx']) assert.deepEqual(p(h), { name: 'notfound' }, h);
    for (const route of [{ name: 'intent', gid: 'g1' }, { name: 'recruiting', gid: 'g1' }, { name: 'applications', gid: 'g1' }, { name: 'apply', gid: 'g1' }, { name: 'import', gid: 'g1', source: 'csv' }, { name: 'settings', gid: 'g1', tab: 'applications' }]) {
      assert.deepEqual(p(G.router.format(route)), route, JSON.stringify(route));
    }
    assert.equal(G.router.format({ name: 'apply', gid: 'bad id/' }), '#/', 'an address that is no id is not built');
    assert.deepEqual(plain(G.router.ROSTER_TABS), ['intent', 'recruiting', 'applications', 'launch']);
    assert.equal(G.router.isViewerRoute({ name: 'apply' }), true);
    assert.equal(G.router.isViewerRoute({ name: 'intent' }), false);
  });

  await check('shell: Guild settings shows Applications to guild.teams; the Roster tabs hang under Roster in the breadcrumbs, the back link and the sidebar; Import offers a CSV file', () => {
    const tabs = can => plain(G.shell.settingsTabs(can, []).map(t => t.tab));
    assert.deepEqual(tabs({ 'guild.teams': 'guild' }), ['general', 'teams', 'notifications', 'applications', 'battlenet']);
    assert.deepEqual(tabs({ 'roster.edit': 'guild' }), [], 'roster.edit alone does not open Guild settings');
    const crumbs = (route) => plain(G.shell.breadcrumbItems({ route, guildData: gd(OFFICER_CAN), signedOut: false, section: 'guild', teamId: 't1', me: { user: { id: 'u' } } }).map(c => c.label));
    assert.deepEqual(crumbs({ name: 'intent', gid: 'g1' }).slice(-2), ['Roster', 'Spec poll']);
    assert.deepEqual(crumbs({ name: 'recruiting', gid: 'g1' }).slice(-2), ['Roster', 'Recruiting']);
    assert.deepEqual(crumbs({ name: 'applications', gid: 'g1' }).slice(-2), ['Roster', 'Recruiting']);
    assert.deepEqual(crumbs({ name: 'import', gid: 'g1', source: 'csv' }).slice(-2), ['Roster', 'Import from a CSV file']);
    assert.deepEqual(crumbs({ name: 'apply', gid: 'g1' }), ['Apply']);
    for (const name of ['intent', 'recruiting', 'applications', 'launch']) {
      const side = G.shell.sidebarHtml({ section: 'guild', route: { name, gid: 'g1' }, guildData: gd(OFFICER_CAN), teamId: 't1', me: { user: { id: 'u', username: 'u' }, guilds: [] }, attentionCount: 0 });
      const current = [...side.matchAll(/<a class="gs-nav-link is-active" href="([^"]+)"[^>]*aria-current="page">/g)].map(m => m[1]);
      assert.deepEqual(current, ['#/g/g1/roster'], name + ': the Roster item is the open one');
    }
    const menu = G.pages.roster.importMenuHtml('g1');
    assert(menu.includes('href="#/g/g1/roster/import/csv"') && menu.includes('Import from a CSV file'));
    assertNoRawAttrs(menu);
  });

  await check('Roster tabs: everyone gets Roster and Spec poll, roster editors also Recruiting; the open tab is marked; a count sits beside Recruiting', () => {
    const member = G.pages.rosterTabs.html(gd(MEMBER_CAN), 'intent');
    assert.deepEqual([...member.matchAll(/>([A-Za-z ]+)<\/a>/g)].map(m => m[1]), ['Roster', 'Spec poll'], 'Launch is a page opened from the Spec poll, not a tab');
    assert(/<a class="gs-subtab is-active" href="#\/g\/g1\/roster\/intent" aria-current="page">Spec poll<\/a>/.test(member));
    const officer = G.pages.rosterTabs.html(gd(OFFICER_CAN), 'roster', 3);
    assert.deepEqual([...officer.matchAll(/class="gs-subtab[^"]*" href="([^"]+)"/g)].map(m => m[1]), ['#/g/g1/roster', '#/g/g1/roster/intent', '#/g/g1/roster/recruiting']);
    assert(officer.includes('aria-label="3 new applications">3</span>'));
    assert(!G.pages.rosterTabs.html(gd(OFFICER_CAN), 'roster', 0).includes('gs-tab-count'));
    assert(G.pages.roster.rosterHtml({ guildData: gd(OFFICER_CAN), data: { team: { id: 't1', name: 'Team KJ' }, people: [], can: { edit: true } }, view: {}, notice: '', alert: '' }).includes('aria-label="Roster sections"'), 'the roster page carries the strip');
    assertNoRawAttrs(officer);
  });

  await check('team dialog: Add team starts at the game version\'s usual size (TBC 25, Classic 40, WoW Forever 20)', () => {
    const sel = v => optionsOf(G.pages.teams.teamDialogHtml('add', null, 'g1', v), 'dlg-team-size').filter(o => o.selected).map(o => o.value);
    assert.deepEqual([sel('tbc'), sel('classic'), sel('forever'), sel(undefined)], [['25'], ['40'], ['20'], ['25']]);
    assert.equal(G.ui.defaultTeamSize('forever'), 20);
    // A team that exists keeps its own size whatever the version.
    assert.deepEqual(optionsOf(G.pages.teams.teamDialogHtml('size', TEAMS[0], 'g1', 'classic'), 'dlg-team-size').filter(o => o.selected).map(o => o.value), ['20']);
  });

  // ═══ Buff coverage panel ════════════════════════════════════════
  await check('coverage: the panel lists what is missing first and what is covered, the summary counts, and says so when the Planner is not there or nobody is planned', () => {
    const out = G.coverage.panelHtml(COVERAGE, { id: 'x', heading: 'Buffs and debuffs of the planned raid', intro: 'What the picks cover.' });
    assert(out.includes('1 of 2 buffs, 1 of 2 debuffs'));
    const lists = [...out.matchAll(/<ul class="gs-cov-list" aria-label="([^"]+)">([\s\S]*?)<\/ul>/g)];
    assert.deepEqual(lists.map(m => m[1]), ['Raid buffs', 'Raid debuffs']);
    assert.deepEqual([...lists[0][2].matchAll(/gs-pill gs-pill-(\w+)">(\w+)<\/span><span class="gs-cov-name">([^<]+)/g)].map(m => [m[2], m[3]]), [['Missing', 'Windfury Totem'], ['Covered', 'Battle Shout']]);
    assert(out.includes('Shaman (Enhancement)') && out.includes('Read with the Planner&#39;s rules for WoW Forever') || out.includes('Read with the Planner\'s rules for WoW Forever'));
    assert.deepEqual(plain(G.coverage.missingByClass(COVERAGE)), [{ class: 'SHAMAN', names: ['Windfury Totem'] }, { class: 'WARLOCK', names: ['Curse of the Elements'] }]);
    assert.deepEqual(plain(G.coverage.summary(COVERAGE)), { buffs: 1, buffsTotal: 2, debuffs: 1, debuffsTotal: 2, missing: 2 });
    assert(G.coverage.panelHtml(null).includes('not available'));
    assert(G.coverage.panelHtml(Object.assign({}, COVERAGE, { seated: 0 })).includes('Nobody is planned yet'));
    assert.equal(G.coverage.compute('forever', [], 20), null, 'without the Planner on the page there is no answer');
    ctx.rosterBuffCoverage = (roster, version, size) => ({ gameVersion: version, seated: roster.length, size, buffs: [], debuffs: [] });
    try {
      assert.deepEqual(plain(G.coverage.compute('tbc', [{ class: 'MAGE', spec: 'Fire' }], 25)), { gameVersion: 'tbc', seated: 1, size: 25, buffs: [], debuffs: [] });
      ctx.rosterBuffCoverage = () => { throw new Error('boom'); };
      assert.equal(G.coverage.compute('tbc', [], 25), null, 'a failing call is no answer, not an error');
    } finally { delete ctx.rosterBuffCoverage; }
    assertNoRawAttrs(out);
  });

  // ═══ Intent board ═══════════════════════════════════════════════
  await check('intent: an open round shows the totals against the raid size and targets, the coverage, the picks and who has not picked; hostile text is escaped', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const b = board({ picks: [pick({ name: HOSTILE, note: QUOTES, mine: true }), pick({ personId: 'p_b', name: 'Mendra', class: 'PRIEST', spec: 'Holy', role: 'healer' })], round: Object.assign(board().round, { title: HOSTILE + QUOTES }) });
    const x = G.pages.intent.makeState('g1', 't1', b, null);
    x.cov = COVERAGE;
    const out = G.pages.intent.intentHtml({ guildData: S.guilds.g1, state: x, alert: '' });
    assertEscaped(out, 'intent page');
    assertNoRawAttrs(out);
    const text = stripTags(out);
    assert(text.includes('2 of 3 picked') && text.includes('Your pick: Warrior Protection'), text.slice(0, 600));
    // The role tiles: picked / target with the gap.
    const tiles = [...out.matchAll(/<span class="gs-fg-lbl">([^<]+)<\/span><span class="gs-sp-tilerow"><span class="gs-sp-num">(\d+)<span class="gs-sp-den"> \/ (\d+)<\/span><\/span><span class="gs-fg-mut">([^<]*)<\/span>/g)].map(m => [m[1], +m[2], +m[3], m[4]]);
    assert.deepEqual(tiles, [['Tanks', 1, 2, 'Need 1'], ['Healers', 1, 5, 'Need 4'], ['Melee DPS', 0, 7, 'Need 7'], ['Ranged DPS', 0, 6, 'Need 6']]);
    assert(out.includes('Picks by role') && out.includes('gs-rs-colhead gs-fg-gh"><span class="gs-fg-ght">Tanks</span><span class="gs-fg-ghn">1') && out.includes('gs-rs-colhead gs-fg-gh"><span class="gs-fg-ght">Healers</span><span class="gs-fg-ghn">1') && out.includes('Mendra'));
    assert(!out.includes('Windfury Totem') && out.includes('data-action="intent-cov"') && text.includes('Picks cover 1 of 2 buffs and 1 of 2 debuffs'), 'coverage is one line until it is opened');
    x.showCov = true;
    const opened = G.pages.intent.intentHtml({ guildData: S.guilds.g1, state: x, alert: '' });
    assert(opened.includes('Buffs and debuffs of the planned raid') && opened.includes('Windfury Totem') && opened.includes('Hide coverage'));
    assert(text.includes('Not picked yet 1') && text.includes('Quillfeather'));
    assert(out.includes('data-action="intent-edit" data-pid="p_c"'), 'an officer can set a pick for somebody who has not');
    assert(out.includes('data-action="intent-close"') && out.includes('data-action="intent-edit" data-pid="p_a"'));
    assert(out.includes('Change my pick') && out.includes('gs-btn gs-btn-molten" data-action="intent-edit"') && (out.match(/gs-btn-molten/g) || []).length === 1, 'Set my pick is the one primary');
  }));

  await check('intent: a member sees the same board without the officers\' buttons; no round, a closed round and a person who cannot pick read plainly', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const html = (b) => { const x = G.pages.intent.makeState('g1', 't1', b, null); x.cov = null; return G.pages.intent.intentHtml({ guildData: S.guilds.g1, state: x, alert: '' }); };
    const member = html(board({ canEdit: false }));
    assert(!member.includes('intent-close') && !member.includes('Set pick') && member.includes('Change my pick'));
    assert(!member.includes('intent-cov'), 'no Planner, no coverage line');
    const bystander = html(board({ canEdit: false, canPick: false, myPersonId: null }));
    assert(!bystander.includes('data-action="intent-edit"'));
    assert(stripTags(bystander).includes('Only people on this team can pick'));
    const none = html(board({ round: null, rounds: [], picks: [], undecided: [], canPick: false, canEdit: false }));
    assert(stripTags(none).includes('Your officers have not opened a spec poll') && !none.includes('intent-open'));
    const none2 = html(board({ round: null, rounds: [], picks: [], undecided: [], canPick: false, canEdit: true }));
    assert(none2.includes('data-action="intent-open"') && stripTags(none2).includes('No spec poll yet'));
    const closed = html(board({ canPick: false, canEdit: false, round: Object.assign(board().round, { status: 'closed', closedAt: Date.UTC(2026, 10, 5) }), rounds: board().rounds.map(r => Object.assign({}, r, { status: 'closed' })), undecided: [] }));
    assert(closed.includes('gs-hd-chip is-grey">Closed') && !closed.includes('intent-close') && !closed.includes('Not picked yet'));
    assert(closed.includes('data-action="intent-open"') === false, 'a member cannot open a new round');
    const officerClosed = G.pages.intent.intentHtml({ guildData: gd(OFFICER_CAN), state: Object.assign(G.pages.intent.makeState('g1', 't1', board({ canPick: false, round: Object.assign(board().round, { status: 'closed' }), rounds: board().rounds.map(r => Object.assign({}, r, { status: 'closed' })) }), null), { cov: null }), alert: '' });
    assert(officerClosed.includes('Open a new round'));
    const history = html(board({ rounds: [board().rounds[0], { id: 'ir_0', title: 'Old round', status: 'closed', closesOn: null, createdAt: 1, closedAt: 2, mains: 5 }] }));
    assert.deepEqual(optionsOf(history, 'intent-round').map(o => [o.value, o.selected]), [['ir_1', true], ['ir_0', false]]);
  }));

  await check('intent: the Launch readiness panel shows the four stages and opens the launch list, only while the launch is on', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const render = (launch) => { const x = G.pages.intent.makeState('g1', 't1', board({ canEdit: false }), null); x.launch = launch; return G.pages.intent.intentHtml({ guildData: S.guilds.g1, state: x, alert: '' }); };
    assert(!render(null).includes('Launch readiness') && !render({ enabled: false, totals: null }).includes('Launch readiness'));
    const out = render({ enabled: true, totals: { people: 23, stages: { intent: 7, character: 23, level: 0, ready: 0 } } });
    const text = stripTags(out);
    assert(text.includes('Launch readiness') && text.includes('Picked 7 / 23') && text.includes('Character made 23 / 23') && text.includes('Level band 0 / 23') && text.includes('Ready 0 / 23'), text.slice(-300));
    assert(out.includes('href="#/g/g1/roster/launch"') && out.includes('>Open launch list</a>'));
    const same = G.pages.intent.intentHtml({ guildData: S.guilds.g1, state: Object.assign(G.pages.intent.makeState('g1', 't1', board({ round: null, rounds: [], picks: [], undecided: [], canPick: false, canEdit: false }), null), { launch: { enabled: true, totals: { people: 2, stages: { intent: 0, character: 1, level: 0, ready: 0 } } } }), alert: '' });
    assert(same.includes('Launch readiness'), 'also before a round is open');
  }));

  await check('intent: opening a round sends the title and date; the pick dialog sends the main, then the alt, and clears what was emptied', withState(async (S, opened) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const empty = board({ round: null, rounds: [], picks: [], undecided: [], canPick: false });
    S.att.intent = G.pages.intent.makeState('g1', 't1', empty, null);
    G.handlers.click['intent-open'](el({}));
    assert(opened[0].html.includes('value="WoW Forever launch"') && opened[0].html.includes('type="date"'), 'the forever default title');
    const openedBoard = board();
    const api = stub(() => Promise.resolve(openedBoard));
    const closed = [];
    const realRun = G.ui.runDialog; G.ui.runDialog = (form, promise, onOk) => promise.then(res => { closed.push(1); if (onOk) onOk(res); });
    try {
      const form = { elements: { title: control('  Launch night  '), closesOn: control('2026-11-04') } };
      await G.handlers.submit['intent-open-form'](form);
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/teams/t1/intent', { title: 'Launch night', closesOn: '2026-11-04' }]]);
      assert.equal(S.att.intent.board.round.id, 'ir_1');
      assert.equal(S.att.intent.note, 'The round is open.');
      // A blank title is refused before any request.
      const blank = fakeEl('dlg-err-title');
      await G.handlers.submit['intent-open-form']({ elements: { title: control('   '), closesOn: control('') } });
      assert.equal(api.calls.length, 1);
      assert.equal(blank.hidden, false);
      // The pick dialog for me: a main and an alt, with the picks I have already.
      G.handlers.click['intent-edit'](el({ 'data-pid': 'p_a' }));
      const dlg = opened[opened.length - 1].html;
      assert(dlg.includes('Your pick for WoW Forever launch') && dlg.includes('data-pid="p_a"'));
      assert.deepEqual(optionsOf(dlg, 'ip-main-class').filter(o => o.selected).map(o => o.value), ['WARRIOR']);
      assert.deepEqual(optionsOf(dlg, 'ip-main-spec').filter(o => o.selected).map(o => o.value), ['Protection']);
      assert.deepEqual(optionsOf(dlg, 'ip-alt-class').filter(o => o.selected).map(o => o.value), ['MAGE']);
      assert(dlg.includes('Counts as: Tank') && dlg.includes('value="Tanking at launch"'));
      assertNoRawAttrs(dlg);
      // Saving: main + alt = two PUTs in order.
      api.calls.length = 0;
      const vals = (m, a) => ({ elements: Object.fromEntries(Object.entries({ mainClass: m[0], mainSpec: m[1], mainNote: m[2] || '', altClass: a[0], altSpec: a[1], altNote: a[2] || '' }).map(([k, v]) => [k, control(v)])), getAttribute: () => 'p_a' });
      await G.handlers.submit['intent-pick-form'](vals(['WARRIOR', 'Fury', ' note '], ['MAGE', 'Fire']));
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url.split('/').slice(-3).join('/'), c.body]), [
        ['put', 'ir_1/picks/p_a', { kind: 'main', class: 'WARRIOR', spec: 'Fury', note: 'note' }],
        ['put', 'ir_1/picks/p_a', { kind: 'alt', class: 'MAGE', spec: 'Fire', note: null }],
      ]);
      // Clearing the alt (I had one) deletes it; clearing the main deletes the main (and the server takes the alt).
      api.calls.length = 0;
      await G.handlers.submit['intent-pick-form'](vals(['WARRIOR', 'Fury'], ['', '']));
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.body]), [['put', { kind: 'main', class: 'WARRIOR', spec: 'Fury', note: null }], ['del', { kind: 'alt' }]]);
      api.calls.length = 0;
      await G.handlers.submit['intent-pick-form'](vals(['', ''], ['', '']));
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.body]), [['del', { kind: 'main' }]]);
      // Mistakes are caught before a request: a class without a spec, an alt without a main.
      api.calls.length = 0;
      const specErr = fakeEl('dlg-err-mainSpec'); const generic = fakeEl('dlg-error');
      await G.handlers.submit['intent-pick-form'](vals(['WARRIOR', ''], ['', '']));
      assert.equal(specErr.hidden, false);
      await G.handlers.submit['intent-pick-form'](vals(['', ''], ['MAGE', 'Fire']));
      assert(generic.textContent.includes('main before an alt'));
      assert.equal(api.calls.length, 0);
      // Closing asks first.
      G.handlers.click['intent-close'](el({}));
      assert(opened[opened.length - 1].html.includes('Close this round?'));
    } finally { G.ui.runDialog = realRun; api.restore(); }
  }));

  await check('intent: choosing a class fills the spec list of its own fieldset; a spec shows what it counts as', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.intent = G.pages.intent.makeState('g1', 't1', board(), null);
    const specSel = { innerHTML: '' };
    const form = { elements: { mainSpec: specSel, mainClass: control('MAGE') } };
    G.handlers.change['intent-class']({ value: 'MAGE', getAttribute: () => 'main', closest: () => form });
    assert.deepEqual([...specSel.innerHTML.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]), ['', 'Arcane', 'Fire', 'Frost']);
    const role = fakeEl('ip-main-role');
    G.handlers.change['intent-spec']({ value: 'Fire', getAttribute: () => 'main', closest: () => form });
    assert.equal(role.textContent, 'Counts as: Ranged DPS');
  }));

  // ═══ Recruiting ═════════════════════════════════════════════════
  const RECRUIT = () => ({
    team: { id: 't1', name: 'Team KJ', size: 20 },
    guild: { id: 'g1', name: 'Ravens', realm: 'Normal', realmKind: 'ruleset', region: 'US', gameVersion: 'forever', applyEnabled: true, applyPath: '/#/apply/g1' },
    targets: { tank: 2, healer: 5, melee: 7, ranged: 6 }, defaultTargets: { tank: 2, healer: 5, melee: 7, ranged: 6 }, customTargets: false,
    roster: { people: 10, counts: { tank: 1, healer: 5, melee: 7, ranged: 6 }, unknown: 2, gaps: { tank: 1, healer: 0, melee: 0, ranged: 0 }, specs: [{ class: 'WARRIOR', spec: 'Protection' }] },
    intent: null,
    schedule: [{ weekday: 2, startTime: '20:00', zone: 'Hyjal', title: null }, { weekday: 4, startTime: '20:30', zone: null, title: null }],
  });

  await check('recruiting: the counts against the targets with the gap, the post as plain ASCII text with raid days, needs, buffs we lack and the apply link', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const data = RECRUIT();
    const x = G.pages.recruiting.makeState('g1', 't1', data, null);
    x.cov = COVERAGE;
    const out = G.pages.recruiting.recruitingHtml({ guildData: S.guilds.g1, state: x, alert: '' });
    assertNoRawAttrs(out);
    assert(out.includes('aria-label="Roster sections"') && stripTags(out).includes('Recruiting'));
    const rows = [...out.matchAll(/<div class="gs-rc-need"><span class="gs-rc-role">([^<]+)<\/span><span class="gs-rc-n">(\d+)<span class="gs-rc-d"> \/ (\d+)<\/span><\/span><span class="gs-hd-chip is-(\w+)">([^<]+)<\/span>/g)].map(m => [m[1], +m[2], +m[3], m[4], m[5]]);
    assert.deepEqual(rows, [['Tanks', 1, 2, 'rose', 'Need 1'], ['Healers', 5, 5, 'green', 'Full'], ['Melee DPS', 7, 7, 'green', 'Full'], ['Ranged DPS', 6, 6, 'green', 'Full']]);
    assert(out.includes('>Recruiting needs</h2>') && out.includes('data-action="recruiting-edit"') && !out.includes('name="tank"'), 'targets are edited in a dialog, not inline');
    assert(stripTags(out).includes('2 mains have no spec set and are not counted') && stripTags(out).includes('The usual targets for a 20-man raid'));
    assert(out.includes('Missing buffs and debuffs') && stripTags(out).includes('2 missing') && stripTags(out).includes('Buffs 1 of 2') && stripTags(out).includes('Windfury Totem') && out.includes('<details class="gs-rc-covered">') && !out.includes('gs-btn-molten'), 'no orange on the Recruiting tab');
    const text = G.pages.recruiting.postText(data, COVERAGE, 'https://raidsmith.example', { realmLine: 'Normal', timeZone: 'America/Chicago' });
    assert.equal(text, [
      'Ravens is recruiting for Team KJ!',
      'WoW Forever - Normal',
      'Raid days: Tue 8:00 PM, Thu 8:30 PM (America/Chicago)',
      'Looking for: 1 Tank',
      'Classes that bring buffs we lack: Shaman (Windfury Totem), Warlock (Curse of the Elements)',
      'Apply: https://raidsmith.example/#/apply/g1',
    ].join('\n'));
    assert(/^[\x20-\x7e\n]*$/.test(text), 'ASCII only');
    // Nothing needed, no schedule, applications off: the post still reads.
    const calm = RECRUIT();
    calm.roster.gaps = { tank: 0, healer: -1, melee: 0, ranged: 0 }; calm.schedule = []; calm.guild.applyEnabled = false; calm.guild.realmKind = 'realm'; calm.guild.realm = 'Nightslayer'; calm.guild.gameVersion = 'tbc';
    const calmText = G.pages.recruiting.postText(calm, null, '', {});
    assert(calmText.includes('Looking for: no set roles right now') && calmText.includes('To apply, message an officer on Discord.') && calmText.includes('TBC Anniversary - Nightslayer (US)') && !calmText.includes('Raid days'), calmText);
    assert(G.pages.recruiting.recruitingHtml({ guildData: S.guilds.g1, state: Object.assign(G.pages.recruiting.makeState('g1', 't1', calm, null), { cov: null }), alert: '' }).includes('Applications are off'));
    assertEscaped(G.pages.recruiting.recruitingHtml({ guildData: S.guilds.g1, state: Object.assign(G.pages.recruiting.makeState('g1', 't1', Object.assign(RECRUIT(), { team: { id: 't1', name: HOSTILE + QUOTES, size: 20 } }), null), { cov: COVERAGE }), alert: '' }), 'recruiting page');
  }));

  await check('recruiting: the open spec poll is laid over the roster (a switch), targets are saved as numbers, reset goes back to the defaults, mistakes are caught first', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const data = RECRUIT();
    data.intent = { roundId: 'ir_1', title: 'Launch', replaced: 3, people: 10, counts: { tank: 2, healer: 5, melee: 6, ranged: 7 }, unknown: 0, gaps: { tank: 0, healer: 0, melee: 1, ranged: -1 }, specs: [{ class: 'MAGE', spec: 'Fire' }] };
    const x = S.att.recruiting = G.pages.recruiting.makeState('g1', 't1', data, null);
    assert.equal(x.useIntent, true, 'on by default while a round is open');
    let out = G.pages.recruiting.recruitingHtml({ guildData: S.guilds.g1, state: x, alert: '' });
    assert(stripTags(out).includes('3 mains replaced by a spec poll pick') && out.includes('Count the open spec poll (Launch)'));
    assert(out.includes('Need 1') && out.includes('1 over'));
    G.handlers.change['recruiting-intent'](control('', { checked: false }));
    assert.equal(x.useIntent, false);
    out = G.pages.recruiting.recruitingHtml({ guildData: S.guilds.g1, state: x, alert: '' });
    assert(out.includes('Need 1') && !out.includes('1 over'), 'the plain roster again');
    // Save: four whole numbers.
    const saved = Object.assign(RECRUIT(), { targets: { tank: 3, healer: 6, melee: 8, ranged: 3 }, customTargets: true });
    const api = stub(() => Promise.resolve(saved));
    const realRun = G.ui.runDialog; G.ui.runDialog = (f, promise, onOk) => promise.then(res => { if (onOk) onOk(res); });
    try {
      const dlgError = fakeEl('dlg-error');
      const realRun = G.ui.runDialog; G.ui.runDialog = (f, promise, onOk) => promise.then(res => { if (onOk) onOk(res); });
      const form = (v) => ({ elements: { tank: control(v[0]), healer: control(v[1]), melee: control(v[2]), ranged: control(v[3]) } });
      await G.handlers.submit['recruiting-form'](form(['3', '6', '8', '3']));
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/teams/t1/recruiting', { targets: { tank: 3, healer: 6, melee: 8, ranged: 3 } }]]);
      assert.equal(S.att.recruiting.note, 'Targets saved.');
      assert.equal(S.att.recruiting.data.customTargets, true);
      assert(G.pages.recruiting.targetsDialogHtml(S.att.recruiting.data).includes('data-action="recruiting-reset"') && !G.pages.recruiting.targetsDialogHtml(RECRUIT()).includes('recruiting-reset'));
      api.calls.length = 0;
      for (const bad of [['', '1', '1', '1'], ['1.5', '1', '1', '1'], ['-1', '1', '1', '1'], ['100', '1', '1', '1'], ['x', '1', '1', '1']]) {
        await G.handlers.submit['recruiting-form'](form(bad));
        assert(dlgError.textContent.includes('whole number from 0 to 99'), bad.join());
      }
      assert.equal(api.calls.length, 0, 'nothing was sent');
      await G.handlers.click['recruiting-reset']({ closest: () => ({}) });
      await settle();
      assert.deepEqual(api.calls.map(c => c.body), [{ targets: null }]);
    } finally { G.ui.runDialog = realRun; api.restore(); }
  }));

  // ═══ Applications inbox ═════════════════════════════════════════
  const APP = (over) => Object.assign({
    id: 'am_1', teamId: 't1', teamName: 'Team KJ', status: 'new', name: 'Hopeful', realm: null, class: 'MAGE', spec: 'Frost', contact: 'Hopeful#1234',
    answers: [{ label: 'Why us?', type: 'long', answer: 'Line one\nLine two' }], notes: null, createdAt: Date.UTC(2026, 9, 18, 12), updatedAt: 1,
    applicant: { displayName: 'Hopeful Account' }, onRoster: null, personId: null,
  }, over || {});
  const inboxState = (apps, counts, seg) => ({ gid: 'g1', seg: seg || 'new', data: { applications: apps, counts: counts || { new: apps.length, reviewing: 0, accepted: 0, declined: 0 } }, note: '' });

  await check('applications inbox: each application shows its character, answers, contact and account; segments carry counts; hostile text is escaped; decided ones lose their buttons', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const x = inboxState([APP(), APP({ id: 'am_2', status: 'accepted', name: 'Done', personId: 'p_x', applicant: null, notes: 'Good one' }), APP({ id: 'am_3', name: HOSTILE, contact: QUOTES, answers: [{ label: HOSTILE, type: 'short', answer: QUOTES }], onRoster: { personId: 'p_y', name: 'Thornwick' } })],
      { new: 2, reviewing: 1, accepted: 1, declined: 4 });
    const out = G.pages.applications.sectionHtml(S.guilds.g1, x);
    assertEscaped(out, 'inbox');
    assertNoRawAttrs(out);
    const text = stripTags(out);
    assert(text.includes('New 2') && text.includes('Reviewing 1') && text.includes('Closed 5') && !text.includes('Open 3') && !text.includes('All 8'), text.slice(0, 300));
    assert(/data-filter="new"[^>]*aria-pressed="true"/.test(out) && /data-filter="closed"[^>]*aria-pressed="false"/.test(out));
    assert(text.includes('Hopeful') && text.includes('Mage - Frost') && text.includes('Contact: Hopeful#1234') && text.includes('signed in as Hopeful Account'));
    assert(out.includes('Line one<br>Line two'));
    assert(text.includes('wants Team KJ'));
    assert(text.includes('is on the roster already') && out.includes('href="#/g/g1/roster/p/p_y"'));
    assert(!out.includes('id="app-am_2"'), 'the accepted one is in Closed');
    assert(out.includes('gs-hd-chip is-grey">New') && !out.includes('gs-btn-molten'), 'a neutral New chip, no orange');
    const fresh = out.split('<li class="gs-hd-panel gs-app-item gs-rc-app"').filter(s => s.includes('id="app-am_1"'))[0];
    assert(fresh.includes('data-action="app-accept-trial"') && fresh.includes('>Accept as Trial</button>') && fresh.includes('aria-label="More for Hopeful"'));
    assert(['app-accept', 'app-status-reviewing', 'app-status-declined', 'app-notes', 'app-delete'].every(a => fresh.includes('data-action="' + a + '"')), 'the rest sits under More');
    const closedList = G.pages.applications.sectionHtml(S.guilds.g1, Object.assign({}, x, { seg: 'closed' }));
    const accepted = closedList.split('<li class="gs-hd-panel gs-app-item gs-rc-app"').filter(s => s.includes('id="app-am_2"'))[0];
    assert(!accepted.includes('app-accept') && !accepted.includes('app-status-declined') && accepted.includes('Open the person') && accepted.includes('Officer notes') && accepted.includes('gs-hd-chip is-green">Accepted'));
    assert(stripTags(G.pages.applications.sectionHtml(S.guilds.g1, inboxState([], { new: 0, reviewing: 0, accepted: 0, declined: 0 }))).includes('No applications yet.'));
    assert(stripTags(G.pages.applications.sectionHtml(S.guilds.g1, inboxState([APP({ status: 'accepted' })], { new: 0, reviewing: 0, accepted: 1, declined: 0 }, 'new'))).includes('Nothing in this list.'));
    assert.deepEqual(plain(G.pages.applications.SEGMENTS.map(f => f[0])), ['new', 'reviewing', 'closed']);
    assert.equal(G.pages.applications.countFor({ new: 2, reviewing: 1, accepted: 1, declined: 4 }, 'closed'), 5);
  }));

  await check('applications inbox: Accept as Trial is one POST with the team, Decline and Reopen are one PATCH, Accept with options asks for the team and the team\'s trial length, notes and delete have dialogs; every request is the real route', withState(async (S, opened) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const x = S.att.applications = inboxState([APP()], null, 'new');
    const api = stub((m, url) => {
      if (m === 'get') return Promise.resolve({ applications: [APP({ status: 'declined' })], counts: { new: 0, reviewing: 0, accepted: 0, declined: 1 } });
      if (url.endsWith('/accept')) return Promise.resolve({ application: APP({ status: 'accepted' }), person: { id: 'p_n', name: 'Hopeful', teamId: 't1', trialEnd: '2026-11-01' }, accountLinked: true, accountSkipped: false });
      return Promise.resolve({ application: APP() });
    });
    const realRun = G.ui.runDialog; G.ui.runDialog = (form, promise, onOk) => promise.then(res => { if (onOk) onOk(res); });
    const refreshed = []; const realRefresh = G.app.refreshGuild; G.app.refreshGuild = (gid) => { refreshed.push(gid); };
    try {
      const btn = el({ 'data-apid': 'am_1' });
      // One click: the application's own team, no length (the Worker uses the team's).
      G.handlers.click['app-accept-trial'](btn);
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/applications/am_1/accept', { teamId: 't1' }], ['get', '/api/guild/g1/applications', undefined]]);
      assert(x.note.includes('joined on Trial until') && x.note.includes('Their account is linked.'));
      assert.deepEqual(refreshed, ['g1'], 'the guild (team counts, the Roster badge) is read again');
      api.calls.length = 0;
      G.handlers.click['app-status-declined'](btn);
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['patch', '/api/guild/g1/applications/am_1', { status: 'declined' }], ['get', '/api/guild/g1/applications', undefined]]);
      assert(x.note.includes('was declined'));
      // Segments only filter what was read; nothing is sent.
      api.calls.length = 0;
      G.handlers.click['apps-filter'](el({ 'data-filter': 'closed' }));
      assert.equal(x.seg, 'closed');
      G.handlers.click['apps-filter'](el({ 'data-filter': 'nonsense' }));
      assert.equal(x.seg, 'closed');
      assert.equal(api.calls.length, 0);
      // Accept with options: the dialog lists the teams the officer may edit and the team's own trial length.
      x.data = { applications: [APP()], counts: { new: 1, reviewing: 0, accepted: 0, declined: 0 } };
      G.handlers.click['app-accept'](btn);
      const dlg = opened[opened.length - 1].html;
      assert.deepEqual(optionsOf(dlg, 'aa-team').map(o => [o.value, o.selected]), [['t1', true], ['t2', false]]);
      assert(dlg.includes('value="' + G.pages.applications.trialDaysOf(S.guilds.g1, 't1') + '"') && dlg.includes('Their account is linked to them.'));
      S.guilds.g1.teams[0].trialDays = 21;
      assert(G.pages.applications.acceptDialogHtml(S.guilds.g1, APP()).includes('name="trialDays" value="21"'), 'the team\'s trial length is the default');
      assertNoRawAttrs(dlg);
      api.calls.length = 0;
      await G.handlers.submit['app-accept-form']({ getAttribute: () => 'am_1', elements: { teamId: control('t2'), trialDays: control('30') } });
      await settle();
      assert.deepEqual(api.calls[0], { m: 'post', url: '/api/guild/g1/applications/am_1/accept', body: { teamId: 't2', trialDays: 30 } });
      const bad = fakeEl('dlg-err-trialDays');
      api.calls.length = 0;
      await G.handlers.submit['app-accept-form']({ getAttribute: () => 'am_1', elements: { teamId: control('t1'), trialDays: control('0') } });
      assert.equal(api.calls.length, 0);
      assert.equal(bad.hidden, false);
      // Notes and delete.
      G.handlers.click['app-notes'](btn);
      assert(opened[opened.length - 1].html.includes('name="notes"'));
      await G.handlers.submit['app-notes-form']({ getAttribute: () => 'am_1', elements: { notes: control('Looks good') } });
      await settle();
      assert.deepEqual(api.calls[0], { m: 'patch', url: '/api/guild/g1/applications/am_1', body: { notes: 'Looks good' } });
      G.handlers.click['app-delete'](btn);
      assert(opened[opened.length - 1].html.includes('Delete this application?'));
      api.calls.length = 0;
      await G.handlers.submit['app-delete-form']({ getAttribute: () => 'am_1', elements: {} });
      await settle();
      assert.deepEqual(api.calls[0], { m: 'del', url: '/api/guild/g1/applications/am_1', body: {} });
      // A lead of Alpha accepts only onto their own team.
      S.guilds.g1 = gd(LEAD_CAN);
      G.handlers.click['app-accept'](btn);
      assert.deepEqual(optionsOf(opened[opened.length - 1].html, 'aa-team').map(o => o.value), ['t1']);
    } finally { G.ui.runDialog = realRun; G.app.refreshGuild = realRefresh; api.restore(); }
  }));

  // ═══ Guild settings > Applications ══════════════════════════════
  await check('settings: the switch and questions - the draft, the request body (ids kept, options per line), the checks and the address when it is on', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const data = { enabled: true, questions: [{ id: 'q1abcd', label: 'Why us?', type: 'long', options: [], required: true }, { id: 'q2abcd', label: 'Experience', type: 'choice', options: ['New', 'Veteran'], required: false }], maxQuestions: 8, path: '/#/apply/g1', counts: { new: 2, reviewing: 1, accepted: 0, declined: 0 } };
    const draft = G.pages.settingsApply.draftFrom(data);
    assert.deepEqual(plain(draft), { enabled: true, questions: [{ id: 'q1abcd', label: 'Why us?', type: 'long', options: '', required: true }, { id: 'q2abcd', label: 'Experience', type: 'choice', options: 'New\nVeteran', required: false }] });
    assert.deepEqual(plain(G.pages.settingsApply.bodyFrom({ enabled: true, questions: [...draft.questions, { id: '', label: ' Tag ', type: 'short', options: 'ignored', required: false }] })), {
      enabled: true,
      questions: [{ label: 'Why us?', type: 'long', required: true, id: 'q1abcd' }, { label: 'Experience', type: 'choice', required: false, id: 'q2abcd', options: ['New', 'Veteran'] }, { label: 'Tag', type: 'short', required: false }],
    });
    assert.deepEqual(plain(G.pages.settingsApply.problemOf({ questions: [{ label: '', type: 'short' }] })), { index: 0, text: 'Write the question.' });
    assert.equal(G.pages.settingsApply.problemOf({ questions: [{ label: 'x', type: 'choice', options: 'one' }] }).text.includes('at least two options'), true);
    assert.equal(G.pages.settingsApply.problemOf({ questions: [{ label: 'x', type: 'choice', options: 'a\nb' }] }), null);
    S.att.settingsApply = { gid: 'g1', data, draft, note: '', error: '', busy: false };
    const out = G.pages.settingsApply.main({ name: 'settings', gid: 'g1', tab: 'applications' }, S.guilds.g1, { guildData: S.guilds.g1 });
    assertNoRawAttrs(out);
    assert(out.includes('id="apply-url"') && out.includes('/#/apply/g1') && out.includes('data-action="apply-copy"'));
    assert(stripTags(out).includes('Your questions (2 of 8)') && stripTags(out).includes('2 new and 1 being reviewed'));
    assert(out.includes('id="aq-options-1"') && !out.includes('id="aq-options-0"'), 'options only for the choice');
    assert(/aria-label="Remove question 2"/.test(out));
    const off = G.pages.settingsApply.settingsHtml({ guildData: S.guilds.g1, state: { gid: 'g1', data: Object.assign({}, data, { enabled: false }), draft: Object.assign({}, draft, { enabled: false }), note: '', error: 'Question 1: Write the question.', busy: false }, alert: '' });
    assert(!off.includes('id="apply-url"') && off.includes('Question 1: Write the question.'));
    assertEscaped(G.pages.settingsApply.settingsHtml({ guildData: S.guilds.g1, state: { gid: 'g1', data, draft: { enabled: true, questions: [{ id: 'q1', label: HOSTILE + QUOTES, type: 'choice', options: HOSTILE, required: false }] }, note: '', error: '', busy: false }, alert: '' }), 'settings');
  }));

  await check('settings: Save sends the whole set; Add stops at 8 questions; a refusal names the question', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const data = { enabled: false, questions: [], maxQuestions: 8, path: '/#/apply/g1', counts: {} };
    const x = S.att.settingsApply = { gid: 'g1', data, draft: G.pages.settingsApply.draftFrom(data), note: '', error: '', busy: false };
    for (let i = 0; i < 10; i++) G.handlers.click['applyq-add']();
    assert.equal(x.draft.questions.length, 8);
    G.handlers.click['applyq-remove'](el({ 'data-index': '0' }));
    assert.equal(x.draft.questions.length, 7);
    x.draft.questions = [{ id: '', label: 'Why?', type: 'short', options: '', required: false }];
    x.draft.enabled = true;
    const saved = { enabled: true, questions: [{ id: 'qnewid', label: 'Why?', type: 'short', options: [], required: false }], maxQuestions: 8, path: '/#/apply/g1', counts: {} };
    let api = stub(() => Promise.resolve(saved));
    try {
      G.handlers.submit['apply-settings-form']();
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/applications/settings', { enabled: true, questions: [{ label: 'Why?', type: 'short', required: false }] }]]);
      assert.equal(x.note, 'Applications are on.');
      assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'applications');
      assert.equal(x.draft.questions[0].id, 'qnewid');
    } finally { api.restore(); }
    api = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'A question is 1 to 120 characters.', index: 0, field: 'questions' })));
    try {
      G.handlers.submit['apply-settings-form']();
      await settle();
      assert.equal(x.error, 'Question 1: A question is 1 to 120 characters.');
      assert.equal(x.busy, false);
    } finally { api.restore(); }
    // A draft the page can see is wrong stays home.
    x.draft.questions[0].label = '';
    api = stub(() => Promise.resolve(saved));
    try {
      G.handlers.submit['apply-settings-form']();
      assert.equal(api.calls.length, 0);
      assert.equal(x.error, 'Question 1: Write the question.');
    } finally { api.restore(); }
  }));

  // ═══ The apply form ═════════════════════════════════════════════
  const FORM = (over) => Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Nightslayer', realmKind: 'realm', region: 'US', gameVersion: 'tbc' },
    teams: [{ id: 't1', name: 'Team KJ' }],
    rosterOptions: ROSTER_OPTIONS,
    questions: [{ id: 'q1', label: 'Why us?', type: 'long', options: [], required: true }, { id: 'q2', label: 'Experience', type: 'choice', options: ['New', 'Veteran'], required: false }, { id: 'q3', label: 'Tag', type: 'short', options: [], required: false }],
    signedInAs: null,
  }, over || {});

  await check('apply form: the page for each state, the fields (realm only for a realm guild, team only with several), the honeypot, the sign-in note; hostile text is escaped', () => {
    const state = (over) => Object.assign({ gid: 'g1', status: 'ok', data: FORM(), draft: {}, busy: false, error: '', done: false }, over || {});
    const out = G.pages.apply.applyHtml({ state: state() });
    assertNoRawAttrs(out);
    assert(stripTags(out).includes('Apply to Ravens') && stripTags(out).includes('Nightslayer (US) - TBC Anniversary'));
    assert(out.includes('name="realm"') && out.includes('value="Nightslayer"') && !out.includes('name="teamId"'));
    assert(out.includes('name="website"') && out.includes('tabindex="-1"') && /class="gs-hp" aria-hidden="true"/.test(out));
    assert(out.includes('name="q:q1"') && out.includes('required') && out.includes('<textarea') && stripTags(out).includes('Experience (optional)'));
    assert.deepEqual(optionsOf(out, 'ap-class').map(o => o.value), ['', 'WARRIOR', 'PRIEST', 'MAGE', 'DRUID']);
    assert(out.includes('You can apply without an account') && out.includes('href="#/signin"'));
    const signed = G.pages.apply.applyHtml({ state: state({ data: FORM({ signedInAs: 'Hopeful Account' }) }) });
    assert(stripTags(signed).includes('Signed in as Hopeful Account') && !signed.includes('You can apply without an account'));
    const ruleset = G.pages.apply.applyHtml({ state: state({ data: FORM({ guild: { id: 'g1', name: 'Ravens', realm: 'Normal', realmKind: 'ruleset', region: 'US', gameVersion: 'forever' }, teams: [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }] }) }) });
    assert(!ruleset.includes('name="realm"') && ruleset.includes('name="teamId"') && optionsOf(ruleset, 'ap-team').length === 3);
    assert(stripTags(G.pages.apply.applyHtml({ state: state({ done: true }) })).includes('Application sent'));
    assert(stripTags(G.pages.apply.applyHtml({ state: state({ status: 'closed' }) })).includes('Not taking applications'));
    assert(stripTags(G.pages.apply.applyHtml({ state: state({ status: 'error', message: 'Could not reach Raidsmith.' }) })).includes('Could not reach Raidsmith.'));
    assert(G.pages.apply.applyHtml({ state: null }).length > 0);
    assertEscaped(G.pages.apply.applyHtml({ state: state({ data: FORM({ guild: { id: 'g1', name: HOSTILE + QUOTES, realm: HOSTILE, realmKind: 'realm', region: 'US', gameVersion: 'tbc' }, questions: [{ id: 'q1', label: HOSTILE + QUOTES, type: 'choice', options: [HOSTILE, QUOTES], required: false }] }), draft: { name: HOSTILE, contact: QUOTES } }) }), 'apply form');
  });

  await check('apply form: the request carries what was typed (and the hidden field as it is), checks come first, a refusal lands on its field, sending shows the thanks', withState(async (S) => {
    const formState = S.apply = { gid: 'g1', status: 'ok', data: FORM(), draft: {}, busy: false, error: '', done: false };
    const values = { name: ' Hopeful ', class: 'MAGE', spec: 'Frost', realm: ' Nightslayer ', contact: ' Hope#1 ', teamId: '', website: '', 'q:q1': 'Because', 'q:q2': 'Veteran', 'q:q3': '' };
    const form = { elements: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, control(v)])), querySelectorAll: () => [] };
    // The pure parts.
    const draft = { name: 'Hopeful', class: 'MAGE', spec: 'Frost', realm: 'Nightslayer', contact: 'Hope#1', teamId: '', answers: { q1: 'Because', q2: 'Veteran', q3: '' } };
    assert.deepEqual(plain(G.pages.apply.bodyFrom(draft, FORM(), '')), { name: 'Hopeful', class: 'MAGE', spec: 'Frost', website: '', teamId: 't1', realm: 'Nightslayer', contact: 'Hope#1', answers: { q1: 'Because', q2: 'Veteran' } });
    assert.deepEqual(plain(G.pages.apply.problemOf(Object.assign({}, draft, { name: '' }), FORM())), { field: 'name', text: 'Enter your character\'s name.' });
    assert.deepEqual(plain(G.pages.apply.problemOf(Object.assign({}, draft, { spec: '' }), FORM())), { field: 'spec', text: 'Choose a spec.' });
    assert.deepEqual(plain(G.pages.apply.problemOf(Object.assign({}, draft, { answers: {} }), FORM())), { field: 'answers.q1', text: 'Answer this question.' });
    assert.equal(G.pages.apply.problemOf(draft, FORM()), null);
    // A checked mistake never reaches the Worker.
    let api = stub(() => Promise.resolve({ ok: true }));
    const nameErr = fakeEl('ap-name-err');
    try {
      await G.handlers.submit['apply-form']({ elements: Object.assign({}, form.elements, { name: control('') }), querySelectorAll: () => [] });
      assert.equal(api.calls.length, 0);
      assert.equal(nameErr.hidden, false);
      // The real send.
      await G.handlers.submit['apply-form'](form);
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/apply/g1', { name: 'Hopeful', class: 'MAGE', spec: 'Frost', website: '', teamId: 't1', realm: 'Nightslayer', contact: 'Hope#1', answers: { q1: 'Because', q2: 'Veteran' } }]]);
      assert.equal(formState.done, true);
    } finally { api.restore(); }
    // A script that filled the hidden field is sent as it is (the Worker drops it).
    formState.done = false; formState.busy = false;
    api = stub(() => Promise.resolve({ ok: true }));
    try {
      await G.handlers.submit['apply-form']({ elements: Object.assign({}, form.elements, { website: control('http://spam') }), querySelectorAll: () => [] });
      await settle();
      assert.equal(api.calls[0].body.website, 'http://spam');
    } finally { api.restore(); }
    // A refusal that names a field is shown at the field.
    formState.done = false; formState.busy = false;
    const realmErr = fakeEl('ap-realm-err');
    api = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'That realm is not valid.', field: 'realm' })));
    try {
      await G.handlers.submit['apply-form'](form);
      await settle();
      assert(realmErr.innerHTML.includes('That realm is not valid.') && realmErr.hidden === false);
      assert.equal(formState.done, false);
      assert.equal(formState.busy, false);
    } finally { api.restore(); }
    // One without a field goes to the general line.
    formState.busy = false;
    const general = fakeEl('ap-error');
    api = stub(() => Promise.reject(new ApiErr(409, 'already_applied', { message: 'You already have an application waiting with this guild.' })));
    try {
      await G.handlers.submit['apply-form'](form);
      await settle();
      assert.equal(general.textContent, 'You already have an application waiting with this guild.');
    } finally { api.restore(); }
  }));

  await check('apply form: opening it asks the Worker; a guild that takes none (404) says so, other failures offer Try again; choosing a class fills the spec list', withState(async (S) => {
    let api = stub(() => Promise.resolve(FORM()));
    try {
      const x = await G.pages.apply.load({ name: 'apply', gid: 'g1' });
      assert.deepEqual([x.status, api.calls[0].url], ['ok', '/api/apply/g1']);
    } finally { api.restore(); }
    api = stub(() => Promise.reject(new ApiErr(404, 'not_found', { message: 'This guild is not taking applications.' })));
    try { assert.equal((await G.pages.apply.load({ name: 'apply', gid: 'g1' })).status, 'closed'); } finally { api.restore(); }
    api = stub(() => Promise.reject(new ApiErr(0, 'network', {})));
    try { assert.equal((await G.pages.apply.load({ name: 'apply', gid: 'g1' })).status, 'error'); } finally { api.restore(); }
    S.apply = { gid: 'g1', status: 'ok', data: FORM(), draft: {}, busy: false, error: '', done: false };
    const specSel = { innerHTML: '' };
    G.handlers.change['apply-class']({ value: 'PRIEST', closest: () => ({ elements: { spec: specSel } }) });
    assert.deepEqual([...specSel.innerHTML.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]), ['', 'Discipline', 'Holy', 'Shadow']);
  }));

  // ═══ CSV import page ════════════════════════════════════════════
  const CSV_PREVIEW = () => ({
    header: true, columns: ['name', 'class'], team: { id: 't1', name: 'Team KJ' },
    rows: [
      { line: 2, name: 'Newwarr', class: 'WARRIOR', spec: 'Protection', realm: null, teamId: 't1', teamName: 'Team KJ', status: 'trial', joinedOn: '2026-10-01', owner: 'Pat', isAlt: false, problems: [], notes: [], taken: null, action: 'new', withLine: null, needsDecision: false, suggestion: null },
      { line: 3, name: 'Newmage', class: 'MAGE', spec: 'Fire', realm: null, teamId: 't2', teamName: 'Weekend team', status: 'raider', joinedOn: null, owner: 'Pat', isAlt: true, problems: [], notes: ['A note.'], taken: null, action: 'alt', withLine: 2, needsDecision: false, suggestion: null },
      { line: 4, name: 'Thornwick', class: 'WARRIOR', spec: 'Arms', realm: null, teamId: 't1', teamName: 'Team KJ', status: 'raider', joinedOn: null, owner: null, isAlt: null, problems: [], notes: [], taken: { personId: 'p_t', name: 'Thornwick' }, action: 'skip', withLine: null, needsDecision: false, suggestion: null },
      { line: 5, name: 'Lonelyalt', class: 'ROGUE', spec: null, realm: null, teamId: 't1', teamName: 'Team KJ', status: 'raider', joinedOn: null, owner: 'Thornwick', isAlt: true, problems: [], notes: [], taken: null, action: 'alt', withLine: null, needsDecision: true, suggestion: { personId: 'p_t', name: 'Thornwick' } },
      { line: 6, name: 'Orphan', class: 'PRIEST', spec: 'Holy', realm: null, teamId: 't1', teamName: 'Team KJ', status: 'raider', joinedOn: null, owner: 'Nobody', isAlt: true, problems: [], notes: [], taken: null, action: 'alt', withLine: null, needsDecision: true, suggestion: null },
      { line: 7, name: null, class: null, spec: null, realm: null, teamId: 't1', teamName: 'Team KJ', status: 'raider', joinedOn: null, owner: null, isAlt: null, problems: ['The class is missing.'], notes: [], taken: null, action: 'skip', withLine: null, needsDecision: false, suggestion: null },
    ],
    totals: { rows: 6, people: 1, alts: 3, taken: 1, problems: 1 },
  });

  await check('CSV import: the plan follows the choices - new, alt of the main in the file, alt of someone on the roster, a person of its own, skipped; the body carries only rows that do something', () => {
    const pv = CSV_PREVIEW();
    const choices = G.pages.importCsv.csvInitChoices(pv);
    assert.deepEqual(plain(choices[5]), { ticked: true, pick: 'alt', personId: 'p_t' }, 'the suggestion is preselected');
    assert.deepEqual(plain(choices[6]), { ticked: true, pick: 'new', personId: '' });
    assert.deepEqual([choices[4].ticked, choices[7].ticked], [false, false], 'a taken row and a problem row are not included');
    let plan = G.pages.importCsv.csvPlan(pv, choices);
    assert.deepEqual([plan.people, plan.alts, plan.needs, plan.skipped], [2, 2, 0, 2]);
    assert.equal(G.pages.importCsv.csvSummary(plan), '2 new people, 2 Alts - 2 skipped');
    const body = G.pages.importCsv.csvCommitBody('t1', pv, choices, 'raider');
    assert.deepEqual(plain(body), {
      teamId: 't1',
      rows: [
        { line: 2, action: 'new', name: 'Newwarr', class: 'WARRIOR', spec: 'Protection', realm: null, teamId: 't1', status: 'trial', joinedOn: '2026-10-01' },
        { line: 3, action: 'alt', name: 'Newmage', class: 'MAGE', spec: 'Fire', realm: null, teamId: 't2', status: 'raider', withLine: 2 },
        { line: 5, action: 'alt', name: 'Lonelyalt', class: 'ROGUE', spec: null, realm: null, teamId: 't1', status: 'raider', personId: 'p_t' },
        { line: 6, action: 'new', name: 'Orphan', class: 'PRIEST', spec: 'Holy', realm: null, teamId: 't1', status: 'raider' },
      ],
    });
    // Unticking the main leaves its alt without one: the row needs an answer, and the body leaves it out.
    choices[2].ticked = false;
    plan = G.pages.importCsv.csvPlan(pv, choices);
    assert.deepEqual([plan.people, plan.alts, plan.needs], [1, 1, 1]);
    assert(G.pages.importCsv.csvSummary(plan).includes('1 row needs an answer'));
    assert.equal(G.pages.importCsv.csvCommitBody('t1', pv, choices, 'raider').rows.some(r => r.line === 3), false);
    // "Alt of someone else" with nobody chosen is an open question; skipping the row drops it.
    choices[5].pick = 'alt'; choices[5].personId = '';
    assert.equal(G.pages.importCsv.csvPlan(pv, choices).needs, 2);
    choices[5].pick = 'skip';
    assert.equal(G.pages.importCsv.csvPlan(pv, choices).needs, 1);
    assert.equal(G.pages.importCsv.csvSummary(G.pages.importCsv.csvPlan({ rows: [] }, {})), 'Nothing to save yet');
  });

  await check('CSV import: the page shows the input, then the rows with their outcome and questions; hostile text is escaped; Save is off until nothing is open', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const csv = G.pages.importCsv.ensureState('g1', 't1');
    const fresh = G.pages.importCsv.csvHtml({ guildData: S.guilds.g1, csv, people: [] });
    assert(fresh.includes('name="text"') && fresh.includes('type="file"') && stripTags(fresh).includes('at most 500'));
    assert.deepEqual(optionsOf(fresh, 'csv-status').map(o => o.value), ['raider', 'trial', 'reserve']);
    assert(!fresh.includes('csv-commit'));
    csv.preview = CSV_PREVIEW(); csv.choices = G.pages.importCsv.csvInitChoices(csv.preview);
    const people = [{ id: 'p_t', main: { name: 'Thornwick' } }, { id: 'p_u', main: { name: 'Umbra' } }];
    const out = G.pages.importCsv.csvHtml({ guildData: S.guilds.g1, csv, people });
    assertNoRawAttrs(out);
    const text = stripTags(out);
    assert(text.includes('6 rows read') && text.includes('Alt of Newwarr') && text.includes('New person (Main)') && text.includes('On the roster') && text.includes('The class is missing.') && text.includes('A note.'));
    assert.deepEqual(optionsOf(out, 'csv-5-choice').map(o => [o.value, o.selected]), [['alt:p_t', true], ['other', false], ['new', false], ['skip', false]]);
    assert(optionsOf(out, 'csv-6-choice').every(o => o.value !== 'alt:p_t'), 'no suggestion for the orphan');
    assert(/data-action="csv-commit"[^>]*><span>Save 4 changes<\/span><\/button>/.test(out) && !/<button[^>]*disabled[^>]*data-action="csv-commit"/.test(out));
    assert(out.includes('id="csv-footer"') && out.includes('Nothing is saved yet.') && out.includes('data-action="csv-back"'), 'the T5 commit bar');
    csv.choices[6].pick = 'alt'; csv.choices[6].personId = '';
    const open = G.pages.importCsv.csvHtml({ guildData: S.guilds.g1, csv, people });
    assert.deepEqual(optionsOf(open, 'csv-6-person').map(o => o.value), ['', 'p_t', 'p_u']);
    assert(/<button[^>]*disabled[^>]*data-action="csv-commit"/.test(open), 'a row waits for an answer');
    const hostile = CSV_PREVIEW(); hostile.rows[0].name = HOSTILE; hostile.rows[0].teamName = QUOTES; hostile.rows[3].problems = [HOSTILE];
    csv.preview = hostile; csv.choices = G.pages.importCsv.csvInitChoices(hostile); csv.error = HOSTILE;
    assertEscaped(G.pages.importCsv.csvHtml({ guildData: S.guilds.g1, csv, people }), 'csv page');
  }));

  await check('CSV import: Preview sends the text and starting status, ticks and answers redraw, Save sends the plan and goes back to the Roster with a notice; a row error is marked on its row', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const csv = G.pages.importCsv.ensureState('g1', 't1');
    S.imports = { csv };
    G.handlers.input['csv-text']({ value: 'name,class\nA,Mage' });
    G.handlers.change['csv-start']({ value: 'trial' });
    G.handlers.change['csv-start']({ value: 'inactive' });
    assert.equal(csv.defaultStatus, 'trial');
    const api = stub((m, url) => (url.endsWith('/preview') ? Promise.resolve(CSV_PREVIEW()) : Promise.resolve({ people: 2, characters: 4, rosterFlags: { t1: 0 } })));
    try {
      await G.handlers.submit['csv-load']();
      await settle();
      assert.deepEqual(plain(api.calls[0]), { m: 'post', url: '/api/guild/g1/roster/import/csv/preview', body: { teamId: 't1', text: 'name,class\nA,Mage', defaultStatus: 'trial' } });
      assert.equal(csv.status, 'ready');
      G.handlers.change['csv-tick'](el({ 'data-line': '3' }, { checked: false }));
      assert.equal(csv.choices[3].ticked, false);
      G.handlers.change['csv-tick'](el({ 'data-line': '3' }, { checked: true }));
      G.handlers.change['csv-choice'](el({ 'data-line': '6' }, { value: 'other' }));
      assert.deepEqual(plain(csv.choices[6]), { ticked: true, pick: 'alt', personId: '' });
      G.handlers.change['csv-person'](el({ 'data-line': '6' }, { value: 'p_u' }));
      assert.equal(csv.choices[6].personId, 'p_u');
      // The commit is refused while a row waits for an answer; with the answer it goes.
      G.handlers.change['csv-choice'](el({ 'data-line': '6' }, { value: 'other' }));
      api.calls.length = 0;
      await G.handlers.click['csv-commit']();
      assert.equal(api.calls.length, 0);
      G.handlers.change['csv-choice'](el({ 'data-line': '6' }, { value: 'new' }));
      await G.handlers.click['csv-commit']();
      await settle();
      assert.equal(api.calls[0].url, '/api/guild/g1/roster/import/csv/commit');
      assert.equal(api.calls[0].body.rows.length, 4);
      assert.equal(S.went, undefined, 'the officer stays on the import page');
      assert.equal(csv.result.title, 'Added 2 people and 4 characters from the CSV file.');
      const done = G.pages.importCsv.csvHtml({ guildData: S.guilds.g1, csv, people: [] });
      assert(done.includes('id="csv-result-banner"') && done.includes('Added 2 people and 4 characters') && done.includes('data-action="csv-again"') && !done.includes('id="csv-footer"'));
    } finally { api.restore(); }
    // A row error from the Worker marks the row (the index is into the rows that were sent).
    const csv2 = G.pages.importCsv.ensureState('g1', 't1');
    S.imports = { csv: csv2 };
    csv2.result = null; csv2.preview = CSV_PREVIEW(); csv2.choices = G.pages.importCsv.csvInitChoices(csv2.preview); csv2.status = 'ready';
    const api2 = stub(() => Promise.reject(new ApiErr(409, 'name_taken', { message: 'Newmage is already on the roster.', index: 1, field: 'name' })));
    try {
      await G.handlers.click['csv-commit']();
      await settle();
      assert.equal(csv2.rowErrors[3], 'Newmage is already on the roster.');
      assert(csv2.error.includes('One row could not be saved'));
      assert(stripTags(G.pages.importCsv.csvHtml({ guildData: S.guilds.g1, csv: csv2, people: [] })).includes('Newmage is already on the roster.'));
    } finally { api2.restore(); }
  }));

  // ═══ Home: new applications ═════════════════════════════════════
  await check('Home: new applications are a line per team that opens the inbox', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const item = { id: 'applications:t1', kind: 'applications', severity: 'action', teamId: 't1', teamName: 'Team KJ', count: 2, link: { name: 'applications' } };
    assert.equal(G.pages.attention.itemText(item), '2 new applications waiting');
    assert.equal(G.pages.attention.itemText(Object.assign({}, item, { count: 1 })), '1 new application waiting');
    const out = G.pages.attention.attentionHtml({ guildData: S.guilds.g1, data: { today: '2026-10-18', total: 1, items: [item], more: {}, onboarding: null } });
    assert(out.includes('href="#/g/g1/roster/applications"') && out.includes('2 new applications waiting') && out.includes('New applications') === false && out.includes('<span>Review</span>'), out.slice(0, 600));
    assertNoRawAttrs(out);
  }));

  await check('privacy: Delete my data now says it removes the applications you sent and the notes on intent picks', () => {
    const out = G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [], autoPromote: [] }, '');
    assert(stripTags(out).includes('deletes the applications you sent to a guild while signed in, and the notes you wrote on intent picks'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
