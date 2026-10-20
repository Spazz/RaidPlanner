/**
 * Raidsmith guild UI, Phase 2 (roster) - tests for the roster, person record and import pages.
 * Run: node guild-roster-ui-tests.js
 *
 * Same approach as guild-ui-tests.js: the pages' shared guild script list (tests/guild-scripts.js) is loaded in a vm sandbox with no DOM,
 * and the render functions return HTML strings. Mock API data follows the Phase 2 response contract
 * (tasks/guild-phase2-spec.md, "Response contract") field for field. Handlers that talk to the API run against a
 * stubbed G.api; render() is a no-op without a page, so the state they leave behind is what is asserted.
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
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const css = read('guild.css');
const scriptSrcs = GUILD_SCRIPTS;

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout };
  vm.createContext(sandbox);
  for (const src of scriptSrcs) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] }; // handlers touch the DOM only through these
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}
const stripTags = s => s.replace(/<[^>]*>/g, '');
const count = (text, re) => (text.match(re) || []).length;
// Attribute NAMES only: quoted values are blanked first, so escaped hostile text inside a value is not a handler.
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

// ── fixtures (contract shapes) ───────────────────────────────────
const ROSTER_OPTIONS = {
  classes: ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'].map(id => ({ id, name: id.charAt(0) + id.slice(1).toLowerCase() })),
  specs: {
    WARRIOR: ['Arms', 'Fury', 'Protection'], PALADIN: ['Holy', 'Protection', 'Retribution'], HUNTER: ['Beast Mastery', 'Marksmanship', 'Survival'],
    ROGUE: ['Assassination', 'Combat', 'Subtlety'], PRIEST: ['Discipline', 'Holy', 'Shadow'], SHAMAN: ['Elemental', 'Enhancement', 'Restoration'],
    MAGE: ['Arcane', 'Fire', 'Frost'], WARLOCK: ['Affliction', 'Demonology', 'Destruction'], DRUID: ['Balance', 'Feral (DPS)', 'Feral (Tank)', 'Restoration'],
  },
  roles: {
    WARRIOR: { Arms: 'dps', Fury: 'dps', Protection: 'tank' }, PALADIN: { Holy: 'healer', Protection: 'tank', Retribution: 'dps' },
    PRIEST: { Discipline: 'healer', Holy: 'healer', Shadow: 'dps' }, DRUID: { Balance: 'dps', 'Feral (DPS)': 'dps', 'Feral (Tank)': 'tank', Restoration: 'healer' },
    MAGE: { Arcane: 'dps', Fire: 'dps', Frost: 'dps' }, WARLOCK: { Affliction: 'dps', Demonology: 'dps', Destruction: 'dps' },
    HUNTER: { 'Beast Mastery': 'dps', Marksmanship: 'dps', Survival: 'dps' }, SHAMAN: { Elemental: 'dps', Enhancement: 'dps', Restoration: 'healer' },
    ROGUE: { Assassination: 'dps', Combat: 'dps', Subtlety: 'dps' },
  },
};
const TEAM_MAIN = { id: 't_main', name: 'Main team' };
const TEAM_WEEKEND = { id: 't_weekend', name: 'Weekend team' };

function guildData(opts) {
  const o = Object.assign({ teams: [TEAM_MAIN], can: { 'roster.edit': 'guild', 'roster.notes.view': 'guild', 'roster.notes.edit': 'guild', 'guild.teams': 'guild' }, flags: { t_main: 2 } }, opts || {});
  return {
    guild: { id: 'g1', name: 'Bantr', realm: 'Normal', region: 'US', timeZone: 'America/New_York', gameVersion: 'forever', realmKind: 'ruleset', realmSlug: null, createdAt: 1 },
    teams: o.teams.map(t => ({ id: t.id, name: t.name, size: 25, archived: !!t.archived, players: t.players == null ? 3 : t.players, leads: [], trialDays: t.trialDays })),
    me: { roles: [{ role: 'officer' }], can: o.can },
    rosterOptions: ROSTER_OPTIONS,
    rosterFlags: o.flags,
  };
}
const MEMBER_CAN = { 'roster.view': 'guild' };

// The Worker's raidRole of a character (worker/recruit-data.js): tank, healer, melee or ranged.
const MELEE_SPECS = { WARRIOR: ['Arms', 'Fury'], ROGUE: ['Assassination', 'Combat', 'Subtlety'], PALADIN: ['Retribution'], SHAMAN: ['Enhancement'], HUNTER: ['Survival'], DRUID: ['Feral (DPS)'] };
function raidRoleOf(cls, spec) {
  const role = (ROSTER_OPTIONS.roles[cls] || {})[spec];
  if (role === 'tank' || role === 'healer') return role;
  if (role !== 'dps') return null;
  return (MELEE_SPECS[cls] || []).includes(spec) ? 'melee' : 'ranged';
}

function rp(id, name, cls, mainSpec, offSpec, status, extra) {
  const e = extra || {};
  const home = e.homeTeam || TEAM_MAIN;
  const main = { id: 'c_' + id, name: e.mainName || name, class: e.mainClass || cls, team: home };
  return {
    id: 'p_' + id, status, joinedOn: e.joinedOn === undefined ? '2026-06-14' : e.joinedOn, trialStart: null, trialEnd: e.trialEnd || null, trialFlag: e.flag || null,
    shown: { id: 'c_' + id + (e.alt ? 'a' : ''), name, class: cls, mainSpec, offSpec, role: e.role === undefined ? (ROSTER_OPTIONS.roles[cls] || {})[mainSpec] || null : e.role, isMain: !e.alt },
    main: e.alt ? { id: 'c_' + id, name: e.mainName || 'Mainchar', class: e.mainClass || 'PALADIN', team: home } : main,
    altCount: e.alts || 0, signIn: e.signIn || 'not_yet', isMe: !!e.isMe,
    raidRole: e.raidRole !== undefined ? e.raidRole : raidRoleOf(cls, mainSpec),
  };
}

const PEOPLE = [
  rp(1, 'Ashcaller', 'WARLOCK', 'Destruction', 'Affliction', 'raider', { alts: 2 }),
  rp(2, 'Brightmane', 'PALADIN', 'Holy', 'Retribution', 'raider', { alts: 1 }),
  rp(3, 'Corvane', 'WARRIOR', 'Fury', 'Protection', 'trial', { joinedOn: '2026-10-15', trialEnd: '2026-11-12', signIn: 'no_discord' }),
  rp(5, 'Frostwhisper', 'MAGE', 'Frost', 'Fire', 'trial', { joinedOn: '2026-09-22', trialEnd: '2026-10-20', flag: { kind: 'ends', days: 5 } }),
  rp(6, 'Kaelith', 'DRUID', 'Feral (Tank)', 'Restoration', 'raider'),
  rp(7, 'Quickshade', 'ROGUE', 'Combat', null, 'raider', { joinedOn: null }),
  rp(8, 'Sølvhand', 'PALADIN', 'Protection', 'Holy', 'trial', { joinedOn: '2026-09-15', trialEnd: '2026-10-13', flag: { kind: 'ended', days: -2 }, alts: 1, signIn: 'signed_in' }),
  rp(9, 'Stormjaw', 'SHAMAN', 'Enhancement', 'Restoration', 'raider', { alts: 1 }),
  rp(10, 'Solder', 'HUNTER', 'Marksmanship', 'Survival', 'reserve'),
  rp(11, 'Sorin', 'PRIEST', 'Shadow', 'Holy', 'raider'),
  rp(12, 'Oldtimer', 'WARRIOR', 'Arms', 'Fury', 'inactive'),
];
function rosterData(over) {
  return Object.assign({ team: { id: 't_main', name: 'Main team', archived: false }, today: '2026-10-15', can: { edit: true }, people: PEOPLE.map(p => plain(p)) }, over || {});
}
const names = list => list.map(p => p.shown.name);
const EDIT_FILTER = { role: 'all', status: 'active', query: '' };

function view(over) { return Object.assign({ sort: G.rosterSort.DEFAULT_SORT, role: 'all', status: 'active', query: '' }, over || {}); }
function rosterPage(gd, data, v, extra) { return G.pages.roster.rosterHtml(Object.assign({ guildData: gd, data, view: view(v) }, extra || {})); }

// ── router ───────────────────────────────────────────────────────
(async () => {
  await check('router: the four roster routes parse and format, archived team in the hash', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/g/g1/roster'), { name: 'section', gid: 'g1', section: 'roster' });
    assert.deepEqual(p('#/g/g1/roster?team=t_old'), { name: 'section', gid: 'g1', section: 'roster', team: 't_old' });
    assert.deepEqual(p('#/g/g1/roster/p/p_abc'), { name: 'person', gid: 'g1', pid: 'p_abc' });
    assert.deepEqual(p('#/g/g1/roster/import/raid-helper'), { name: 'import', gid: 'g1', source: 'raid-helper' });
    assert.deepEqual(p('#/g/g1/roster/import/wcl'), { name: 'import', gid: 'g1', source: 'wcl' });
    for (const h of ['#/g/g1/roster/import', '#/g/g1/roster/import/other', '#/g/g1/roster/p', '#/g/g1/roster/p/a/b', '#/g/g1/raids/p/p_1', '#/g/g1/roster/p/<x>']) {
      assert.equal(p(h).name, 'notfound', h);
    }
    for (const r of [{ name: 'section', gid: 'g1', section: 'roster', team: 't_old' }, { name: 'person', gid: 'g1', pid: 'p_abc' }, { name: 'import', gid: 'g1', source: 'wcl' }]) {
      assert.deepEqual(p(G.router.format(r)), r);
    }
    assert.equal(G.router.format({ name: 'section', gid: 'g1', section: 'raids', team: 't_old' }), '#/g/g1/raids', 'team only rides on the roster route');
  });

  // ── sort and filter ────────────────────────────────────────────
  await check('roster sort: Player A-Z by default, and Solvhand with an o-slash sorts with "So"', () => {
    const sorted = names(G.rosterSort.sortPeople(PEOPLE, G.rosterSort.DEFAULT_SORT));
    assert.deepEqual(sorted.slice(0, 3), ['Ashcaller', 'Brightmane', 'Corvane']);
    const i = sorted.indexOf('Sølvhand');
    assert(sorted.indexOf('Solder') < i && i < sorted.indexOf('Sorin') && sorted.indexOf('Sorin') < sorted.indexOf('Stormjaw'), sorted.join(','));
    assert.deepEqual(names(G.rosterSort.sortPeople(PEOPLE, { column: 'player', dir: 'desc' }))[0], 'Stormjaw');
  });

  await check('roster sort: status order is Raider, Trial, Reserve, Inactive; empty dates and off specs sort last in both directions', () => {
    const byStatus = G.rosterSort.sortPeople(PEOPLE, { column: 'status', dir: 'asc' }).map(p => p.status);
    assert.deepEqual([...new Set(byStatus)], ['raider', 'trial', 'reserve', 'inactive']);
    assert.equal(G.rosterSort.sortPeople(PEOPLE, { column: 'joined', dir: 'asc' }).pop().shown.name, 'Quickshade');
    assert.equal(G.rosterSort.sortPeople(PEOPLE, { column: 'joined', dir: 'desc' }).pop().shown.name, 'Quickshade');
    assert.equal(G.rosterSort.sortPeople(PEOPLE, { column: 'offSpec', dir: 'desc' }).pop().shown.name, 'Quickshade');
    assert.equal(G.rosterSort.sortPeople(PEOPLE, { column: 'alts', dir: 'desc' })[0].shown.name, 'Ashcaller');
    assert.deepEqual(plain(G.rosterSort.nextSort({ column: 'player', dir: 'asc' }, 'player')), { column: 'player', dir: 'desc' });
    assert.deepEqual(plain(G.rosterSort.nextSort({ column: 'player', dir: 'desc' }, 'status')), { column: 'status', dir: 'asc' });
    assert.equal(G.rosterSort.ariaSort({ column: 'status', dir: 'desc' }, 'status'), 'descending');
    assert.equal(G.rosterSort.ariaSort({ column: 'status', dir: 'desc' }, 'joined'), null);
  });

  await check('roster filter: Active hides Inactive, Everyone shows all, and "Trials to decide" is the flagged people of this home team', () => {
    const f = (status, extra) => names(G.rosterSort.filterPeople(PEOPLE, Object.assign({ role: 'all', query: '' }, extra || {}, { status }), 't_main'));
    assert(!f('active').includes('Oldtimer') && f('active').length === 10);
    assert.equal(f('everyone').length, 11);
    assert.deepEqual(f('inactive'), ['Oldtimer']);
    assert.deepEqual(f('trial').sort(), ['Corvane', 'Frostwhisper', 'Sølvhand']);
    assert.deepEqual(f('decide').sort(), ['Frostwhisper', 'Sølvhand']);
    const otherHome = plain(PEOPLE).map(p => (p.shown.name === 'Frostwhisper' ? Object.assign(p, { main: Object.assign({}, p.main, { team: TEAM_WEEKEND }) }) : p));
    assert.deepEqual(names(G.rosterSort.trialsToDecide(otherHome, 't_main')), ['Sølvhand'], 'a trial whose home team is another team is not this team\'s to decide');
    assert.deepEqual(f('active', { role: 'tank' }).sort(), ['Kaelith', 'Sølvhand']);
    assert.deepEqual(f('active', { query: 'frost' }), ['Frostwhisper']);
  });

  await check('roster filter: role counts come from the active people only', () => {
    const c = G.rosterSort.roleCounts(PEOPLE);
    assert.deepEqual(plain(c), { all: 10, tank: 2, healer: 1, dps: 7 });
    assert.equal(G.rosterSort.activeCount(PEOPLE), 10);
    assert.equal(G.rosterSort.inactiveCount(PEOPLE), 1);
  });

  await check('roster filter: the search finds a person by their Main name when an Alt is shown', () => {
    const alt = rp(20, 'Mistbrew', 'SHAMAN', 'Elemental', 'Restoration', 'raider', { alt: true, mainName: 'Mistvale', mainClass: 'SHAMAN', homeTeam: TEAM_MAIN });
    assert.equal(G.rosterSort.filterPeople([alt], { role: 'all', status: 'active', query: 'mistvale' }, 't_main').length, 1);
    assert.equal(G.rosterSort.filterPeople([alt], { role: 'all', status: 'active', query: 'mistbrew' }, 't_main').length, 1);
    assert.equal(G.rosterSort.filterPeople([alt], { role: 'all', status: 'active', query: 'zzz' }, 't_main').length, 0);
  });

  // ── trial copy ─────────────────────────────────────────────────
  await check('trial copy for -2..8 days: ends today / tomorrow / in n days, ended yesterday / n days ago, nothing past 7 days', () => {
    const flagFor = d => (d < 0 ? { kind: 'ended', days: d } : d <= 7 ? { kind: 'ends', days: d } : null);
    const expected = { '-2': 'Ended 2 days ago', '-1': 'Ended yesterday', 0: 'Ends today', 1: 'Ends tomorrow', 2: 'Ends in 2 days', 5: 'Ends in 5 days', 7: 'Ends in 7 days', 8: '' };
    for (let d = -2; d <= 8; d++) {
      const want = expected[String(d)];
      if (want === undefined) continue;
      assert.equal(G.ui.trialCopy(flagFor(d)), want, 'days ' + d);
    }
    assert.equal(G.ui.trialCopy(null), '');
    assert.equal(G.ui.trialChipHtml(null), '');
    assert(G.ui.trialChipHtml({ kind: 'ended', days: -2 }).includes('gs-trial-ended'));
    assert(G.ui.trialChipHtml({ kind: 'ends', days: 5 }).includes('gs-trial-ends'));
  });

  await check('dates: formatDay and addDays work on calendar days with no time zone', () => {
    assert.equal(G.ui.formatDay('2026-10-13'), 'Oct 13, 2026');
    assert.equal(G.ui.formatDay('2026-13-01'), '');
    assert.equal(G.ui.formatDay(null), '');
    assert.equal(G.ui.addDays('2026-10-15', 28), '2026-11-12');
    assert.equal(G.ui.addDays('2026-12-25', 14), '2027-01-08');
  });

  // ── roster page ────────────────────────────────────────────────
  const DOT = String.fromCharCode(183);
  const OSLASH = String.fromCharCode(248);
  const deskOf = out => out.slice(out.indexOf('class="gs-rs-desk"'), out.indexOf('class="gs-rs-phone"'));
  const phoneOf = out => out.slice(out.indexOf('class="gs-rs-phone"'));
  const rowNames = html => [...html.matchAll(/<span class="gs-rs-name [^"]*">([^<]*)</g)].map(m => m[1]);

  await check('roster page: head and context, the One More menu (imports and Show inactive people), Add person as the one primary, search and Active / Everyone', () => {
    const out = rosterPage(guildData(), rosterData());
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Roster</h1>'));
    assert(out.includes('Main team ' + DOT + ' 9 raiders and trials ' + DOT + ' 1 reserve'), 'the context line counts raiders, trials and reserve');
    // The imports are items of the page's one More menu; Add person is the one primary.
    assert(out.includes('id="roster-more"') && out.includes('aria-haspopup="menu"') && !out.includes('roster-import-menu'));
    assert(out.includes('Import from a Raid-Helper event') && out.includes('href="#/g/g1/roster/import/raid-helper"'));
    assert(out.includes('Import from a Warcraft Logs report') && out.includes('href="#/g/g1/roster/import/wcl"'));
    assert(out.includes('data-action="roster-show-inactive"') && out.includes('Show inactive people (1)'), 'the inactive people are behind a More item');
    assert(out.includes('data-action="roster-add"') && out.includes('>Add person<') && count(out, /gs-btn-molten/g) === 1, 'one primary');
    assert(out.includes('id="roster-search"') && out.includes('Search people or characters'));
    assert(/data-seg="active"[^>]*aria-pressed="true">Active <span class="gs-fg-segn">10<\/span>/.test(out) && /data-seg="everyone"[^>]*aria-pressed="false">Everyone <span class="gs-fg-segn">11<\/span>/.test(out));
    assert(!out.includes('<table') && !out.includes('Sign-in') && !out.includes('gs-trial-strip') && !out.includes('<select'), 'no table, no Sign-in column, no trial strip, no status select');
    assert(!out.includes('Oldtimer'), 'Active hides Inactive');
    assert(out.includes('1 inactive person is hidden.') && out.includes('>Show them<'), 'the footer link says who is hidden');
  });

  await check('roster page: four role columns by raidRole, You in A-Z place, reserves under a Reserve label, headers "TANKS 2 / 3" for officers (targets from /recruiting) and "TANKS 2" for members', () => {
    const shape = { status: 'ready', cov: null, data: { targets: { tank: 3, healer: 6, melee: 8, ranged: 8 }, roster: { counts: { tank: 2, healer: 1, melee: 3, ranged: 3 }, gaps: { tank: 1, healer: 5, melee: 5, ranged: 5 } } } };
    const out = rosterPage(guildData(), rosterData(), {}, { shape });
    const desk = deskOf(out);
    assert.deepEqual([...desk.matchAll(/data-role="(\w+)"><h3/g)].map(m => m[1]), ['tank', 'healer', 'melee', 'ranged']);
    const heads = [...desk.matchAll(/<h3 class="gs-fg-gh gs-rs-colhead">([^<]*) <b>(\d+)<\/b>(?:<span class="gs-rs-den">([^<]*)<\/span>)?/g)].map(m => m[1] + ' ' + m[2] + (m[3] ? ' ' + m[3] : ''));
    assert.deepEqual(heads, ['Tanks 2 / 3', 'Healers 1 / 6', 'Melee DPS 3 / 8', 'Ranged DPS 3 / 8']);
    const ranged = desk.slice(desk.indexOf('data-role="ranged"'));
    assert(ranged.indexOf('Solder') > ranged.indexOf('>Reserve</h4>') && ranged.indexOf('Sorin') < ranged.indexOf('>Reserve</h4>'), 'a reserve sits under the Reserve label of its column');
    assert.equal(count(desk, /class="gs-rs-row/g), 10, 'the columns hold every active person');
    const member = rosterPage(guildData({ can: MEMBER_CAN, flags: {} }), rosterData({ can: { edit: false } }), {}, { shape });
    assert.deepEqual([...deskOf(member).matchAll(/<h3 class="gs-fg-gh gs-rs-colhead">([^<]*) <b>(\d+)<\/b>(<span)?/g)].map(m => m[1] + ' ' + m[2] + (m[3] ? ' den' : '')), ['Tanks 2', 'Healers 1', 'Melee DPS 3', 'Ranged DPS 3']);
    const noRole = rosterPage(guildData(), rosterData({ people: [Object.assign(plain(PEOPLE[0]), { raidRole: null })] }));
    assert(deskOf(noRole).includes('data-role="none"') && deskOf(noRole).includes('No spec') && !deskOf(out).includes('No spec'), 'a fifth No spec column only when someone has no role');
    const me = plain(PEOPLE).map(p => (p.shown.name === 'Sorin' ? Object.assign(p, { isMe: true }) : p));
    const meDesk = deskOf(rosterPage(guildData(), rosterData({ people: me })));
    const first = meDesk.slice(meDesk.indexOf('data-role="ranged"'));
    const rangedNames = rowNames(first.slice(0, first.indexOf('>Reserve</h4>')));
    assert.deepEqual(rangedNames, rangedNames.slice().sort((a, b) => a.localeCompare(b, 'en')), 'A-Z, You is not moved to the top');
    assert(rangedNames.indexOf('Sorin') > 0, 'You keeps the sorted place');
    assert(first.includes('data-you="true"') && first.includes('<span class="gs-hd-chip is-grey">You</span>'));
  });

  await check('roster page: a member sees the list but no Import, no Add person, no team shape and no Needs you line; their own line has Your record and Away notices', () => {
    const gd = guildData({ can: MEMBER_CAN, flags: {} });
    const me = plain(PEOPLE).map(p => (p.shown.name === 'Ashcaller' ? Object.assign(p, { isMe: true }) : p));
    const out = rosterPage(gd, rosterData({ can: { edit: false }, people: me }));
    assert(!out.includes('roster-import') && !out.includes('roster-add') && !out.includes('roster-more') && !out.includes('gs-trial-strip') && !out.includes('gs-rs-needs') && !out.includes('Team shape'));
    assert(out.includes('Ashcaller'));
    assert(out.includes('aria-label="You"') && out.includes('>Your record<') && out.includes('href="#/g/g1/roster/p/p_1"') && out.includes('>Away notices<') && out.includes('href="#/g/g1/away"'));
  });

  await check('roster page: Needs you names the trials to decide (ended first) and the New applications; it is hidden when there is nothing', () => {
    const gd = Object.assign(guildData(), { applicationFlags: { t_main: 3 } });
    const out = rosterPage(gd, rosterData());
    const needs = out.match(/<section class="gs-hd-panel gs-rs-needs"[\s\S]*?<\/section>/)[0];
    assert.equal(stripTags(needs).replace(/\s+/g, ' ').trim(), 'Needs youS' + OSLASH + 'lvhand\'s trial ended 2 days agoFrostwhisper\'s trial ends in 5 days3 new applications');
    assert(needs.includes('href="#/g/g1/roster/p/p_8"') && needs.includes('href="#/g/g1/roster/recruiting">3 new applications<'));
    const none = rosterPage(guildData(), rosterData({ people: PEOPLE.filter(p => !p.trialFlag).map(p => plain(p)) }));
    assert(!none.includes('gs-rs-needs'), 'nothing to decide: no line');
    const apps = rosterPage(Object.assign(guildData(), { applicationFlags: { t_main: 1 } }), rosterData({ people: PEOPLE.filter(p => !p.trialFlag).map(p => plain(p)) }));
    assert(apps.includes('1 new application<') && !apps.includes('1 new applications'));
    const member = rosterPage(Object.assign(guildData({ can: MEMBER_CAN, flags: {} }), { applicationFlags: { t_main: 3 } }), rosterData({ can: { edit: false } }));
    assert(!member.includes('gs-rs-needs'), 'a member never sees it');
  });

  await check('roster page: the team shape tiles read the recruiting answer (Need N rose, Full green, N over grey) and say what buffs are missing; a skeleton until it answers', () => {
    const cov = { buffs: [1, 2, 3, 4, 5].map(i => ({ name: 'Buff ' + i, covered: i > 4 })), debuffs: [{ name: 'Debuff A', covered: false }, { name: 'Debuff B', covered: true }] };
    const shape = { status: 'ready', cov, data: { targets: { tank: 3, healer: 6, melee: 8, ranged: 8 }, roster: { counts: { tank: 3, healer: 7, melee: 5, ranged: 7 } } } };
    const out = G.pages.roster.tilesHtml({ guildData: guildData(), data: rosterData(), view: {}, shape });
    assert.deepEqual([...out.matchAll(/data-have="(\d+)" data-want="(\d+)"/g)].map(m => m[1] + '/' + m[2]), ['3/3', '7/6', '5/8', '7/8']);
    assert.deepEqual([...out.matchAll(/gs-hd-chip is-(\w+)">([^<]*)</g)].map(m => m[1] + ':' + m[2]), ['green:Full', 'grey:1 over', 'rose:Need 3', 'rose:Need 1']);
    assert(out.includes('Counts Raider and Trial mains. Missing: Buff 1, Buff 2, Buff 3 and 1 more buff; Debuff A.') && out.includes('>See coverage<'));
    const loading = G.pages.roster.tilesHtml({ guildData: guildData(), data: rosterData(), view: {}, shape: { status: 'loading' } });
    assert(loading.includes('aria-busy="true"') && loading.includes('gs-hd-sk') && !loading.includes('data-have'));
    assert.equal(G.pages.roster.tilesHtml({ guildData: guildData(), data: rosterData(), view: {}, shape: { status: 'error' } }), '', 'a failed read leaves the tiles out');
    assert(G.pages.roster.missingLine({ buffs: [], debuffs: [] }).endsWith('Every raid buff and debuff is covered.'));
    assert.equal(G.pages.roster.tilesHtml({ guildData: guildData({ can: MEMBER_CAN, flags: {} }), data: rosterData({ can: { edit: false } }), view: {}, shape }), '', 'members have no tiles');
  });

  await check('roster page: chips only for an exception - rose for a trial to decide, blue Trial, grey Reserve and You; a trial of another home team shows no flag', () => {
    const out = rosterPage(guildData(), rosterData());
    const desk = deskOf(out);
    assert(desk.includes('gs-hd-chip is-rose">Ends in 5 days</span>') && desk.includes('gs-hd-chip is-rose">Trial ended</span>'));
    assert(desk.includes('gs-hd-chip is-blue">Trial</span>') && desk.includes('gs-hd-chip is-grey">Reserve</span>'));
    assert.equal(count(desk, /gs-hd-chip/g), 4, 'Raiders show nothing: Corvane (Trial), the two flags and Solder (Reserve)');
    assert(!/gs-trial-end/.test(out), 'the old gold and orange chips are gone');
    const away = plain(PEOPLE).map(p => (p.shown.name === 'Frostwhisper' ? Object.assign(p, { main: Object.assign({}, p.main, { team: TEAM_WEEKEND }) }) : p));
    const other = deskOf(rosterPage(guildData(), rosterData({ people: away })));
    assert(!other.includes('Ends in 5 days') && other.includes('Trial ended'), 'a trial of another home team shows no flag');
  });

  await check('roster page: an Alt shown for a person whose Main is on another team says "Alt of <Main>"; the context line names the team', () => {
    const alt = rp(30, 'Mistbrew', 'SHAMAN', 'Elemental', 'Restoration', 'raider', { alt: true, mainName: 'Mistvale', homeTeam: TEAM_MAIN });
    const gd = guildData({ teams: [TEAM_MAIN, TEAM_WEEKEND], flags: {} });
    const out = rosterPage(gd, rosterData({ team: { id: 't_weekend', name: 'Weekend team', archived: false }, people: [alt] }));
    assert(out.includes('<span class="gs-rs-alt">Alt of Mistvale</span>'));
    assert(out.includes('Weekend team ' + DOT + ' 1 raider or trial'), 'several teams: <Team> and the counts');
    const plainRow = rosterPage(gd, rosterData({ team: { id: 't_weekend', name: 'Weekend team', archived: false }, people: [PEOPLE[0]] }));
    assert(!plainRow.includes('Alt of'));
    assert(plainRow.includes('<span class="gs-rs-alt">2 alts</span>'), 'a person with Alts shows how many, muted');
  });

  await check('roster page: the row links to the record; the name is in the class colour and carries the spec icon; the class and spec words are neutral', () => {
    const out = rosterPage(guildData(), rosterData());
    const row = out.match(/<a class="gs-rs-row" href="#\/g\/g1\/roster\/p\/p_8">[\s\S]*?<\/a>/)[0];
    assert(row.includes('<span class="gs-rs-name gs-class-paladin">S' + OSLASH + 'lvhand</span>'));
    assert(/<img class="gs-spec-icon" src="\/icons\/[a-z_]+\.jpg" alt="" width="20" height="20"/.test(row), 'the spec icon is decorative');
    assert(row.includes('<span class="gs-rs-spec">Protection</span>') && !row.includes('gs-class-paladin">Paladin'), 'the spec word is neutral');
    assert(!out.includes('gs-role-dot') && !out.includes('has-mark') && !out.includes('gs-char-link'), 'no role dot, no class edge');
  });

  await check('roster page: archived team shows the info strip and offers no Add person or Import', () => {
    const gd = guildData({ teams: [TEAM_MAIN, Object.assign({}, TEAM_WEEKEND, { archived: true })] });
    const out = rosterPage(gd, rosterData({ team: { id: 't_weekend', name: 'Weekend team', archived: true } }));
    assert(out.includes('role="note"') && out.includes('Weekend team is archived. Its people stay listed, but no one can be added.'));
    assert(!out.includes('roster-add') && !out.includes('roster-more') && !out.includes('Import from') && !out.includes('Team shape') && !out.includes('gs-rs-needs'));
  });

  await check('roster states: the empty roster (officer: Add person and Import; member: officers have not added anyone), no active team, loading, error with Try again, no matches with Clear search', () => {
    const empty = { people: [] };
    const editor = rosterPage(guildData(), rosterData(empty));
    assert(editor.includes('No one on the roster yet') && editor.includes('id="roster-import"') && editor.includes('Import from a Raid-Helper event') && editor.includes('href="#/g/g1/roster/import/csv"') && count(editor, /gs-btn-molten/g) === 1 && editor.includes('>Add person<'));
    assert(!editor.includes('roster-search') && !editor.includes('id="roster-more"'), 'the head has no second Add person or More');
    const member = rosterPage(guildData({ can: MEMBER_CAN, flags: {} }), rosterData({ people: [], can: { edit: false } }));
    assert(member.includes('Your officers haven' + String.fromCharCode(38) + '#39;t added anyone yet.') && !member.includes('Import from') && !member.includes('Add person'));
    const none = G.pages.roster.noTeamHtml(true, 'g1');
    assert(none.includes('No active team') && none.includes('Open Teams') && none.includes('href="#/g/g1/settings/teams"') && !G.pages.roster.noTeamHtml(false, 'g1').includes('Open Teams'));
    const loading = G.pages.roster.skeletonHtml();
    assert(loading.includes('aria-busy="true"') && loading.includes('Loading the roster') && loading.includes('gs-hd-sk'));
    const failed = G.pages.roster.errorHtml('The server did not answer.');
    assert(failed.includes('role="alert"') && failed.includes('We couldn&#39;t load the roster.') && failed.includes('data-action="retry"') && failed.includes('Nothing you saved was lost.'));
    const noMatch = rosterPage(guildData(), rosterData(), { query: 'zz' });
    assert(noMatch.includes('No one matches &quot;zz&quot;.') && noMatch.includes('data-action="roster-clear-search"') && !deskOf(noMatch).includes('gs-rs-row'));
  });

  await check('roster page: names, nicknames-as-team-names and notices are escaped', () => {
    const bad = rp(40, HOSTILE, 'MAGE', 'Frost', 'Fire', 'raider', { mainName: QUOTES });
    bad.main.team = { id: 't_main', name: HOSTILE };
    const out = rosterPage(guildData(), rosterData({ people: [bad], team: { id: 't_main', name: HOSTILE, archived: true } }), {}, { notice: HOSTILE });
    assertEscaped(out, 'roster');
    assert(out.includes('&lt;img src=x'));
  });

  await check('roster page: no inline style, no inline handler, no non-ASCII markup of its own', () => {
    const out = rosterPage(guildData(), rosterData()) + G.pages.roster.addPersonDialogHtml({ guildData: guildData(), teamId: 't_main', today: '2026-10-15', linkable: [] });
    assertNoRawAttrs(out);
  });

  await check('phone roster: the segments (an officer has six, the Applicants one with the gold count; a member Active and Everyone) and the directory list - NEEDS A DECISION, then everyone (You sits in the normal groups)', () => {
    const gd = Object.assign(guildData(), { applicationFlags: { t_main: 2 } });
    const out = rosterPage(gd, rosterData());
    const pills = html => [...html.matchAll(/class="gs-fg-pill" data-action="roster-seg" data-seg="(\w+)" data-key="pseg-\w+" aria-pressed="(\w+)">(\w+) <span class="([\w-]+)">(\d+)<\/span>/g)].map(m => m[1] + ':' + m[3] + ':' + m[5] + ':' + m[4] + ':' + m[2]);
    assert.deepEqual(pills(out), ['active:Active:10:gs-fg-segn:true', 'raider:Raiders:6:gs-fg-segn:false', 'trial:Trials:3:gs-fg-segn:false', 'reserve:Reserve:1:gs-fg-segn:false', 'applicants:Applicants:2:gs-fg-cnt:false', 'inactive:Inactive:1:gs-fg-segn:false']);
    const phone = phoneOf(out);
    assert.deepEqual([...phone.matchAll(/<h2 class="gs-hd-sl gs-rs-pgroup">([^<]*)</g)].map(m => m[1]), ['Needs a decision', 'Everyone']);
    assert.deepEqual(rowNames(phone), ['Frostwhisper', 'S' + OSLASH + 'lvhand', 'Ashcaller', 'Brightmane', 'Corvane', 'Kaelith', 'Quickshade', 'Solder', 'Sorin', 'Stormjaw']);
    const me = plain(PEOPLE).map(p => (p.shown.name === 'Sorin' ? Object.assign(p, { isMe: true }) : p));
    const mePhone = phoneOf(rosterPage(gd, rosterData({ people: me })));
    assert.deepEqual(rowNames(mePhone), rowNames(phone), 'You keeps the sorted place in the phone list');
    assert(mePhone.includes('data-you="true"') && mePhone.includes('<span class="gs-hd-chip is-grey">You</span>'), 'tint + You tag stay');
    assert(phone.includes('gs-rs-plist'), 'one panel of rows');
    const raiders = phoneOf(rosterPage(gd, rosterData(), { status: 'raider' }));
    assert.equal(rowNames(raiders).length, 6);
    assert(!raiders.includes('gs-rs-pgroup'), 'only the Active list is grouped');
    const member = rosterPage(guildData({ can: MEMBER_CAN, flags: {} }), rosterData({ can: { edit: false } }));
    assert.deepEqual(pills(member).map(s => s.split(':').slice(0, 3).join(':')), ['active:Active:10', 'everyone:Everyone:11']);
    assert(!phoneOf(member).includes('gs-rs-pgroup') && !phoneOf(member).includes('Applicants'), 'a member has no group and no Applicants');
    const apps = [{ id: 'ap1', name: 'Brightwater', class: 'SHAMAN', spec: 'Restoration' }, { id: 'ap2', name: 'Cinderlight', class: 'PRIEST', spec: 'Holy' }];
    const list = phoneOf(rosterPage(gd, rosterData(), { status: 'applicants' }, { apps: { status: 'ready', list: apps } }));
    assert.deepEqual(rowNames(list), ['Brightwater', 'Cinderlight']);
    assert(list.includes('gs-hd-chip is-grey">New</span>') && list.includes('href="#/g/g1/roster/applications"'));
    assert(phoneOf(rosterPage(gd, rosterData(), { status: 'applicants' }, { apps: { status: 'loading', list: [] } })).includes('Loading applicants...'));
  });

  // ── Add person dialog ──────────────────────────────────────────
  await check('Add person dialog: fields, the trial end is today + the team\'s trial length, status segments, and "More details" holds off spec, joined, team and Account', () => {
    const out = G.pages.roster.addPersonDialogHtml({ guildData: guildData(), teamId: 't_main', today: '2026-10-15', linkable: [{ id: 'u_1', username: 'velanne', displayName: 'Velanne' }, { id: 'u_2', username: 'zed', displayName: 'Zed' }] });
    assert(out.includes('Add person') && out.includes('Start with their Main character. Alts go on their record.'));
    assert(out.includes('name="name"') && out.includes('name="class"') && out.includes('name="mainSpec"') && out.includes('name="offSpec"') && out.includes('id="dlg-role"'));
    assert(/id="dlg-status-trial" name="status" value="trial" checked/.test(out) && out.includes('for="dlg-status-raider">Raider<') && out.includes('for="dlg-status-reserve">Reserve<'));
    assert(out.includes('value="2026-10-29"') && out.includes('14 days from today (Main team&#39;s trial length). Officers get a flag 7 days before.'), 'no trial length yet: 14 days');
    const more = out.slice(out.indexOf('id="dlg-more"'));
    assert(/aria-expanded="false" aria-controls="dlg-more"/.test(out) && out.includes('id="dlg-more" hidden'), 'the disclosure starts closed');
    assert(more.includes('name="offSpec"') && more.includes('name="joinedOn"') && more.includes('value="2026-10-15"') && more.includes('name="linkUserId"'), 'the rarer fields live inside it');
    assert(out.includes('>Account</label>') && !out.includes('Discord'), 'Account, never "Discord account"');
    assert(out.includes('Lists people who have signed in to Raidsmith and are not on the roster yet.'));
    assert(out.includes('<option value="u_1">Velanne (@velanne)</option>') && out.includes('>Not linked</option>'));
    assert(!out.includes('name="teamId"'));
    assert(out.includes('<option value="WARRIOR">Warrior</option>'));
    const longer = G.pages.roster.addPersonDialogHtml({ guildData: guildData({ teams: [Object.assign({}, TEAM_MAIN, { trialDays: 21 })] }), teamId: 't_main', today: '2026-10-15', linkable: [] });
    assert(longer.includes('value="2026-11-05"') && longer.includes('21 days from today'), 'the team\'s own trial length');
    const fromRead = G.pages.roster.addPersonDialogHtml({ guildData: guildData(), teamId: 't_main', team: { id: 't_main', name: 'Main team', trialDays: 30 }, today: '2026-10-15', linkable: [] });
    assert(fromRead.includes('value="2026-11-14"'), 'the roster read\'s team carries it too');
  });

  await check('Add person dialog: a Team select appears only with several active teams, defaulting to the selected team', () => {
    const gd = guildData({ teams: [TEAM_MAIN, TEAM_WEEKEND, Object.assign({}, { id: 't_old', name: 'Old team', archived: true })] });
    const out = G.pages.roster.addPersonDialogHtml({ guildData: gd, teamId: 't_weekend', today: '2026-10-15', linkable: [] });
    assert(out.includes('name="teamId"'));
    assert(out.includes('<option value="t_weekend" selected>Weekend team</option>') && out.includes('<option value="t_main">Main team</option>'));
    assert(!out.includes('Old team'), 'archived teams are not targets');
  });

  await check('Add person dialog: linkable members are escaped', () => {
    const out = G.pages.roster.addPersonDialogHtml({ guildData: guildData(), teamId: 't_main', today: '2026-10-15', linkable: [{ id: 'u_1', username: HOSTILE, displayName: QUOTES }] });
    assertEscaped(out, 'add person');
  });

  // ── person record ──────────────────────────────────────────────
  function charRec(id, name, cls, mainSpec, offSpec, isMain, team) {
    return { id: 'c_' + id, name, realm: null, class: cls, mainSpec, offSpec, role: (ROSTER_OPTIONS.roles[cls] || {})[mainSpec] || null, isMain, team: Object.assign({ archived: false }, team || TEAM_MAIN) };
  }
  function record(over) {
    const o = over || {};
    return Object.assign({
      today: '2026-10-15',
      can: { edit: true, notesView: true, notesEdit: true, delete: true, addCharacter: true },
      person: Object.assign({
        id: 'p_8', status: 'trial', joinedOn: '2026-09-15', trialStart: '2026-09-15', trialEnd: '2026-10-13', trialFlag: { kind: 'ended', days: -2 }, isMe: false, version: 3,
        discord: { signIn: 'signed_in', user: { id: 'u_8', username: 'solvhand', displayName: 'Solvhand', avatarUrl: null, initials: 'SO' }, nickname: 'Sølvhand/Glimmerkin' },
        homeTeam: TEAM_MAIN,
      }, o.person || {}),
      characters: o.characters || [charRec(8, 'Sølvhand', 'PALADIN', 'Protection', 'Holy', true), charRec('8b', 'Glimmerkin', 'PRIEST', 'Holy', 'Discipline', false)],
      notes: o.notes === undefined ? { text: 'Holds threat well on trash.', version: 1, updatedBy: { id: 'u_1', username: 'thornvald', displayName: 'Thornvald' }, updatedAt: Date.UTC(2026, 9, 10, 12) } : o.notes,
    }, o.top || {});
  }
  const personPage = (rec, gd, linkable, alert) => G.pages.person.personHtml({ guildData: gd || guildData(), record: rec, linkable: linkable || [], alert: alert || '' });

  const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '').replace(/\s+/g, ' ');
  const headOf = out => out.match(/<header class="gs-pagehead">[\s\S]*?<\/header>/)[0];
  const editing = (rec, on) => { G.pages.person.setEditing('g1', rec.person.id, 'details', on); G.pages.person.setEditing('g1', rec.person.id, 'notes', on); };

  await check('person record: the head is the spec icon, the name in its class colour, ONE chip and the context line; no trial banner or fine print', () => {
    const out = personPage(record());
    const head = headOf(out);
    assert(head.includes('class="gs-spec-icon"') && head.includes('<h1 class="gs-h1 gs-class-paladin" id="page-title" tabindex="-1">Sølvhand</h1>'));
    assert.equal((head.match(/gs-hd-chip/g) || []).length, 1, 'one chip in the head');
    assert(head.includes('<span class="gs-hd-chip is-rose">Ended 2 days ago</span>'), 'a trial to decide: the rose flag is the one chip');
    const context = text(head.match(/<p class="gs-sub gs-pagehead-context">[\s\S]*?<\/p>/)[0]);
    assert(context.includes('Paladin Protection / Holy') && context.includes('Alt: Glimmerkin') && context.includes('Joined Sep 15, 2026') && context.includes('Account: Not linked'));
    assert(!out.includes('gs-trial-bar') && !out.includes('The flag clears when the status changes') && !out.includes('gs-status-trial'));
    const ends = personPage(record({ person: { trialFlag: { kind: 'ends', days: 5 }, trialEnd: '2026-10-20' } }));
    assert(headOf(ends).includes('is-rose">Ends in 5 days<'));
    const quiet = headOf(personPage(record({ person: { trialFlag: null } })));
    assert(quiet.includes('is-blue">Trial<') && (quiet.match(/gs-hd-chip/g) || []).length === 1, 'a Trial with nothing to decide: the blue Trial chip');
    assert(!headOf(personPage(record({ person: { status: 'raider', trialFlag: null } }))).includes('gs-hd-chip'), 'a Raider has no chip');
    assert(headOf(personPage(record({ person: { status: 'reserve', trialFlag: null } }))).includes('is-grey">Reserve<'));
    assert(headOf(personPage(record({ person: { status: 'inactive', trialFlag: null } }))).includes('is-grey">Inactive<'));
  });

  await check('person record: More holds Edit details, Add character, Add an away notice and, after a rule, Delete person; the head never repeats the account label of the form', () => {
    const out = personPage(record(), guildData({ can: { 'roster.edit': 'guild', 'roster.notes.view': 'guild', 'roster.notes.edit': 'guild', 'raids.edit': 'guild' } }));
    const more = out.match(/<div class="gs-menu gs-menu-list[^"]*" id="person-more-list"[\s\S]*?<\/div>\s*<\/div>/)[0];
    assert(more.includes('data-action="person-edit-open"') && more.includes('data-action="char-add"') && more.includes('data-action="away-add"') && more.includes('data-pid="p_8"'));
    assert(more.indexOf('role="separator"') > more.indexOf('away-add') && more.indexOf('data-action="person-delete"') > more.indexOf('role="separator"') && more.includes('>Delete person<'));
    assert(!out.includes('gs-delete-row') && !out.includes('Their Discord sign-in is not affected.'), 'Delete person is only in More');
    const noDelete = personPage(record({ top: { can: { edit: true, notesView: true, notesEdit: true, delete: false, addCharacter: true } } }));
    assert(!noDelete.includes('person-delete') && noDelete.includes('person-edit-open'));
  });

  await check('person record: Characters are rows - spec icon, class-coloured name, class and spec, Main / Alt chip, one Edit and the Alt\'s More', () => {
    const out = personPage(record());
    assert(out.includes('data-action="char-add"') && out.includes('>Add character<'));
    const rows = out.match(/<section class="gs-hd-panel gs-pr-panel" id="characters"[\s\S]*?<\/section>/)[0];
    assert(rows.indexOf('Sølvhand') < rows.indexOf('Glimmerkin'));
    assert(rows.includes('is-grey">Main</span>') && rows.includes('is-grey">Alt</span>') && !rows.includes('gs-tag-mark is-gold'));
    assert(rows.includes('class="gs-spec-icon"') && rows.includes('gs-char-name gs-class-paladin') && rows.includes('gs-char-name gs-class-priest'));
    assert(rows.includes('aria-label="Edit Sølvhand"') && rows.includes('aria-label="Edit Glimmerkin"'), 'one inline action: Edit');
    assert(rows.includes('aria-label="More actions for Glimmerkin"') && rows.includes('data-action="char-main" data-cid="') && rows.includes('data-action="char-remove" data-cid="'), 'Make Main and Remove sit in the row\'s More menu');
    assert(!rows.includes('More actions for Sølvhand') && !rows.includes('data-action="char-remove" data-cid="c_8"'), 'the Main cannot be removed or made Main again');
    assert(!rows.includes('Weekend team') && !rows.includes('Main team'), 'no team name with one team');
    assert(out.includes('Attendance shows here after the first raid.'));
  });

  await check('person record: the team name joins a character row with several teams', () => {
    const gd = guildData({ teams: [TEAM_MAIN, TEAM_WEEKEND] });
    const rec = record({ characters: [charRec(8, 'Sølvhand', 'PALADIN', 'Protection', 'Holy', true), charRec('8b', 'Glimmerkin', 'PRIEST', 'Holy', 'Discipline', false, TEAM_WEEKEND)] });
    const rows = personPage(rec, gd).match(/<section class="gs-hd-panel gs-pr-panel" id="characters"[\s\S]*?<\/section>/)[0];
    assert(rows.includes('&middot; Weekend team') && rows.includes('&middot; Main team'));
  });

  await check('person record: Details are read-only key-values until Edit; the trial dates show for a Trial only; Edit opens the form with one Save bar', () => {
    editing(record(), false);
    const out = personPage(record());
    const read = out.match(/<section class="gs-hd-panel gs-pr-panel" id="details"[\s\S]*?<\/section>/)[0];
    assert(!read.includes('<form') && !read.includes('<input') && !read.includes('<select'), 'read-only');
    assert(text(read).includes('Status Trial') && text(read).includes('Joined Sep 15, 2026') && text(read).includes('Trial Sep 15, 2026 - Oct 13, 2026') && text(read).includes('Account Not linked'));
    assert(read.includes('data-action="person-edit-open"') && read.includes('>Edit<'));
    const raider = personPage(record({ person: { status: 'raider', trialFlag: null } }));
    assert(!text(raider.match(/<section class="gs-hd-panel gs-pr-panel" id="details"[\s\S]*?<\/section>/)[0]).includes('Trial Sep 15'), 'no trial dates for a Raider');
    editing(record(), true);
    const form = personPage(record());
    editing(record(), false);
    assert(form.includes('data-submit="person-details-form"') && form.includes('data-savebar') && form.includes('>Save details<'), 'the fields share one Save bar');
    assert(form.includes('data-action="person-edit-close"') && form.includes('>Cancel<'));
    assert(/<option value="trial" selected>Trial<\/option>/.test(form));
    assert(/name="joinedOn"[^>]* value="2026-09-15"/.test(form) && /name="trialStart"[^>]* value="2026-09-15"/.test(form) && /name="trialEnd"[^>]* value="2026-10-13"/.test(form));
    assert(/<div id="det-trial-fields" class="gs-pr-trialfields">/.test(form), 'the trial dates are visible for a Trial');
    editing(record(), true);
    const rf = personPage(record({ person: { status: 'raider', trialFlag: null } }));
    editing(record(), false);
    assert(/<div id="det-trial-fields" class="gs-pr-trialfields" hidden>/.test(rf), 'hidden for a Raider');
    assert(!form.includes('name="linkUserId"') && !form.includes('det-link'));
  });

  await check('person record: Officer notes are read-only text with Edit (editors); Edit opens the textarea and Save note; a viewer without notes.edit has no Edit', () => {
    editing(record(), false);
    const out = personPage(record());
    const read = out.match(/<section class="gs-hd-panel gs-pr-panel" id="notes"[\s\S]*?<\/section>/)[0];
    assert(read.includes('Holds threat well on trash.') && !read.includes('<textarea') && read.includes('data-action="person-notes-edit"'));
    assert(read.includes('Edited by Thornvald, Oct 10, 2026'));
    editing(record(), true);
    const form = personPage(record());
    editing(record(), false);
    assert(form.includes('Only officers and team leads see notes.') && form.includes('<textarea') && form.includes('>Save note<') && form.includes('data-action="person-notes-close"'));
    const viewOnly = personPage(record({ top: { can: { edit: true, notesView: true, notesEdit: false, delete: false, addCharacter: true } } }));
    assert(viewOnly.includes('Holds threat well on trash.') && !viewOnly.includes('person-notes-edit') && !viewOnly.includes('>Save note<'));
    const noNotes = personPage(record({ notes: null }));
    assert(!noNotes.includes('Officer notes'));
  });

  await check('person record: the delete confirm names the person, counts their characters and says their account is not affected', () => {
    const out = G.pages.person.deleteDialogHtml(record());
    assert(out.includes('Delete Sølvhand? This removes them and their 2 characters from the roster. It can&#39;t be undone. Their account is not affected.'));
    assert(!out.includes('Discord sign-in'));
    assert(out.includes('data-submit="delete-person-form"') && out.includes('>Delete person<'));
    const one = G.pages.person.deleteDialogHtml(record({ characters: [charRec(8, 'Sølvhand', 'PALADIN', 'Protection', 'Holy', true)] }));
    assert(one.includes('their 1 character from') || one.includes('their 1 character '), one);
  });

  await check('person record: a member gets a read-only record, no notes, no More, no Edit, and the You line on their own record only', () => {
    const memberRec = (isMe) => record({ person: { isMe, status: 'raider', trialFlag: null, account: { user: { id: 'u_8', username: 'solvhand', displayName: 'Solvhand', avatarUrl: null, initials: 'SO' }, via: 'discord', linked: false } },
      top: { can: { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false } }, notes: null });
    const mine = personPage(memberRec(true), guildData({ can: MEMBER_CAN, flags: {} }));
    assert(mine.includes('<span class="gs-youline-label">You</span>') && headOf(mine).includes('is-grey">You<'));
    assert(mine.includes('Officers keep your status and characters up to date. Ask one of them if something is wrong.'));
    assert(mine.includes('Your attendance shows here after the first raid.'));
    assert(mine.includes('Joined Sep 15, 2026') && text(mine).includes('Account Solvhand (via Discord)'));
    assert(mine.includes('id="you-sees" hidden') && mine.includes('aria-controls="you-sees"') && mine.includes('Who can see this page'));
    for (const banned of ['<form', '<textarea', 'Officer notes', 'Delete person', 'person-more', 'person-edit-open', 'account-link-open', 'account-unlink-open']) assert(!mine.includes(banned), banned);
    assert(!mine.replace(/<button type="button" class="gs-btn gs-btn-ghost" data-action="you-sees-toggle"[\s\S]*?<\/button>/, '').includes('<button'), 'the only button is the disclosure');
    const theirs = personPage(memberRec(false), guildData({ can: MEMBER_CAN, flags: {} }));
    assert(!theirs.includes('gs-youline') && !theirs.includes('Officers keep your status') && !theirs.includes('<button'));
    assert(!text(headOf(theirs)).includes('Account:'), 'another member\'s account is not in the head');
  });

  await check('person record: names, nickname, notes and the author are escaped', () => {
    const rec = record({
      characters: [charRec(8, HOSTILE, 'PALADIN', 'Protection', 'Holy', true), charRec('8b', QUOTES, 'PRIEST', 'Holy', 'Discipline', false)],
      person: { discord: { signIn: 'not_yet', user: null, nickname: HOSTILE } },
      notes: { text: HOSTILE + QUOTES, version: 1, updatedBy: { id: 'u_1', username: 'x', displayName: HOSTILE }, updatedAt: 1 },
    });
    const out = personPage(rec) + G.pages.person.characterDialogHtml({ guildData: guildData(), record: rec, character: rec.characters[1], defaultTeamId: 't_main' }) + G.pages.person.deleteDialogHtml(rec);
    assertEscaped(out, 'person');
    assertNoRawAttrs(out);
  });

  await check('character dialogs: Add has Main or Alt with the "becomes an Alt" help; Edit prefills; a Team select only with several teams', () => {
    const rec = record();
    const add = G.pages.person.characterDialogHtml({ guildData: guildData(), record: rec, character: null, defaultTeamId: 't_main' });
    assert(add.includes('Add a character for Sølvhand') && add.includes('name="mainOrAlt" value="alt" checked') && add.includes('value="main"') && add.includes('Choosing Main makes Sølvhand an Alt.'));
    assert(!add.includes('name="teamId"'));
    const edit = G.pages.person.characterDialogHtml({ guildData: guildData(), record: rec, character: rec.characters[1], defaultTeamId: 't_main' });
    assert(edit.includes('Edit Glimmerkin') && edit.includes('value="Glimmerkin"') && /<option value="PRIEST" selected>/.test(edit) && /<option value="Holy" selected>/.test(edit) && /<option value="Discipline" selected>/.test(edit));
    assert(!edit.includes('mainOrAlt'));
    const gd = guildData({ teams: [TEAM_MAIN, TEAM_WEEKEND] });
    const many = G.pages.person.characterDialogHtml({ guildData: gd, record: rec, character: rec.characters[1], defaultTeamId: 't_main' });
    assert(many.includes('name="teamId"') && /<option value="t_main" selected>/.test(many));
  });

  // ── behaviour against a stubbed API ────────────────────────────
  function withApi(stubs, fn) {
    const saved = {};
    for (const k of Object.keys(stubs)) { saved[k] = G.api[k]; G.api[k] = stubs[k]; }
    const savedGo = G.app.go;
    const hashes = [];
    G.app.go = h => hashes.push(h);
    return Promise.resolve(fn(hashes)).finally(() => { for (const k of Object.keys(saved)) G.api[k] = saved[k]; G.app.go = savedGo; });
  }
  function setupPerson(rec, gd) {
    const s = G.app.state;
    s.guilds.g1 = gd || guildData();
    s.currentGid = 'g1';
    s.person = { gid: 'g1', pid: rec.person.id, record: rec };
    s.pageAlert = '';
    return s;
  }
  const el = attrs => ({ disabled: false, getAttribute: k => (attrs || {})[k] });
  // The Details form (the way to change a status now that the Trial review card owns the trial buttons): the dates and the link as the record has them.
  const detailsStatusForm = status => {
    const field = v => ({ value: v, focus() {}, select() {}, setAttribute() {} });
    return { elements: { status: field(status), joinedOn: field('2026-09-15'), trialStart: field('2026-09-15'), trialEnd: field('2026-10-13'), linkUserId: field('u_8') }, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] };
  };

  await check('conflict: a stale save re-renders from ApiError.body.current and shows the standard message', async () => {
    const stale = record();
    const s = setupPerson(stale);
    const fresh = record({ person: { status: 'raider', trialFlag: null, version: 4 } });
    fresh.rosterFlags = { t_main: 0 };
    let sent;
    await withApi({
      patch: (url, body) => { sent = { url, body }; return Promise.reject(new G.api.ApiError(409, { error: 'conflict', message: 'Changed.', current: fresh })); },
    }, async () => {
      G.handlers.submit['person-details-form'](detailsStatusForm('raider'));
      await tick();
    });
    assert.equal(sent.url, '/api/guild/g1/roster/p_8');
    assert.deepEqual(plain(sent.body), { expectedVersion: 3, status: 'raider' });
    assert.equal(s.person.record.person.version, 4);
    assert.equal(s.pageAlert, 'Someone else changed this person. The page now shows their version.');
    const out = G.pages.person.personHtml({ guildData: s.guilds.g1, record: s.person.record, linkable: [], alert: s.pageAlert });
    assert(out.includes('Someone else changed this person. The page now shows their version.') && !headOf(out).includes('gs-hd-chip') && !out.includes('gs-trial-bar'), 'the Raider the server sent: no chip, no trial banner');
  });

  await check('conflict: a stale notes save takes only { notes } from current', async () => {
    const s = setupPerson(record());
    const form = { elements: { text: { value: 'new text' } }, querySelectorAll: () => [] };
    await withApi({
      put: () => Promise.reject(new G.api.ApiError(409, { error: 'conflict', message: 'Changed.', current: { notes: { text: 'their text', version: 5, updatedBy: null, updatedAt: 0 } } })),
    }, async () => {
      G.handlers.submit['person-notes-form'](form);
      await tick();
    });
    assert.equal(s.person.record.notes.text, 'their text');
    assert.equal(s.person.record.notes.version, 5);
    assert.equal(s.person.record.person.version, 3, 'the person part is untouched');
    assert(s.pageAlert.startsWith('Someone else changed this person.'));
  });

  await check('badge: every mutation reply carrying rosterFlags refreshes the Roster nav badge', async () => {
    const s = setupPerson(record());
    const flagged = () => G.shell.render({ me: { user: { id: 'u1', username: 'a', displayName: 'A', prefs: {} }, guilds: [{ id: 'g1', name: 'Bantr' }], create: { allowed: false } }, route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: s.guilds.g1, teamId: 't_main', collapsed: false }, '');
    assert(flagged().includes('aria-label="Roster, 2 trials to decide"') && flagged().includes('<span class="gs-nav-badge" aria-hidden="true">2</span>'));
    const next = record({ person: { status: 'raider', trialFlag: null, version: 4 } });
    next.rosterFlags = { t_main: 1 };
    await withApi({ patch: () => Promise.resolve(next) }, async () => {
      G.handlers.submit['person-details-form'](detailsStatusForm('raider'));
      await tick();
    });
    assert.deepEqual(plain(s.guilds.g1.rosterFlags), { t_main: 1 });
    assert(flagged().includes('aria-label="Roster, 1 trial to decide"'));
    const cleared = record({ person: { status: 'inactive', trialFlag: null, version: 5 } });
    cleared.rosterFlags = { t_main: 0 };
    await withApi({ patch: () => Promise.resolve(cleared) }, async () => {
      G.handlers.submit['person-details-form'](detailsStatusForm('inactive'));
      await tick();
    });
    assert(!flagged().includes('gs-nav-badge'));
    // a notes save and a delete carry flags too
    await withApi({ put: () => Promise.resolve({ notes: { text: 'x', version: 2, updatedBy: null, updatedAt: 0 }, rosterFlags: { t_main: 3 } }) }, async () => {
      G.handlers.submit['person-notes-form']({ elements: { text: { value: 'x' } }, querySelectorAll: () => [] });
      await tick();
    });
    assert.equal(s.guilds.g1.rosterFlags.t_main, 3);
  });

  await check('badge: members never see it, and a team with no flags shows none', () => {
    const base = { me: { user: { id: 'u1', username: 'a', displayName: 'A', prefs: {} }, guilds: [{ id: 'g1', name: 'Bantr' }], create: { allowed: false } }, route: { name: 'section', gid: 'g1', section: 'roster' }, teamId: 't_main', collapsed: false };
    const member = G.shell.render(Object.assign({ guildData: guildData({ can: MEMBER_CAN, flags: { t_main: 2 } }) }, base), '');
    assert(!member.includes('gs-nav-badge') && !member.includes('trials to decide'), 'even a stray flag is ignored without roster.edit');
    const none = G.shell.render(Object.assign({ guildData: guildData({ flags: { t_main: 0 } }) }, base), '');
    assert(!none.includes('gs-nav-badge'));
    const other = G.shell.render(Object.assign({ guildData: guildData({ teams: [TEAM_MAIN, TEAM_WEEKEND], flags: { t_weekend: 4 } }) }, base), '');
    assert(!other.includes('gs-nav-badge'), 'the badge is for the selected team only');
    const phone = G.shell.render(Object.assign({ guildData: guildData() }, base), '');
    assert((phone.match(/gs-nav-badge/g) || []).length >= 3, 'sidebar, drawer and phone tab bar');
  });

  await check('shell: person and import pages keep Roster active and get breadcrumbs', () => {
    const gd = guildData();
    const crumbs = (route, personName) => G.shell.breadcrumbItems({ route, guildData: gd, teamId: 't_main', personName }).map(c => c.label);
    assert.deepEqual(plain(crumbs({ name: 'person', gid: 'g1', pid: 'p_8' }, 'Sølvhand')), ['Bantr', 'Roster', 'Sølvhand']);
    assert.deepEqual(plain(crumbs({ name: 'import', gid: 'g1', source: 'raid-helper' })), ['Bantr', 'Roster', 'Import from Raid-Helper']);
    assert.deepEqual(plain(crumbs({ name: 'import', gid: 'g1', source: 'wcl' })), ['Bantr', 'Roster', 'Import from Warcraft Logs']);
    const many = guildData({ teams: [TEAM_MAIN, TEAM_WEEKEND] });
    assert.deepEqual(plain(G.shell.breadcrumbItems({ route: { name: 'person', gid: 'g1', pid: 'p_8' }, guildData: many, teamId: 't_weekend', personName: 'X' }).map(c => c.label)), ['Bantr', 'Weekend team', 'Roster', 'X']);
    assert.deepEqual(plain(G.shell.breadcrumbItems({ route: { name: 'section', gid: 'g1', section: 'roster', team: 't_old' }, guildData: guildData({ teams: [TEAM_MAIN, { id: 't_old', name: 'Old team', archived: true }] }), teamId: 't_main' }).map(c => c.label)), ['Bantr', 'Old team', 'Roster']);
    const nav = G.shell.render({ me: { user: { id: 'u1', username: 'a', displayName: 'A', prefs: {} }, guilds: [{ id: 'g1', name: 'Bantr' }], create: { allowed: false } }, route: { name: 'person', gid: 'g1', pid: 'p_8' }, guildData: gd, teamId: 't_main', collapsed: false, personName: 'Sølvhand' }, '');
    assert(/class="gs-nav-link is-active" href="#\/g\/g1\/roster"/.test(nav));
  });

  await check('person page actions send the contract bodies (details diff, add / edit character, make main, remove, delete)', async () => {
    const s = setupPerson(record());
    const calls = [];
    const reply = () => Promise.resolve(Object.assign(record({ person: { version: s.person.record.person.version + 1 } }), { rosterFlags: { t_main: 2 } }));
    const rec = verb => (url, body) => { calls.push({ verb, url, body: plain(body) }); return verb === 'del' && url.endsWith('/p_8') ? Promise.resolve({ deleted: true, rosterFlags: { t_main: 1 } }) : reply(); };
    const field = v => ({ value: v, focus() {}, select() {}, setAttribute() {} });
    const form = (extra, attrs) => ({ elements: extra, getAttribute: k => (attrs || {})[k], querySelector: () => null, querySelectorAll: () => [] });
    const base = '/api/guild/g1/roster/p_8';
    await withApi({ patch: rec('patch'), post: rec('post'), del: rec('del') }, async () => {
      // details: only the changed fields go, an emptied date clears with null
      G.handlers.submit['person-details-form'](form({ status: field('raider'), joinedOn: field('2026-09-15'), trialStart: field(''), trialEnd: field('2026-10-13') }));
      await tick();
      assert.deepEqual(calls[0], { verb: 'patch', url: base, body: { expectedVersion: 3, status: 'raider' } }, 'the trial dates only go with a Trial');
      // nothing changed: no request
      const before = calls.length;
      G.handlers.submit['person-details-form'](form({ status: field('trial'), joinedOn: field('2026-09-15'), trialStart: field('2026-09-15'), trialEnd: field('2026-10-13') }));
      await tick();
      assert.equal(calls.length, before, 'unchanged details send nothing');
      // add a character as the new Main
      const addForm = form({ name: field('Velshade'), class: field('WARLOCK'), mainSpec: field('Affliction'), offSpec: field('') }, { 'data-mode': 'add' });
      addForm.querySelector = sel => (sel.includes('mainOrAlt') ? { value: 'main' } : null);
      G.handlers.submit['char-form'](addForm);
      await tick();
      assert.deepEqual(calls[1], { verb: 'post', url: base + '/characters', body: { name: 'Velshade', class: 'WARLOCK', mainSpec: 'Affliction', offSpec: null, teamId: 't_main', makeMain: true } });
      // edit: PATCH of the character
      G.handlers.submit['char-form'](form({ name: field('Glimmer'), class: field('PRIEST'), mainSpec: field('Holy'), offSpec: field('Discipline') }, { 'data-mode': 'edit', 'data-cid': 'c_8b' }));
      await tick();
      assert.deepEqual(calls[2], { verb: 'patch', url: base + '/characters/c_8b', body: { name: 'Glimmer', class: 'PRIEST', mainSpec: 'Holy', offSpec: 'Discipline' } });
      // Make Main, remove
      G.handlers.click['char-main'](el({ 'data-cid': 'c_8b' }));
      await tick();
      assert.deepEqual(calls[3], { verb: 'post', url: base + '/characters/c_8b/main', body: {} });
      G.handlers.click['char-remove'](el({ 'data-cid': 'c_8b' }));
      G.handlers.submit['remove-char-form'](form({}, { 'data-cid': 'c_8b' }));
      await tick();
      assert.deepEqual(calls[4], { verb: 'del', url: base + '/characters/c_8b', body: {} });
      // a Trial's changed date goes on its own
      G.handlers.submit['person-details-form'](form({ status: field('trial'), joinedOn: field('2026-09-15'), trialStart: field('2026-09-15'), trialEnd: field('2026-10-20') }));
      await tick();
      assert.deepEqual(calls[5], { verb: 'patch', url: base, body: { expectedVersion: 8, trialEnd: '2026-10-20' } });
      // Unlink on the Discord kind clears the Discord link with a PATCH; the officer kind keeps its PUT /account
      G.handlers.submit['account-unlink-form'](form({}, { 'data-via': 'discord' }));
      await tick();
      assert.deepEqual(calls[6], { verb: 'patch', url: base, body: { expectedVersion: 9, linkUserId: null } });
      // delete the person: back to the roster with a notice and the new badge count
      G.handlers.submit['delete-person-form'](form({}));
      await tick();
      assert.deepEqual(calls[7], { verb: 'del', url: base, body: {} });
    });
    assert.equal(s.guilds.g1.rosterFlags.t_main, 1);
    assert.equal(s.person, null);
    assert(s.rosterNotice.startsWith('Deleted Sølvhand'));
  });

  await check('character form: client checks - a name and a class are required, and the off spec must differ from the main spec', async () => {
    setupPerson(record());
    const calls = [];
    const field = v => ({ value: v, focus() {}, select() {}, setAttribute() {} });
    const mk = (n, c, m, o) => ({ elements: { name: field(n), class: field(c), mainSpec: field(m), offSpec: field(o) }, getAttribute: () => 'add', querySelector: () => null, querySelectorAll: () => [] });
    await withApi({ post: (...a) => { calls.push(a); return Promise.resolve(record()); } }, async () => {
      G.handlers.submit['char-form'](mk('', 'MAGE', '', ''));
      G.handlers.submit['char-form'](mk('Bob', '', '', ''));
      G.handlers.submit['char-form'](mk('Bob', 'MAGE', 'Fire', 'Fire'));
      await tick();
    });
    assert.equal(calls.length, 0);
  });

  // ── people and teams pages ─────────────────────────────────────
  await check('People and roles: the Roster cell links to the Main\'s record in the class colour; null stays "Not linked"', () => {
    const entry = (id, roster) => ({ person: { id, username: id, displayName: id, avatarUrl: null, initials: 'XX' }, roles: [], roster, lastSeenAt: null, isMe: false, actions: {} });
    const out = G.pages.people.tableHtml({ gid: 'g1', people: [entry('u1', { personId: 'p_8', name: 'Sølvhand', class: 'PALADIN' }), entry('u2', null), entry('u3', { personId: 'p_9', name: HOSTILE, class: 'NOPE' })], teams: [], sort: { column: 'person', dir: 'asc' }, query: '', now: 0 });
    assert(out.includes('<a class="gs-char-link gs-class-paladin" href="#/g/g1/roster/p/p_8">Sølvhand</a>'));
    assert(out.includes('Not linked'));
    assertEscaped(out, 'people roster cell');
    assert(out.includes('<a class="gs-char-link " href="#/g/g1/roster/p/p_9">'), 'an unknown class gets no colour class');
    const sorted = G.peopleSort.sortPeople([entry('u2', null), entry('u1', { personId: 'p_8', name: 'Sølvhand', class: 'PALADIN' })], { column: 'roster', dir: 'asc' });
    assert.equal(sorted[0].person.id, 'u1');
  });

  await check('Teams: the player count shows, and archived teams with characters get an Open roster link', () => {
    const gd = guildData({ teams: [{ id: 't_main', name: 'Main team', players: 23 }, { id: 't_old', name: 'Old team', archived: true, players: 4 }, { id: 't_empty', name: 'Empty team', archived: true, players: 0 }] });
    const out = G.pages.teams.teamsHtml({ guildData: gd, alert: '' });
    assert(out.includes('<td>23</td>') || out.includes('23 players'));
    assert(out.includes('href="#/g/g1/roster?team=t_old"') && out.includes('aria-label="Open roster of Old team"'));
    assert(out.includes('team=t_empty'), 'every archived team, even with no active players');
    assert(out.includes('4 players'));
  });

  await check('Privacy: the Raid-Helper import sentence, word for word', () => {
    const out = G.pages.privacy.privacyHtml({ me: null });
    assert(out.includes(ctx.esc('Officers can import a Raid-Helper event. That stores each sign-up\'s Discord ID and nickname on the roster, linked to their roster entry, until an officer removes the person or the person signs in and deletes their data.')));
  });

  // ── Raid-Helper import ─────────────────────────────────────────
  function rhRow(signupId, nickname, kind, main, alts, extra) {
    const e = extra || {};
    return {
      signupId, nickname, kind, person: e.person || null, canAddAlts: e.canAddAlts === undefined ? kind === 'on_roster' : e.canAddAlts, signedIn: !!e.signedIn,
      main: Object.assign({ name: null, class: null, spec: null, note: null, taken: null }, main),
      alts: (alts || []).map(a => Object.assign({ taken: null }, a)),
      ticked: e.ticked === undefined ? kind === 'new' : e.ticked,
    };
  }
  const RH_ROWS = [
    rhRow(101, 'Thornvald/Thornpaw', 'new', { name: 'Thornvald', class: 'WARRIOR', spec: 'Protection' }, [{ name: 'Thornpaw' }], { signedIn: true }),
    rhRow(102, 'Kaelith', 'new', { name: 'Kaelith', class: 'DRUID', spec: 'Feral (Tank)' }, []),
    rhRow(103, 'Sølvhand/Glimmerkin', 'new', { name: 'Sølvhand', class: 'PALADIN', spec: 'Protection' }, [{ name: 'Glimmerkin' }]),
    rhRow(104, 'Frostwhisper', 'new', { name: 'Frostwhisper', class: 'MAGE', spec: 'Frost', note: 'tentative' }, []),
    rhRow(105, 'Longstride', 'new', { name: 'Longstride', class: null, spec: null, note: 'absence' }, []),
    rhRow(106, '123 456', 'new', { name: null, class: null, spec: null, note: 'no_class' }, []),
    rhRow(107, 'Takenname', 'new', { name: 'Brightmane', class: 'PALADIN', spec: 'Holy', taken: { personId: 'p_2', name: 'Brightmane' } }, [{ name: 'Sunny', taken: { personId: 'p_77', name: 'Someone' } }]),
    rhRow(108, 'Nodiscord', 'no_discord', { name: 'Nodiscord', class: 'ROGUE', spec: 'Combat' }, []),
    rhRow(109, 'Velanne/Velshade', 'on_roster', { name: 'Velanne', class: 'PRIEST', spec: 'Shadow' }, [{ name: 'Velshade' }], { person: { id: 'p_20', name: 'Velanne' }, canAddAlts: true }),
    rhRow(110, 'Ashcaller/Embervein', 'on_roster', { name: 'Ashcaller', class: 'WARLOCK', spec: 'Destruction' }, [{ name: 'Embervein' }], { person: { id: 'p_21', name: 'Ashcaller' }, canAddAlts: false }),
  ];
  const rhPreview = (over) => Object.assign({ event: { id: '1483258698854826006', title: 'Gruul and Mag', startTime: Date.UTC(2026, 9, 15, 19), otherServer: false }, rows: plain(RH_ROWS) }, over || {});
  const rhState = (preview, over) => {
    const st = G.pages.import.ensureState('rh', 'g1', 't_main');
    Object.assign(st, { preview, rows: G.pages.import.rhInitRows(preview), rowErrors: {}, status: 'ready', result: null }, over || {});
    return st;
  };

  await check('Raid-Helper import: default ticks - new yes, taken / no_discord / on_roster no, Alts always unticked, Absence row ticked', () => {
    const rows = G.pages.import.rhInitRows(rhPreview());
    assert.equal(rows['101'].ticked, true);
    assert.equal(rows['105'].ticked, true, 'an Absence row is ticked but needs a class');
    assert.equal(rows['107'].ticked, false, 'a Main name another person already owns starts unticked');
    assert.equal(rows['108'].ticked, false);
    assert.equal(rows['109'].ticked, false);
    assert.equal(rows['106'].name, '', 'a nickname with no usable first name starts with an empty Main name');
    for (const r of Object.values(rows)) for (const a of r.alts) assert.equal(a.ticked, false);
  });

  await check('Raid-Helper import: footer counts people, ready, and who needs a class; "Add N people" counts ready new rows', () => {
    const p = rhPreview();
    const st = rhState(p);
    const c = G.pages.import.rhCounts(p, st.rows);
    assert.equal(c.people, 8, 'new + no_discord rows');
    assert.equal(c.ready, 4, 'Thornvald, Kaelith, Solvhand, Frostwhisper');
    assert.equal(c.needs, 2, 'Absence row (no class) and the row with no name');
    assert.equal(c.needsName, true);
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(out.includes('8 people - 4 ready - 2 need a name and class before they can be added'));
    assert(out.includes('id="rh-footer"') && out.includes('Nothing is saved yet.') && out.includes('data-action="rh-back"'), 'the T5 commit bar: count, nothing saved yet, Back');
    assert(out.includes('>Add 4 people<'));
    // pick a class for the Absence row and a name + class for the empty one
    st.rows['105'].class = 'HUNTER';
    st.rows['106'].name = 'Newguy';
    st.rows['106'].class = 'MAGE';
    const c2 = G.pages.import.rhCounts(p, st.rows);
    assert.equal(c2.ready, 6);
    assert.equal(c2.needs, 0);
    assert(G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st }).includes('>Add 6 people<'));
    assert(!G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st }).includes('before they can be added'));
    // a ticked no_discord row counts once ticked
    st.rows['108'].ticked = true;
    assert.equal(G.pages.import.rhCounts(p, st.rows).ready, 7);
  });

  await check('Raid-Helper import: the Main name is an editable input, a classless sign-up gets a class picker, notes explain each row', () => {
    const st = rhState(rhPreview());
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st, });
    assert(out.includes('<input class="gs-input gs-input-sm" type="text" id="rh-name-101"') && out.includes('value="Thornvald"'));
    assert(/id="rh-name-106"[^>]*value=""/.test(out) || out.includes('id="rh-name-106"'));
    assert(out.includes('aria-label="Main name for Thornvald/Thornpaw"'));
    assert(/<option value="" selected>Pick a class<\/option>/.test(out));
    assert(out.includes('Signed in: links to their account now') && out.includes('Tentative sign-up') && out.includes('Absence: the sign-up has no class') && out.includes('The sign-up has no class'));
    assert(out.includes('Brightmane is already Brightmane\'s character'));
    assert(out.includes('aria-label="Offer Thornpaw as an Alt"') && !/aria-label="Offer Thornpaw as an Alt"[^>]*checked/.test(out));
    assert(/aria-label="Offer Sunny as an Alt"[^>]*disabled/.test(out), 'a taken Alt name is disabled');
    assert(out.includes('aria-label="Class for Thornpaw"'));
    assert(!out.includes('gs-role-dot'), 'no role dot');
  });

  await check('Raid-Helper import: only the first 8 rows show until "Show all"', () => {
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(rhRow(200 + i, 'Player' + i, 'new', { name: 'Player' + i, class: 'MAGE', spec: 'Fire' }, []));
    const p = rhPreview({ rows });
    const st = rhState(p);
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert.equal((out.match(/id="rh-add-/g) || []).length, 8);
    assert(out.includes('Showing 8 of 12') && out.includes('>Show all<'));
    st.showAll = true;
    const all = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert.equal((all.match(/id="rh-add-/g) || []).length, 12);
    assert(all.includes('>Show fewer<'));
    assert(G.pages.import.rhCounts(p, st.rows).ready === 12, 'hidden rows still count');
  });

  await check('Raid-Helper import: "Already on the roster" is a collapsed section; Alts are disabled without canAddAlts', () => {
    const st = rhState(rhPreview());
    const closed = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(closed.includes('Already on the roster (2)') && /aria-expanded="false" aria-controls="rh-roster-list"/.test(closed) && /id="rh-roster-list" hidden/.test(closed));
    assert(closed.includes('href="#/g/g1/roster/p/p_20"'));
    assert(/aria-label="Offer Embervein as an Alt"[^>]*disabled/.test(closed) && closed.includes('You cannot add characters to this person.'));
    assert(!/aria-label="Offer Velshade as an Alt"[^>]*disabled/.test(closed));
    st.foldOpen = true;
    const open = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(/aria-expanded="true"/.test(open) && !/id="rh-roster-list" hidden/.test(open));
  });

  await check('Raid-Helper import: other-server notice above the table and the confirm on the primary button', () => {
    const p = rhPreview();
    p.event.otherServer = true;
    const st = rhState(p);
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(out.includes('This event was posted in a different Discord server than the Bantr server.'));
    assert(out.indexOf('different Discord server') < out.indexOf('<table'));
    assert(out.includes('>Add 4 people<'));
    st.confirmOtherServer = true;
    assert(G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st }).includes('>This event is from a different Discord server. Import anyway?<'));
    const normal = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: rhState(rhPreview()) });
    assert(!normal.includes('different Discord server'));
  });

  await check('Raid-Helper import: the commit body carries signup ids, Main, ticked Alts with a class - never a Discord ID', () => {
    const p = rhPreview();
    const st = rhState(p);
    st.rows['103'].alts[0] = { ticked: true, class: 'PRIEST' };
    st.rows['101'].alts[0] = { ticked: true, class: '' };      // ticked without a class is left out
    st.rows['105'].class = 'HUNTER';
    st.rows['109'].alts[0] = { ticked: true, class: 'WARLOCK' };  // on_roster row: Alts only
    st.rows['110'].alts[0] = { ticked: true, class: 'MAGE' };     // canAddAlts false: never sent
    const built = G.pages.import.rhCommitBody('t_main', p, st.rows, 'trial', false);
    assert.deepEqual(plain(built.body).teamId, 't_main');
    assert.equal(built.body.eventId, '1483258698854826006');
    assert.equal(built.body.defaultStatus, 'trial');
    assert.equal(built.body.acceptOtherServer, false);
    const bySignup = Object.fromEntries(plain(built.body.rows).map(r => [r.signupId, r]));
    assert.deepEqual(bySignup[103], { signupId: 103, main: { name: 'Sølvhand', class: 'PALADIN', spec: 'Protection' }, alts: [{ name: 'Glimmerkin', class: 'PRIEST' }] });
    assert.deepEqual(bySignup[101].alts, []);
    assert.deepEqual(bySignup[105].main, { name: 'Longstride', class: 'HUNTER', spec: null });
    assert.deepEqual(bySignup[109], { signupId: 109, alts: [{ name: 'Velshade', class: 'WARLOCK' }] });
    assert(!(110 in bySignup) && !(107 in bySignup) && !(108 in bySignup));
    assert.deepEqual(plain(built.sent).slice(0, 2), ['101', '102']);
    assert(!JSON.stringify(built.body).toLowerCase().includes('discord'), 'no Discord id key in the body');
    const other = G.pages.import.rhCommitBody('t_main', p, st.rows, 'raider', true);
    assert.equal(other.body.acceptOtherServer, true);
  });

  await check('Raid-Helper import: nicknames, titles and names are escaped', () => {
    const rows = [rhRow(1, HOSTILE, 'new', { name: QUOTES, class: 'MAGE', spec: 'Fire' }, [{ name: HOSTILE }]), rhRow(2, QUOTES, 'on_roster', { name: 'X' }, [{ name: HOSTILE, taken: { personId: 'p_1', name: QUOTES } }], { person: { id: 'p_1', name: HOSTILE }, canAddAlts: true })];
    const p = rhPreview({ rows });
    p.event.title = HOSTILE;
    p.event.otherServer = true;
    const st = rhState(p, { error: HOSTILE, rowErrors: { 1: HOSTILE }, foldOpen: true });
    const out = G.pages.import.raidHelperHtml({ guildData: Object.assign(guildData(), { guild: Object.assign({}, guildData().guild, { name: HOSTILE }) }), rh: st });
    assertEscaped(out, 'raid-helper import');
    assertNoRawAttrs(out);
  });

  await check('Raid-Helper import: commit errors map to the page - event_changed offers a reload, other_server asks for the confirm, name_taken marks its row', async () => {
    const p = rhPreview();
    const mkState = () => {
      const s = G.app.state;
      s.guilds.g1 = guildData();
      s.currentGid = 'g1';
      return rhState(JSON.parse(JSON.stringify(p)), {});
    };
    // event_changed -> message + "Load the event again"
    let st = mkState();
    await withApi({ post: () => Promise.reject(new G.api.ApiError(409, { error: 'event_changed', message: 'A sign-up is gone from the event.', index: 2 })) }, async () => {
      G.handlers.click['rh-commit']();
      await tick();
    });
    assert.equal(st.error, 'A sign-up is gone from the event.');
    assert.equal(st.offerReload, true);
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(out.includes('Load the event again') && out.includes('A sign-up is gone from the event.'));
    // other_server -> confirm state
    st = mkState();
    await withApi({ post: () => Promise.reject(new G.api.ApiError(409, { error: 'other_server', message: 'Different server.' })) }, async () => {
      G.handlers.click['rh-commit']();
      await tick();
    });
    assert.equal(st.preview.event.otherServer, true);
    assert.equal(st.confirmOtherServer, true);
    // name_taken with an index -> that row
    st = mkState();
    await withApi({ post: () => Promise.reject(new G.api.ApiError(409, { error: 'name_taken', message: 'Sølvhand is taken.', field: 'name', index: 2, owner: { personId: 'p_1', name: 'X' } })) }, async () => {
      G.handlers.click['rh-commit']();
      await tick();
    });
    assert.equal(st.rowErrors['103'], 'Sølvhand is taken.');
    assert(G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st }).includes('Sølvhand is taken.'));
  });

  await check('Raid-Helper import: a successful commit sends the body, refreshes the badge, and ends on an inline result (Open roster, Import another)', async () => {
    const p = rhPreview();
    const s = G.app.state;
    s.guilds.g1 = guildData();
    s.currentGid = 'g1';
    rhState(p);
    let sent;
    let hashes;
    await withApi({ post: (url, body) => { sent = { url, body }; return Promise.resolve({ ok: true, rosterFlags: { t_main: 5 } }); } }, async h => {
      G.handlers.click['rh-commit']();
      await tick();
      hashes = h;
    });
    assert.equal(sent.url, '/api/guild/g1/roster/import/raid-helper/commit');
    assert.equal(plain(sent.body).rows.length, 4);
    assert.deepEqual(plain(hashes), [], 'the officer stays on the import page');
    assert.equal(s.guilds.g1.rosterFlags.t_main, 5);
    const st = s.imports.rh;
    assert(st.result.title.startsWith('Added 4 people') && st.preview === null);
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(out.includes('id="rh-result-banner"') && out.includes('Added 4 people') && out.includes('href="#/g/g1/roster"') && out.includes('data-action="rh-again"'));
    assert(!out.includes('id="rh-footer"') && !out.includes('id="rh-link"'), 'no commit bar and no form on the result step');
    G.handlers.click['rh-again']();
    assert.equal(G.app.state.imports.rh.result, null, 'Import another starts afresh');
    assert.equal(G.app.state.imports.rh.preview, null);
  });

  await check('Raid-Helper import: Back keeps the link and returns to the Source step; the stepper names Source, Preview, Import', () => {
    const p = rhPreview();
    const st = rhState(p, { link: 'https://raid-helper.dev/event/1', result: null });
    G.app.state.currentGid = 'g1';
    const preview = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(/<li class="gs-step is-done"[^>]*>(?:(?!<\/li>)[\s\S])*Source/.test(preview) && /<li class="gs-step is-current" aria-current="step">(?:(?!<\/li>)[\s\S])*Preview/.test(preview), 'step 2 of 3');
    assert(!preview.includes('id="rh-link"'), 'the form is not on the Preview step');
    G.handlers.click['rh-back']();
    assert.equal(st.preview, null);
    assert.equal(st.link, 'https://raid-helper.dev/event/1');
    const source = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: st });
    assert(source.includes('value="https://raid-helper.dev/event/1"') && /<li class="gs-step is-current" aria-current="step">(?:(?!<\/li>)[\s\S])*Source/.test(source));
    assert(source.includes('class="gs-import-sources"') && source.includes('href="#/g/g1/roster/import/wcl"') && source.includes('href="#/g/g1/roster/import/csv"') && source.includes('href="#/g/g1/roster/import/bnet"'), 'where is your roster: the four sources');
  });

  await check('Raid-Helper import: "Load sign-ups" posts { teamId, source } and builds the state from the preview', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData();
    s.currentGid = 'g1';
    const st = G.pages.import.ensureState('rh', 'g1', 't_main');
    st.link = 'https://raid-helper.dev/event/1483258698854826006';
    let sent;
    await withApi({ post: (url, body) => { sent = { url, body }; return Promise.resolve(rhPreview()); } }, async () => {
      G.handlers.submit['rh-load']();
      await tick();
    });
    assert.deepEqual(plain(sent), { url: '/api/guild/g1/roster/import/raid-helper/preview', body: { teamId: 't_main', source: 'https://raid-helper.dev/event/1483258698854826006' } });
    assert.equal(st.status, 'ready');
    assert.equal(Object.keys(st.rows).length, 10);
    const failing = G.pages.import.ensureState('rh', 'g1', 't_main');
    await withApi({ post: () => Promise.reject(new G.api.ApiError(403, { error: 'event_private', message: 'That event is private.' })) }, async () => {
      G.handlers.submit['rh-load']();
      await tick();
    });
    assert.equal(failing.error, 'That event is private.');
    assert.equal(failing.preview, null);
  });

  await check('import pages: the page markup has the nickname form, labels and the Cancel link to the roster', () => {
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: G.pages.import.ensureState('rh', 'g1', 't_other') });
    assert(out.includes('Import from Raid-Helper') && out.includes('Everyone who signed up becomes a person on the roster, linked by their Discord account.'));
    assert(out.includes('<label class="gs-label" for="rh-link">Raid-Helper event link</label>') && out.includes('>Preview sign-ups<'));
  });

  // ── Warcraft Logs import ───────────────────────────────────────
  const WCL_PREVIEW = {
    report: { code: 'aBcD1234eFgH5678', flavour: 'fresh', title: 'Hyjal Summit', zone: 'Hyjal Summit', startTime: Date.UTC(2026, 9, 14, 19) },
    matched: [{ name: 'Brightmane', class: 'PALADIN', person: { id: 'p_2', name: 'Brightmane' } }, { name: 'Ashcaller', class: 'WARLOCK', person: { id: 'p_1', name: 'Ashcaller' } }],
    toDecide: [
      { key: 'thornpaw|', name: 'Thornpaw', realm: null, class: 'HUNTER', otherRealm: false, suggestion: { personId: 'p_8', name: 'Thornvald' } },
      { key: 'embervein|', name: 'Embervein', realm: null, class: 'MAGE', otherRealm: false, suggestion: { personId: 'p_1', name: 'Ashcaller' } },
      { key: 'grimtusk|', name: 'Grimtusk', realm: null, class: 'WARRIOR', otherRealm: false, suggestion: null },
      { key: 'fernwhisk|', name: 'Fernwhisk', realm: null, class: 'DRUID', otherRealm: false, suggestion: null },
      { key: 'farlander|maladath', name: 'Farlander', realm: 'Maladath', class: 'ROGUE', otherRealm: true, suggestion: { personId: 'p_8', name: 'Thornvald' } },
    ],
  };
  const wclState = (over) => {
    const st = G.pages.import.ensureState('wcl', 'g1', 't_main');
    Object.assign(st, { preview: plain(WCL_PREVIEW), choices: G.pages.import.wclInitChoices(WCL_PREVIEW), status: 'ready', error: '', knownOpen: false, result: null }, over || {});
    return st;
  };
  const WCL_PEOPLE = [plain(PEOPLE[0]), plain(PEOPLE[1])];

  await check('Warcraft Logs import: defaults - a suggestion is an Alt, no match is Skip, another realm is Skip', () => {
    const c = G.pages.import.wclInitChoices(WCL_PREVIEW);
    assert.equal(c['thornpaw|'].action, 'alt');
    assert.equal(c['thornpaw|'].personId, 'p_8');
    assert.equal(c['grimtusk|'].action, 'skip');
    assert.equal(c['farlander|maladath'].action, 'skip', 'another realm never starts as an Alt');
  });

  await check('Warcraft Logs import: header chips, known-names fold, class only in "In the log", From <realm>, Match text', () => {
    const st = wclState();
    const out = G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE });
    assert(out.includes('Hyjal Summit &middot; Oct 14, 2026 &middot; 7 players'));
    assert(out.includes('2 on the roster') && out.includes('5 to decide'));
    assert(out.includes('2 characters already on the roster') && /aria-expanded="false" aria-controls="wcl-known-list"/.test(out) && /id="wcl-known-list" hidden/.test(out));
    assert(out.includes('In Thornvald\'s Discord nickname') && out.includes('No match'));
    assert(out.includes('<td data-label="In the log">Hunter</td>'), 'class only, no spec');
    assert(out.includes('From Maladath'));
    assert(out.includes('Add as Alt of Thornvald') && out.includes('Add as Alt of someone else...') && out.includes('>New person<') && out.includes('Skip (not a guild member)'));
    st.knownOpen = true;
    assert(/aria-expanded="true"/.test(G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE })));
  });

  await check('Warcraft Logs import: the summary counts Alts, new people and skips; the button counts changes', () => {
    const st = wclState();
    st.choices['embervein|'] = { action: 'alt', personId: 'p_1', status: 'trial' };
    st.choices['fernwhisk|'] = { action: 'new', personId: '', status: 'trial' };
    const out = G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE });
    assert(out.includes('3 changes: 2 Alts, 1 new person - 2 skipped.'));
    assert(out.includes('>Save 3 changes<'));
    assert(out.includes('Starting status for Fernwhisk') && /<option value="trial" selected>Trial<\/option>/.test(out));
    const fresh = wclState();
    fresh.choices = G.pages.import.wclInitChoices(WCL_PREVIEW);
    const c = G.pages.import.wclCounts(WCL_PREVIEW, fresh.choices);
    assert.deepEqual(plain(c), { alts: 2, news: 0, skipped: 3, incomplete: 0 });
    const none = Object.fromEntries(Object.keys(fresh.choices).map(k => [k, { action: 'skip', personId: '', status: 'trial' }]));
    const emptyOut = G.pages.import.wclHtml({ guildData: guildData(), wcl: Object.assign(fresh, { choices: none }), people: WCL_PEOPLE });
    assert(emptyOut.includes('No changes yet') && /<button[^>]*disabled[^>]*data-action="wcl-commit"/.test(emptyOut));
  });

  await check('Warcraft Logs import: "Add as Alt of someone else" shows a person picker; an unpicked person is not a change', () => {
    const st = wclState();
    st.choices['grimtusk|'] = { action: 'other', personId: '', status: 'trial' };
    let out = G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE });
    assert(out.includes('Which person owns Grimtusk') && out.includes('<option value="p_1">Ashcaller</option>'));
    assert.equal(G.pages.import.wclCounts(WCL_PREVIEW, st.choices).incomplete, 1);
    st.choices['grimtusk|'].personId = 'p_2';
    assert.equal(G.pages.import.wclCounts(WCL_PREVIEW, st.choices).alts, 3);
    out = G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE });
    assert(/<option value="p_2" selected>Brightmane<\/option>/.test(out));
  });

  await check('Warcraft Logs import: the commit body keeps report code / flavour and drops skips', () => {
    const st = wclState();
    st.choices['fernwhisk|'] = { action: 'new', personId: '', status: 'trial' };
    st.choices['grimtusk|'] = { action: 'other', personId: 'p_2', status: 'trial' };
    const body = plain(G.pages.import.wclCommitBody('t_main', st.preview, st.choices));
    assert.deepEqual(body.report, { code: 'aBcD1234eFgH5678', flavour: 'fresh' });
    assert.equal(body.teamId, 't_main');
    const by = Object.fromEntries(body.decisions.map(d => [d.key, d]));
    assert.deepEqual(by['thornpaw|'], { key: 'thornpaw|', name: 'Thornpaw', realm: null, class: 'HUNTER', action: 'alt', personId: 'p_8' });
    assert.deepEqual(by['fernwhisk|'], { key: 'fernwhisk|', name: 'Fernwhisk', realm: null, class: 'DRUID', action: 'new', status: 'trial' });
    assert.deepEqual(by['grimtusk|'], { key: 'grimtusk|', name: 'Grimtusk', realm: null, class: 'WARRIOR', action: 'alt', personId: 'p_2' });
    assert(!('farlander|maladath' in by), 'a skipped other-realm row is not sent');
  });

  await check('Warcraft Logs import: names, report title and realm are escaped', () => {
    const pv = plain(WCL_PREVIEW);
    pv.report.title = HOSTILE;
    pv.toDecide[0].name = QUOTES;
    pv.toDecide[0].suggestion = { personId: 'p_8', name: HOSTILE };
    pv.toDecide[4].realm = HOSTILE;
    pv.matched[0].person.name = HOSTILE;
    const st = wclState({ preview: pv, knownOpen: true, error: HOSTILE });
    const out = G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: [Object.assign(plain(PEOPLE[0]), { main: { id: 'c_1', name: HOSTILE, class: 'WARLOCK', team: TEAM_MAIN } })] });
    assertEscaped(out, 'wcl import');
    assertNoRawAttrs(out);
  });

  await check('Warcraft Logs import: Preview players posts { teamId, source }; a commit posts the decisions and ends on an inline result', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData();
    s.currentGid = 'g1';
    const st = G.pages.import.ensureState('wcl', 'g1', 't_main');
    st.link = 'https://fresh.warcraftlogs.com/reports/aBcD1234eFgH5678';
    let sent;
    await withApi({ post: (url, body) => { sent = { url, body }; return Promise.resolve(plain(WCL_PREVIEW)); } }, async () => {
      G.handlers.submit['wcl-load']();
      await tick();
    });
    assert.deepEqual(plain(sent), { url: '/api/guild/g1/roster/import/wcl/preview', body: { teamId: 't_main', source: 'https://fresh.warcraftlogs.com/reports/aBcD1234eFgH5678' } });
    assert.equal(st.choices['thornpaw|'].action, 'alt');
    let commit;
    let hashes;
    await withApi({ post: (url, body) => { commit = { url, body }; return Promise.resolve({ ok: true, rosterFlags: {} }); } }, async h => {
      G.handlers.click['wcl-commit']();
      await tick();
      hashes = h;
    });
    assert.equal(commit.url, '/api/guild/g1/roster/import/wcl/commit');
    assert.equal(plain(commit.body).decisions.length, 2);
    assert.deepEqual(plain(hashes), []);
    assert(st.result.title.startsWith('Saved 2 changes') && st.preview === null);
    assert(G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE }).includes('id="wcl-result-banner"'));
    G.handlers.click['wcl-again']();
    assert.equal(G.app.state.imports.wcl.result, null);
  });

  // ── fix round: search, confirm, labels, overlays, officer-only flags, row errors ──
  await check('search: matches any name in row.names, accent-insensitive ("solv" finds Solvhand with an o-slash), falls back to shown/main', () => {
    const f = (people, q) => names(G.rosterSort.filterPeople(people, { role: 'all', status: 'everyone', query: q }, 't_main'));
    assert.deepEqual(f(PEOPLE, 'solv'), ['Sølvhand']);
    assert.deepEqual(f(PEOPLE, 'SØLV'), ['Sølvhand']);
    const withNames = plain(PEOPLE[0]);
    withNames.names = ['Ashcaller', 'Embervein', 'Cindra'];
    assert.equal(f([withNames], 'embervein').length, 1, 'an Alt name from row.names');
    assert.equal(f([withNames], 'cindra').length, 1);
    assert.equal(f([withNames], 'zzz').length, 0);
    const old = plain(PEOPLE[0]);
    assert.equal(f([old], 'ashcal').length, 1, 'no names array: shown / main');
    const fold = G.rosterSort.fold;
    assert.equal(fold('Éclair æon œuvre Straße ł đ þ ð'), 'eclair aeon oeuvre strasse l d th d');
    assert.equal(fold('Gnøpe'), 'gnope');
  });

  await check('remove character: the button only opens a confirm; Remove sends the DELETE', async () => {
    const rec = record();
    const s = setupPerson(rec);
    const out = G.pages.person.removeCharDialogHtml(rec, rec.characters[1]);
    assert(out.includes('Remove Glimmerkin from Sølvhand&#39;s characters?') && out.includes('>Cancel<') && out.includes('>Remove</span></button>'));
    assert(out.includes('data-submit="remove-char-form"'));
    const calls = [];
    await withApi({ del: (...a) => { calls.push(a); return Promise.resolve(Object.assign(record(), { rosterFlags: { t_main: 2 } })); } }, async () => {
      G.handlers.click['char-remove'](el({ 'data-cid': 'c_8b' }));
      await tick();
      assert.equal(calls.length, 0, 'no request before the confirm');
      G.handlers.submit['remove-char-form']({ getAttribute: () => 'c_8b', querySelectorAll: () => [] });
      await tick();
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/guild/g1/roster/p_8/characters/c_8b');
    void s;
  });

  await check('conflicts on character and person writes re-render from body.current (moved teams)', async () => {
    const s = setupPerson(record());
    const fresh = record({ person: { version: 9, status: 'reserve', trialFlag: null } });
    await withApi({ post: () => Promise.reject(new G.api.ApiError(409, { error: 'conflict', message: 'Moved.', current: fresh })) }, async () => {
      G.handlers.click['char-main'](el({ 'data-cid': 'c_8b' }));
      await tick();
    });
    assert.equal(s.person.record.person.version, 9);
    assert(s.pageAlert.startsWith('Someone else changed this person.'));
    s.pageAlert = '';
    await withApi({ del: () => Promise.reject(new G.api.ApiError(409, { error: 'conflict', message: 'Moved.', current: record({ person: { version: 10 } }) })) }, async () => {
      G.handlers.submit['remove-char-form']({ getAttribute: () => 'c_8b', querySelectorAll: () => [] });
      await tick();
    });
    assert.equal(s.person.record.person.version, 10);
    assert(s.pageAlert.startsWith('Someone else changed this person.'));
  });

  await check('Raid-Helper page header counts "N sign-ups", not Discord members', () => {
    const out = G.pages.import.raidHelperHtml({ guildData: guildData(), rh: rhState(rhPreview()) });
    assert(out.includes('10 sign-ups') && !out.includes('Discord members'));
  });

  await check('Warcraft Logs selects all have ids and matching labels, unique per row', () => {
    const st = wclState();
    st.choices['grimtusk|'] = { action: 'other', personId: '', status: 'trial' };
    st.choices['fernwhisk|'] = { action: 'new', personId: '', status: 'trial' };
    const out = G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE });
    const ids = [...out.matchAll(/<select[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
    assert(ids.length >= 7 && new Set(ids).size === ids.length, 'unique ids: ' + ids.join(','));
    assert.equal(ids.length, (out.match(/<select/g) || []).length, 'every select has an id');
    for (const id of ids.filter(i => i.startsWith('wcl-'))) assert(out.includes('for="' + id + '"'), 'label for ' + id);
    assert(out.includes('What to do with Thornpaw') && out.includes('Which person owns Grimtusk') && out.includes('Starting status for Fernwhisk'));
    assert(!/<select[^>]*data-change="wcl-[^>]*aria-label=/.test(out));
  });

  await check('Warcraft Logs commit: a 400 with field realm and an index marks that decision row', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData();
    s.currentGid = 'g1';
    const st = wclState();
    st.choices['fernwhisk|'] = { action: 'new', personId: '', status: 'trial' };
    await withApi({ post: () => Promise.reject(new G.api.ApiError(400, { error: 'bad_request', message: 'That realm is not on the list.', field: 'realm', index: 1 })) }, async () => {
      G.handlers.click['wcl-commit']();
      await tick();
    });
    // decisions: thornpaw (alt), embervein (alt), fernwhisk (new) -> index 1 is embervein
    assert.equal(st.rowErrors['embervein|'], 'That realm is not on the list.');
    assert(G.pages.import.wclHtml({ guildData: guildData(), wcl: st, people: WCL_PEOPLE }).includes('That realm is not on the list.'));
    assert.equal(st.status, 'ready');
  });

  await check('overlays: closeOverlays closes every open dialog, and the guild route runs it again before the final render', () => {
    let closed = 0;
    const dlg = { close: () => { closed++; } };
    const fakeDoc = { querySelectorAll: () => [dlg, dlg], getElementById: () => null };
    G.app.closeOverlays(fakeDoc);
    assert.equal(closed, 2);
    const src = read('js/guild/app.js');
    assert(/closeOverlays\(\);[^\n]*\n\s*render\(true\);/.test(src), 'the guild route closes dialogs just before it renders');
  });

  await check('trial flags are for officers: the rose flag chips need can.edit and the home team; members see the blue Trial chip only', () => {
    const gd = guildData();
    const editor = rosterPage(gd, rosterData());
    assert(editor.includes('Ends in 5 days'));
    const member = rosterPage(guildData({ can: MEMBER_CAN, flags: {} }), rosterData({ can: { edit: false } }));
    assert(!member.includes('Ends in 5 days') && !member.includes('Trial ended') && !member.includes('is-rose') && member.includes('gs-hd-chip is-blue">Trial</span>'));
    assert(!member.includes('Trials to decide') && !editor.includes('Trials to decide'), 'the status select (and its Trials to decide choice) is gone; Needs you replaces it');
    const away = plain(PEOPLE).map(p => (p.shown.name === 'Frostwhisper' ? Object.assign(p, { main: Object.assign({}, p.main, { team: TEAM_WEEKEND }) }) : p));
    const other = rosterPage(gd, rosterData({ people: away }));
    assert(!other.includes('Ends in 5 days') && other.includes('Trial ended'), 'a trial of another home team shows no flag');
  });

  await check('inactive: the Reason and Left on fields show only for Inactive (default today, or the stored values) and the status reads "Inactive - Kicked, left Oct 12, 2026"', async () => {
    // A trial: fields present but hidden, the date defaults to today.
    editing(record(), true);
    const trial = personPage(record());
    editing(record(), false);
    assert(/<select class="gs-input" id="det-status" name="status"[^>]*data-change="person-status-change">/.test(trial));
    assert(/id="det-reason-field" hidden>/.test(trial) && /id="det-lefton-field" hidden>/.test(trial));
    assert(/name="leftOn"[^>]* value="2026-10-15"/.test(trial));
    assert(trial.includes('<option value="" selected>No reason</option>') && ['Left guild', 'Kicked', 'Break', 'Other'].every(t => trial.includes('>' + t + '</option>')));
    // An inactive person: fields shown with the stored values.
    const goneRec = record({ person: { status: 'inactive', trialFlag: null, leftReason: 'kicked', leftOn: '2026-10-12' } });
    assert(personPage(goneRec).includes('Inactive - Kicked, left Oct 12, 2026'), 'read-only Details say the reason and the day');
    editing(goneRec, true);
    const gone = personPage(goneRec);
    editing(goneRec, false);
    assert(/id="det-reason-field">/.test(gone) && /id="det-lefton-field">/.test(gone));
    assert(gone.includes('<option value="kicked" selected>Kicked</option>') && /name="leftOn"[^>]* value="2026-10-12"/.test(gone));
    // The select toggles the fields.
    const fields = { 'det-reason-field': { hidden: true }, 'det-lefton-field': { hidden: true }, 'det-trial-fields': { hidden: false } };
    const saved = ctx.document;
    ctx.document = { getElementById: id => fields[id] || null };
    try {
      G.handlers.change['person-status-change']({ value: 'inactive' });
      assert(!fields['det-reason-field'].hidden && !fields['det-lefton-field'].hidden && fields['det-trial-fields'].hidden, 'the trial dates belong to Trial only');
      G.handlers.change['person-status-change']({ value: 'raider' });
      assert(fields['det-reason-field'].hidden && fields['det-lefton-field'].hidden);
      G.handlers.change['person-status-change']({ value: 'trial' });
      assert(!fields['det-trial-fields'].hidden);
    } finally { ctx.document = saved; }
  });

  await check('inactive text drops the parts that are null', () => {
    const text = (reason, day) => G.ui.statusText({ status: 'inactive', leftReason: reason, leftOn: day });
    assert.equal(text(null, null), 'Inactive');
    assert.equal(text('break', null), 'Inactive - Break');
    assert.equal(text(null, '2026-10-12'), 'Inactive, left Oct 12, 2026');
    assert.equal(text('left', '2026-10-12'), 'Inactive - Left guild, left Oct 12, 2026');
    assert.equal(G.ui.statusText({ status: 'raider', leftReason: 'kicked', leftOn: '2026-10-12' }), 'Raider', 'only Inactive carries the detail');
    assert.equal(text('<b>', null), 'Inactive', 'an unknown reason shows nothing');
    const old = Object.assign({}, PEOPLE[10], { leftReason: 'kicked', leftOn: '2026-10-12' });
    const out = rosterPage(guildData(), rosterData({ people: [old] }), { status: 'inactive' });
    assert(phoneOf(out).includes('gs-hd-chip is-grey">Inactive</span>'), 'the roster list shows a grey Inactive chip (the reason and the day live on the person record)');
  });

  await check('details save sends leftOn / leftReason only for Inactive: both when entering it, the changed one while in it, none otherwise', async () => {
    const s = setupPerson(record());
    const calls = [];
    const reply = () => Promise.resolve(Object.assign(record({ person: { version: s.person.record.person.version + 1 } }), { rosterFlags: { t_main: 2 } }));
    const field = v => ({ value: v, focus() {}, select() {}, setAttribute() {} });
    const form = extra => ({ elements: extra, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [] });
    const base = { joinedOn: field('2026-09-15'), trialStart: field('2026-09-15'), trialEnd: field('2026-10-13') };
    await withApi({ patch: (url, body) => { calls.push(plain(body)); return reply(); } }, async () => {
      G.handlers.submit['person-details-form'](form(Object.assign({ status: field('inactive'), leftReason: field(''), leftOn: field('2026-10-15') }, base)));
      await tick();
      assert.deepEqual(calls[0], { expectedVersion: 3, status: 'inactive', leftOn: '2026-10-15', leftReason: null });
      G.handlers.submit['person-details-form'](form(Object.assign({ status: field('raider'), leftReason: field('kicked'), leftOn: field('2026-10-15') }, base)));
      await tick();
      assert.deepEqual(calls[1], { expectedVersion: 4, status: 'raider' }, 'hidden fields are not sent');
    });
  });

  await check('trial flags are for officers: a member\'s record has no chip or trial bar, but read-only Details with the dates', () => {
    const rec = record({ top: { can: { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false } }, notes: null });
    const out = personPage(rec, guildData({ can: MEMBER_CAN, flags: {} }));
    assert(!out.includes('Ended 2 days ago') && !out.includes('gs-trial-bar') && headOf(out).includes('is-blue">Trial<'));
    assert(out.includes('id="details-h">Details</h2>') && text(out).includes('Joined Sep 15, 2026') && text(out).includes('Trial Sep 15, 2026 - Oct 13, 2026'));
    assert(!out.includes('<form') && !out.includes('<input'));
    const officer = personPage(record());
    assert(headOf(officer).includes('is-rose">Ended 2 days ago<') && !officer.includes('gs-trial-bar'));
  });

  // ── hygiene ────────────────────────────────────────────────────
  await check('roster scripts: classic IIFEs on the one Guild namespace, ASCII only, no inline style or handlers in markup', () => {
    for (const f of ['roster-sort.js', 'pages-roster.js', 'pages-person.js', 'pages-import.js']) {
      const text = read('js/guild/' + f);
      assert(/window\.Guild = window\.Guild \|\| \{\}/.test(text), f);
      assert(!/^\s*(import|export)\s/m.test(text), f);
      text.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//')) return;
        assert(!/[^\x00-\x7f]/.test(line), `${f}:${i + 1} has a non-ASCII character`);
        assert(!/[\s`'"]style\s*=\s*["'`\\]/.test(line), `${f}:${i + 1} inline style`);
      });
    }
    assert(scriptSrcs.includes('/js/guild/roster-sort.js') && scriptSrcs.indexOf('/js/guild/pages-import.js') < scriptSrcs.indexOf('/js/guild/app.js'));
  });

  await check('guild.css: class colours, Shaman text #4a9bff, trial chips, 44px phone targets for the new controls, no horizontal page overflow rules broken', () => {
    for (const c of ['warrior', 'paladin', 'hunter', 'rogue', 'priest', 'shaman', 'mage', 'warlock', 'druid']) assert(css.includes('.gs-class-' + c), c);
    assert(/\.gs-class-shaman[^{]*\{ color: var\(--class-shaman-text\); \}/.test(css) && /--class-shaman-text: #4a9bff;/.test(css));
    assert(css.includes('.gs-trial-ends, .gs-trial-ended { background: rgba(242, 113, 138, 0.12)') && !css.includes('#4a4228') && !css.includes('#3a2510') && !css.includes('gs-trial-strip'), 'a trial to decide is the rose tint; the gold and orange literals and the strip are gone');
    const phone = css.split('@media (max-width: 600px)').filter(b => b.includes('.gs-seg {')).join('');
    assert(/\.gs-seg \{[^}]*min-height: 44px/.test(phone));
    assert(/\.gs-input-sm \{ height: 44px; \}/.test(phone));
    assert(/\.gs-roster-table, \.gs-char-table \{ display: none; \}/.test(phone));
    assert(/\.gs-roster-cards, \.gs-char-cards \{ display: flex/.test(phone));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
