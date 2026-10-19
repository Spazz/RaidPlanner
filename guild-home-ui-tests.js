/**
 * Raidsmith guild UI - officer Home, round 4 (home redesign lane H2): the Week on a desktop, the Briefing on a phone, the More menu, Hidden with Restore, the
 * undo toast, the loading / error / empty states, the zone tiles, and the Reviewed / Undo buttons of the Attendance watch list.
 * Run: node guild-home-ui-tests.js
 *
 * Same approach as guild-fw1b-ui-tests.js: the guild scripts load in a vm with no DOM, the pages return HTML strings and the handlers run against a stubbed
 * G.api. guild-home-contract-tests.js runs the same page against the real Worker. Both variants are in the markup (guild.css shows one), so the desktop
 * and phone parts are cut out of the string by their wrapper classes.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

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
function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
ctx.window = { location: { origin: 'https://raidsmith.test', hash: '' } };
const G = ctx.Guild;
const S = G.app.state;
const plain = v => JSON.parse(JSON.stringify(v));
const count = (s, re) => (s.match(re) || []).length;
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null }, extra || {});

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => {
    o[m] = (url, body) => {
      calls.push({ m, url, body: body && plain(body) });
      try { return Promise.resolve(handler(m, url, body)); } catch (error) { return Promise.reject(error); }
    };
    return o;
  }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const ApiErr = (status, code) => new ctx.Guild.api.ApiError(status, { error: code, message: 'Server says so.' });

function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

// ── fixtures: Wed Oct 21 2026 in New York ────────────────────────
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'guild.access': 'guild', 'loot.edit': 'guild' };
const TEAMS = [{ id: 't1', name: 'Main 25', size: 25, archived: false, players: 3, leads: [] }, { id: 't2', name: 'Kara A', size: 10, archived: false, players: 3, leads: [] }];
function gd(over) {
  const o = over || {};
  return {
    guild: Object.assign({ id: 'g1', name: 'Vindicated', realm: 'Firemaw', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'firemaw', createdAt: 1 }, o.guild || {}),
    teams: o.teams || TEAMS,
    me: { roles: [{ role: 'officer' }], can: OFFICER_CAN, personId: null },
    attendanceFlags: {}, rosterFlags: {},
  };
}
const NOW = Date.UTC(2026, 9, 21, 15, 0); // Wed 11:00 AM ET
const GRUUL_MAG = 'Gruul\'s Lair + Magtheridon\'s Lair';
const raid = (id, over) => Object.assign({ raidId: id, teamId: 't1', teamName: 'Main 25', date: '2026-10-21', startsAt: Date.UTC(2026, 9, 22, 0, 0), zone: GRUUL_MAG, title: null, size: 25, signed: 22, lineupPublished: true, confirmed: 19, cantCome: 2, noAnswer: 1, signupsCloseAt: Date.UTC(2026, 9, 21, 22, 0), signupsLocked: false, eventMovedOn: null, status: 'short' }, over || {});
const WEEK = [
  raid('r_tue', { date: '2026-10-20', startsAt: Date.UTC(2026, 9, 21, 0, 0), teamId: 't2', teamName: 'Kara A', zone: 'Karazhan', size: 10, signed: 9, status: 'todo', signupsCloseAt: null }),
  raid('r_wed'),
  raid('r_sat', { date: '2026-10-24', startsAt: Date.UTC(2026, 9, 24, 23, 0), teamId: 't2', teamName: 'Kara A', zone: 'Karazhan', size: 10, signed: 6, lineupPublished: false, confirmed: 0, cantCome: 0, noAnswer: 0, signupsCloseAt: Date.UTC(2026, 9, 24, 21, 0), status: 'short' }),
  raid('r_sun', { date: '2026-10-25', startsAt: Date.UTC(2026, 9, 26, 0, 0), signed: 14, lineupPublished: false, signupsCloseAt: null, status: 'open' }),
];
const todo = (kind, over) => Object.assign({ id: kind + ':1', kind, severity: 'action', teamId: 't1', teamName: 'Main 25', link: { name: 'raid', rid: 'r_wed' } }, over || {});
const ITEMS = [
  todo('review', { id: 'review:r_tue', raidId: 'r_tue', teamId: 't2', teamName: 'Kara A', date: '2026-10-20', zone: 'Karazhan', count: 2, link: { name: 'raid', rid: 'r_tue' } }),
  todo('loot_unmatched', { id: 'loot_unmatched:r_tue', raidId: 'r_tue', teamId: 't2', teamName: 'Kara A', date: '2026-10-20', zone: 'Karazhan', count: 2, link: { name: 'review' } }),
  todo('signup_unmatched', { id: 'signup_unmatched:r_sun', raidId: 'r_sun', date: '2026-10-25', zone: GRUUL_MAG, count: 3, link: { name: 'raid', rid: 'r_sun' } }),
  todo('applications', { id: 'applications:t1', count: 1, link: { name: 'applications' } }),
  todo('trial', { id: 'trial:p_o', name: 'Orlek', days: 2, ended: false, link: { name: 'person', pid: 'p_o' } }),
  todo('webhook_off', { id: 'webhook_off:t1', status: 404, link: { name: 'settings', tab: 'notifications' } }),
  todo('no_loot', { id: 'no_loot:r_old', raidId: 'r_old', date: '2026-10-10', zone: 'Karazhan', link: { name: 'raid', rid: 'r_old' } }),
  todo('low_signups', { id: 'low_signups:r_sat', raidId: 'r_sat', date: '2026-10-24', expected: 6, size: 10, readiness: true, link: { name: 'raid', rid: 'r_sat' } }),
];
const HIDDEN = [
  { item: todo('no_loot', { id: 'no_loot:r_h', raidId: 'r_h', date: '2026-10-17', zone: 'Karazhan' }), mode: 'dismiss', until: null, by: { name: 'Morwen' }, at: Date.UTC(2026, 9, 17, 16, 0) },
  { item: todo('webhook_off', { id: 'webhook_off:t2', teamId: 't2', teamName: 'Kara A', status: 404 }), mode: 'snooze', until: Date.UTC(2026, 9, 25, 16, 0), by: { name: 'Kezzik' }, at: Date.UTC(2026, 9, 18, 16, 0) },
];
const ATTN = over => Object.assign({
  today: '2026-10-21', total: 7, items: ITEMS, more: {}, hidden: HIDDEN, counts: { t1: { watchOpen: 2, rankOpen: 1 }, t2: { watchOpen: 1, rankOpen: 0 } }, week: WEEK, onboarding: null,
}, over || {});
const html = (data, extra, g) => G.pages.attention.attentionHtml(Object.assign({ guildData: g || gd(), data, now: NOW }, extra || {}));
const desk = out => out.slice(out.indexOf('class="gs-hd-desk"'), out.indexOf('class="gs-hd-phone"'));
const phone = out => out.slice(out.indexOf('class="gs-hd-phone"'));
const textOf = s => stripTags(s);

function withState(fn) {
  return async () => {
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, attention: S.attention, teamByGuild: S.teamByGuild, me: S.me };
    const savedApp = { requireSignin: G.app.requireSignin, showFailure: G.app.showFailure, render: G.app.render, handleError: G.app.handleError, routeAll: G.app.routeAll, ensureAttention: G.app.ensureAttention };
    const savedUi = { announce: G.ui.announce, focusByKey: G.ui.focusByKey };
    S.att = {}; S.guilds = { g1: gd() }; S.attention = {}; S.teamByGuild = { g1: 't1' }; S.currentGid = 'g1';
    S.me = { user: { id: 'u1', displayName: 'Kezzik', username: 'kez' }, guilds: [{ id: 'g1', name: 'Vindicated' }] };
    G.app.render = () => {};
    G.ui.announce = () => {};
    G.ui.focusByKey = () => true;
    try { await fn(S); } finally { Object.assign(S, saved); Object.assign(G.app, savedApp); Object.assign(G.ui, savedUi); }
  };
}

(async () => {
  // ═══ 1. The Week (desktop) ═══
  await check('Week: 7 days from yesterday to today + 5, tiny-caps dates, Today, a zone tile, the team, signed / size and a chip per raid', () => {
    const d = desk(html(ATTN()));
    assert.equal(count(d, /class="gs-hd-day[ "]/g), 7);
    const caps = [...d.matchAll(/<span class="gs-hd-caps">([^<]*)<\/span><span class="gs-hd-today">/g)].map(m => m[1]);
    assert.deepEqual(caps, ['Tue - Oct 20', 'Wed - Oct 21', 'Thu - Oct 22', 'Fri - Oct 23', 'Sat - Oct 24', 'Sun - Oct 25', 'Mon - Oct 26']);
    assert.equal(count(d, /<span class="gs-hd-today">Today<\/span>/g), 1);
    assert(d.indexOf('Wed - Oct 21') < d.indexOf('>Today<') && d.indexOf('>Today<') < d.indexOf('Thu - Oct 22'), 'Today sits on Wed');
    assert.equal(count(d, /class="gs-hd-day is-empty"/g), 3, 'Thu, Fri and Mon have no raid');
    assert.equal(count(d, /<span class="gs-hd-muted">No raid<\/span>/g), 3);
    assert(d.includes('<span class="gs-hd-cnt">22<span class="gs-hd-den"> / 25</span></span>'), 'signed / size with a muted denominator');
    assert(d.includes('<span class="gs-hd-team">Kara A</span>') && d.includes('<span class="gs-hd-team">Main 25</span>'));
    const chips = [...d.matchAll(/<span class="gs-hd-chip is-(\w+)">([^<]*)<\/span>/g)].map(m => m[1] + ':' + m[2]);
    assert.deepEqual(chips.slice(0, 4), ['todo:To do 2', 'short:Short', 'short:Short', 'open:Open'], 'the To do chip counts the raid\'s open to-dos');
  });

  await check('Week: every status has its chip word: done (quiet), to do N, short, ready, open - and a raid with a to-do count of 0 reads "To do"', () => {
    const week = [raid('a', { date: '2026-10-20', startsAt: 1, status: 'done' }), raid('b', { date: '2026-10-21', status: 'ready' }), raid('c', { date: '2026-10-22', startsAt: Date.UTC(2026, 9, 23, 0, 0), status: 'open' }),
      raid('d', { date: '2026-10-23', startsAt: Date.UTC(2026, 9, 24, 0, 0), status: 'todo' })];
    const d = desk(html(ATTN({ week, items: [] })));
    const chips = [...d.matchAll(/<span class="gs-hd-chip is-(\w+)">([^<]*)<\/span>/g)].map(m => m[1] + ':' + m[2]);
    assert.deepEqual(chips.slice(0, 4), ['done:Done', 'ready:Ready', 'open:Open', 'todo:To do']);
  });

  await check('Week: several raids on one day stack inside the day card, each selectable', () => {
    const week = WEEK.concat([raid('r_wed2', { teamId: 't2', teamName: 'Kara A', zone: 'Karazhan', size: 10, signed: 10, status: 'ready', startsAt: Date.UTC(2026, 9, 22, 1, 0) })]);
    const d = desk(html(ATTN({ week })));
    assert.equal(count(d, /class="gs-hd-day[ "]/g), 7, 'still seven cards');
    assert.equal(count(d, /data-action="home-select" data-raid="/g), 5);
    const wedCard = d.slice(d.indexOf('data-raid="r_wed"'), d.indexOf('Thu - Oct 22'));
    assert(wedCard.includes('data-raid="r_wed"') && wedCard.includes('data-raid="r_wed2"'));
    assert(wedCard.includes('is-stacked'));
  });

  await check('Week: the zone tile is the short name with its tint (Karazhan KARA, Gruul GRUUL, Magtheridon MAG ...); two zones show the first + "+1" in the strip and both in the panel; unknown zones use the first letters', () => {
    const want = { 'Karazhan': 'KARA', 'Gruul\'s Lair': 'GRUUL', 'Magtheridon\'s Lair': 'MAG', 'Serpentshrine Cavern': 'SSC', 'Tempest Keep': 'TK', 'Hyjal Summit': 'HYJAL', 'Black Temple': 'BT', 'Zul\'Aman': 'ZA', 'Sunwell Plateau': 'SWP' };
    for (const zone of Object.keys(want)) assert.equal(G.pages.attention.zoneTile(zone).abbr, want[zone], zone);
    assert.deepEqual(plain(G.pages.attention.zoneTile('Molten Core')), { abbr: 'MC', tint: 'other' });
    assert.deepEqual(plain(G.pages.attention.zoneTile('Naxxramas')), { abbr: 'NAX', tint: 'other' });
    const out = html(ATTN());
    const wedStrip = desk(out).slice(desk(out).indexOf('Wed - Oct 21'), desk(out).indexOf('Thu - Oct 22'));
    assert(wedStrip.includes('is-gruul') && wedStrip.includes('>+1</span>') && !wedStrip.includes('is-mag'), 'the strip: first tile + "+1"');
    const panel = desk(out).slice(desk(out).indexOf('aria-label="Selected day"'), desk(out).indexOf('aria-label="Guild"'));
    assert(panel.includes('is-gruul is-big') && panel.includes('is-mag is-big'), 'the panel: both tiles');
    assert(panel.includes('>GRUUL</span>') && panel.includes('>MAG</span>'));
  });

  // ═══ 2. The selected day ═══
  await check('Selected day: the default is the next upcoming raid (not the past one); heading with time and zone, team + raid line, big count, chip, the sentence, then Open raid, then TO DO', () => {
    const d = desk(html(ATTN()));
    const panel = d.slice(d.indexOf('aria-label="Selected day"'), d.indexOf('aria-label="Guild"'));
    assert(panel.includes('<h2 class="gs-hd-h2">Wed Oct 21, 8:00 PM ET</h2>'), 'the guild zone: 8 PM in New York');
    assert(panel.includes('<span class="gs-hd-sub">Main 25 - Gruul&#39;s Lair + Magtheridon&#39;s Lair</span>'));
    assert(panel.includes('<span class="gs-hd-bignum">22<span class="gs-hd-den"> / 25</span></span><span class="gs-hd-caps">Signed</span>'));
    assert(panel.includes('<span class="gs-hd-chip is-short">Short</span>'));
    assert(d.includes('data-raid="r_wed" data-key="home-raid-r_wed" aria-pressed="true"') && d.includes('data-raid="r_tue" data-key="home-raid-r_tue" aria-pressed="false"'));
    const at = s => panel.indexOf(s);
    assert(at('gs-hd-sentence') > at('gs-hd-chip') && at('Open raid') > at('gs-hd-sentence') && at('>To do</h2>') > at('Open raid'));
    assert(panel.includes('href="#/g/g1/raids/r/r_wed"'), 'Open raid goes to the raid');
    assert(panel.includes('Nothing to do.'), 'Wed has no to-dos');
  });

  await check('Selected day: the readiness sentence is built only from facts (signed of size, line-up, confirmed / Can\'t come / no answer, when sign-ups close)', () => {
    const wed = textOf(desk(html(ATTN())));
    assert(wed.includes('22 of 25 signed. Line-up published. 19 confirmed, 2 Can\'t come, 1 no answer. Sign-ups close 6:00 PM ET.'), wed);
    const sat = textOf(desk(html(ATTN(), { sel: 'r_sat' })));
    assert(sat.includes('6 of 10 signed. Line-up not published. Sign-ups close Sat 5:00 PM ET.'), 'not published: no confirmed counts; another day: the weekday is named');
    assert(!sat.includes('confirmed'));
    const sun = textOf(desk(html(ATTN(), { sel: 'r_sun' })));
    assert(sun.includes('14 of 25 signed. Line-up not published.') && !sun.includes('Sign-ups close') && !sun.includes('Sign-ups are'), 'no close time in the payload, no sentence about it');
    const locked = textOf(desk(html(ATTN({ week: [raid('r_wed', { signupsLocked: true })] }))));
    assert(locked.includes('Sign-ups are locked.'));
    const closed = textOf(desk(html(ATTN({ week: [raid('r_wed', { signupsCloseAt: NOW - 1000 })] }))));
    assert(closed.includes('Sign-ups are closed.'));
    const past = textOf(desk(html(ATTN(), { sel: 'r_tue' })));
    assert(past.includes('The Karazhan raid is over. 2 things are left to review.'), past);
    const done = textOf(desk(html(ATTN({ week: [raid('r_wed', { status: 'done', zone: 'Karazhan' })], items: [] }))));
    assert(done.includes('The Karazhan raid is over. Nothing is left to do.'));
    for (const text of [wed, sat, sun, past]) assert(!/healer|tank|short of|attendance %|\d+%/i.test(text), 'no role shortfall or percentage: those are not in the data');
  });

  await check('Selected day: a raid\'s to-dos have their action button; the kinds that can be hidden get a More menu (Hide for all officers + the kind line, or Snooze N days), the others do not', () => {
    const out = html(ATTN(), { sel: 'r_tue' });
    const panel = desk(out).slice(desk(out).indexOf('aria-label="Selected day"'), desk(out).indexOf('aria-label="Guild"'));
    assert(panel.includes('Review Tue Oct 20: 2 to decide') && panel.includes('2 loot winners on Tue Oct 20 match nobody'));
    assert(panel.includes('<span>Review</span>') && panel.includes('<span>Link winners</span>'));
    assert.equal(count(panel, /data-action="menu-toggle"/g), 1, 'review clears when handled: no menu; the loot winners can be ignored');
    assert(panel.includes('aria-label="More for 2 loot winners on Tue Oct 20 match nobody"'));
    assert(panel.includes('data-action="home-hide" data-item="loot_unmatched:r_tue"'));
    assert(panel.includes('Hide for all officers<small class="gs-menu-note">Ignore these names</small>'));
    const sun = desk(html(ATTN(), { sel: 'r_sun' }));
    assert(sun.includes('Leave them unlinked') && sun.includes('3 sign-ups on Sun Oct 25 are not linked to a person'));
    const guild = desk(html(ATTN()));
    assert(guild.includes('Snooze 3 days') && guild.includes('Snooze 7 days'), 'trial and webhook are snoozed');
    assert(!/Snooze[^<]*<\/button>[^]*?aria-label="More for 1 new application/.test(guild));
    assert(guild.includes('data-item="applications:t1"') === false, 'applications clear when handled: never hideable');
  });

  await check('Selected day: a day with no raid says so, with no primary button; selecting it keeps the strip', () => {
    const out = html(ATTN(), { sel: 'day:2026-10-22' });
    const panel = desk(out).slice(desk(out).indexOf('aria-label="Selected day"'), desk(out).indexOf('aria-label="Guild"'));
    assert(panel.includes('<h2 class="gs-hd-h2">Thu Oct 22</h2>') && panel.includes('No raid on this day.') && !panel.includes('gs-btn-molten'));
    assert(desk(out).includes('data-day="2026-10-22" data-key="home-day-2026-10-22" aria-pressed="true"'));
    assert.equal(count(desk(out), /class="gs-hd-day[ "]/g), 7);
  });

  await check('Primary: exactly one orange button per variant (Open raid, or Add raid with an empty week); no gold anywhere in the new markup or rules', () => {
    const out = html(ATTN());
    assert.equal(count(desk(out), /gs-btn-molten/g), 1);
    assert.equal(count(phone(out), /gs-btn-molten/g), 1);
    const css = read('guild.css');
    const block = css.slice(css.indexOf('Officer Home, round 4'));
    assert(!/accent-gold|#e0b53d/i.test(block.slice(0, block.indexOf('Watch list: Reviewed'))), 'orange only on the primary and no gold: the badge and logo are the shell\'s');
    assert(/\.gs-btn-molten[^{]*\{[^}]*var\(--molten\)/.test(block));
  });

  // ═══ 3. The Guild box ═══
  await check('Guild box: to-dos without a raid, then rank suggestions to Ranks, then Earlier raids (raid to-dos older than yesterday); the More links hold numbers only where the payload has them', () => {
    const d = desk(html(ATTN()));
    const guild = d.slice(d.indexOf('aria-label="Guild"'), d.indexOf('<nav class="gs-hd-more"'));
    const order = ['1 new application waiting', 'Orlek&#39;s trial ends in 2 days', 'The Discord webhook of Main 25 was switched off', '1 rank suggestion', 'Earlier raids', 'No loot imported for Sat Oct 10', 'Hidden (2)'];
    let at = -1;
    for (const s of order) { const i = guild.indexOf(s); assert(i > at, s + ' in order'); at = i; }
    assert(guild.includes('href="#/g/g1/attendance"') && guild.includes('<span>Open Ranks</span>'));
    assert(!guild.includes('Review Tue Oct 20'), 'raid to-dos of the week live on their day');
    assert(!guild.includes('attendance watch') && !guild.includes('Kaelith'), 'the old watch rows are gone');
    const more = d.slice(d.indexOf('<nav class="gs-hd-more"'));
    const links = [...more.matchAll(/<a class="gs-hd-link" href="([^"]*)">([^<]*)<\/a>/g)].map(m => m[2]);
    assert.deepEqual(links, ['Last raid: Tue, Karazhan', 'Attendance: 3 on the watch list', 'Recruiting needs', 'Progress']);
    const hrefs = [...more.matchAll(/<a class="gs-hd-link" href="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(hrefs, ['#/g/g1/raids/r/r_tue', '#/g/g1/attendance', '#/g/g1/roster/recruiting', '#/g/g1/raids']);
    const bare = desk(html(ATTN({ counts: {}, week: [] })));
    assert(bare.includes('>Attendance</a>') && bare.includes('>Last raid</a>'), 'no number or summary when the payload has none');
  });

  await check('Hidden: Hidden (N) opens the list with who hid it and when ("Hidden by Morwen, Oct 17" / "Snoozed until Oct 25") and a Restore button per row', () => {
    const closed = desk(html(ATTN()));
    assert(closed.includes('aria-expanded="false">Hidden (2)</button>') && !closed.includes('Restore'));
    const open = desk(html(ATTN(), { hiddenOpen: true }));
    assert(open.includes('aria-expanded="true">Hidden (2)</button>'));
    assert(open.includes('Hidden by Morwen, Oct 17') && open.includes('Snoozed until Oct 25'));
    assert(open.includes('aria-label="Restore No loot imported for Sat Oct 17"') && open.includes('data-action="home-restore" data-item="no_loot:r_h"'));
    assert.equal(count(open, /<span>Restore<\/span>/g), 2);
    assert(desk(html(ATTN({ hidden: [] }), { hiddenOpen: true })).includes('Nothing is hidden.'));
  });

  // ═══ 4. Hide, Restore, Undo ═══
  await check('More -> POST /attention/dismissals { itemId }, the list is read again, the toast says "Hidden for everyone" with Undo, and Undo -> DELETE /dismissals/:id', withState(async () => {
    const after = ATTN({ items: ITEMS.filter(i => i.id !== 'no_loot:r_old'), total: 6 });
    S.att.attention = { gid: 'g1', data: ATTN(), refreshing: false, error: '' };
    let s = stub((m, url) => (m === 'get' ? after : { ok: true }));
    await G.handlers.click['home-hide'](el({ 'data-item': 'no_loot:r_old' }));
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/attention/dismissals', { itemId: 'no_loot:r_old' }], ['get', '/api/guild/g1/attention', undefined]]);
    assert.equal(S.att.attention.data.total, 6, 'the page shows the new answer');
    assert.equal(G.app.state.attention.g1.data.total, 6, 'and the Home badge reads it');
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    assert(out.includes('role="status" aria-live="polite"><div class="gs-hd-toast">') && out.includes('Hidden for everyone') && out.includes('No loot imported for Sat Oct 10'));
    assert(out.includes('data-action="home-undo"') && out.includes('aria-label="Close message"'));
    assert(!desk(out).includes('Earlier raids'), 'gone from the Guild box');
    s.restore();
    s = stub((m, url) => (m === 'get' ? ATTN() : { ok: true }));
    await G.handlers.click['home-undo'](el({}));
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/attention/dismissals/no_loot%3Ar_old'], ['get', '/api/guild/g1/attention']], 'the id is URL-encoded');
    assert.equal(S.att.attention.toast, null, 'the toast is gone');
    assert.equal(S.att.attention.data.total, 7);
    s.restore();
    // the toast closes without undoing
    S.att.attention.toast = { itemId: 'x', title: 'x' };
    G.handlers.click['home-toast-close'](el({}));
    assert.equal(S.att.attention.toast, null);
  }));

  await check('Hidden -> Restore -> DELETE /dismissals/:id and the list is read again; a failure is an error panel with Try again and keeps what loaded', withState(async () => {
    S.att.attention = { gid: 'g1', data: ATTN(), refreshing: false, error: '', hiddenOpen: true };
    let s = stub((m) => (m === 'get' ? ATTN({ hidden: [HIDDEN[1]] }) : { ok: true }));
    await G.handlers.click['home-restore'](el({ 'data-item': 'no_loot:r_h' }));
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/attention/dismissals/no_loot%3Ar_h'], ['get', '/api/guild/g1/attention']]);
    assert.equal(S.att.attention.data.hidden.length, 1);
    s.restore();
    s = stub(() => { throw ApiErr(500, 'error'); });
    await G.handlers.click['home-restore'](el({ 'data-item': 'webhook_off:t2' }));
    assert.equal(S.att.attention.error, 'Server says so.');
    assert.equal(S.att.attention.busyItem, null);
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    assert(out.includes('role="alert"') && out.includes('Could not restore that to-do') && out.includes('Server says so.') && out.includes('<span>Try again</span>'));
    assert(out.includes('Orlek') && out.includes('Wed Oct 21'), 'what loaded stays');
    s.restore();
    // a rejected hide: the same panel
    S.att.attention.error = '';
    s = stub(() => { throw ApiErr(400, 'not_dismissable'); });
    await G.handlers.click['home-hide'](el({ 'data-item': 'claims' }));
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('Could not hide that to-do'));
    s.restore();
  }));

  await check('selection and toggles: home-select picks a raid or a day, home-hidden-toggle and home-seeall flip', withState(async () => {
    S.att.attention = { gid: 'g1', data: ATTN(), refreshing: false, error: '' };
    G.handlers.click['home-select'](el({ 'data-raid': 'r_sun' }));
    assert.equal(S.att.attention.sel, 'r_sun');
    assert(desk(G.pages.attention.main({}, S.guilds.g1, {})).includes('Sun Oct 25, 8:00 PM ET'));
    G.handlers.click['home-select'](el({ 'data-day': '2026-10-23' }));
    assert.equal(S.att.attention.sel, 'day:2026-10-23');
    G.handlers.click['home-hidden-toggle'](el({ 'data-key': 'home-hidden-d' }));
    assert.equal(S.att.attention.hiddenOpen, true);
    G.handlers.click['home-seeall'](el({}));
    assert.equal(S.att.attention.seeAll, true);
  }));

  // ═══ 5. The Briefing (phone) ═══
  await check('Briefing: Next raid card (tile, chip, "Next raid", heading, sentence, full-width Open raid), TO DO, COMING UP, MORE - in that order', () => {
    const p = phone(html(ATTN()));
    const at = s => p.indexOf(s);
    const order = ['aria-label="Next raid"', '>Next raid</span>', 'Wed Oct 21, 8:00 PM ET', '22 of 25 signed.', 'Open raid', 'aria-label="To do"', 'aria-label="Coming up"', 'aria-label="More"'];
    let last = -1;
    for (const s of order) { const i = at(s); assert(i > last, s); last = i; }
    assert(p.includes('class="gs-hd-cta is-block"'), 'full-width');
    assert(p.slice(0, at('aria-label="To do"')).includes('is-gruul is-big') && p.slice(0, at('aria-label="To do"')).includes('is-short'), 'tiles and the chip on the card');
    assertNoRawAttrs(p);
  });

  await check('Briefing: TO DO shows the top 3 (the next raid\'s first), "See all N" and Hidden (N); See all shows the rest', () => {
    const items = ITEMS.concat([todo('signup_unmatched', { id: 'signup_unmatched:r_wed', raidId: 'r_wed', date: '2026-10-21', count: 1, link: { name: 'raid', rid: 'r_wed' } })]);
    const p = phone(html(ATTN({ items, total: 8 })));
    const list = p.slice(p.indexOf('aria-label="To do"'), p.indexOf('aria-label="Coming up"'));
    assert.equal(count(list, /class="gs-hd-todo"/g), 3);
    assert(list.indexOf('1 sign-up on Wed Oct 21') > 0 && list.indexOf('1 sign-up on Wed Oct 21') < list.indexOf('Review Tue Oct 20'), 'the next raid\'s to-do leads');
    assert(list.includes('<span>See all 8</span>') && list.includes('data-action="home-seeall"') && list.includes('>Hidden (2)</button>'));
    const all = phone(html(ATTN({ items, total: 8 }), { seeAll: true }));
    const long = all.slice(all.indexOf('aria-label="To do"'), all.indexOf('aria-label="Coming up"'));
    assert.equal(count(long, /class="gs-hd-todo"/g), 8);
    assert(long.includes('<span>Show fewer</span>'));
  });

  await check('Briefing: COMING UP is the next 2 raids after the headline one; MORE lists the same links, plus rank suggestions', () => {
    const p = phone(html(ATTN()));
    const coming = p.slice(p.indexOf('aria-label="Coming up"'), p.indexOf('aria-label="More"'));
    assert.equal(count(coming, /class="gs-hd-comingrow"/g), 2);
    assert(coming.includes('Sat Oct 24, 7:00 PM ET') && coming.includes('Sun Oct 25, 8:00 PM ET') && !coming.includes('Wed Oct 21'));
    assert(coming.includes('>+1</span>') && coming.includes('<span class="gs-hd-chip is-open">Open</span>'));
    const more = p.slice(p.indexOf('aria-label="More"'));
    assert(more.includes('Last raid: Tue, Karazhan') && more.includes('1 rank suggestion') && more.includes('Recruiting needs'));
  });

  // ═══ 6. States ═══
  await check('Empty week: "No raid this week" + the primary Add raid, Guild box "Nothing to do.", Hidden (0); the strip still shows seven dashed days', () => {
    const out = html(ATTN({ week: [], items: [], total: 0, hidden: [], counts: {} }));
    const d = desk(out);
    assert.equal(count(d, /class="gs-hd-day is-empty"/g), 7);
    assert(d.includes('<h2 class="gs-hd-h2">No raid this week</h2>') && d.includes('No raid is scheduled from Tue Oct 20 to Mon Oct 26.'));
    assert(d.includes('href="#/g/g1/raids/new"') && d.includes('<span>Add raid</span>') && count(d, /gs-btn-molten/g) === 1);
    assert(d.includes('Nothing to do.') && d.includes('Hidden (0)'));
    assert(phone(out).includes('No raid this week') && phone(out).includes('<span>Add raid</span>'));
  });

  await check('Loading: a skeleton with a polite status until the answer is in; an unrelated guild\'s state does not count', withState(async () => {
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    assert(out.includes('aria-busy="true"') && out.includes('Loading this week') && out.includes('gs-hd-sk'));
    assert.equal(count(out, /gs-btn-molten/g), 0);
    S.att.attention = { gid: 'g9', data: ATTN() };
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('Loading this week'));
    assertNoRawAttrs(out);
  }));

  await check('Error: what failed, a secondary Try again, and the loaded week stays; Try again re-reads', withState(async () => {
    S.att.attention = { gid: 'g1', data: ATTN(), refreshing: false, error: 'The server did not answer.', errorTitle: 'Could not refresh Home' };
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    assert(out.includes('role="alert"') && out.includes('Could not refresh Home') && out.includes('The server did not answer.'));
    assert(/<button type="button" class="gs-btn gs-btn-sm" data-action="attn-refresh" data-key="attn-refresh"><span>Try again<\/span><\/button>/.test(out));
    assert(out.includes('Wed Oct 21, 8:00 PM ET'));
    const s = stub(() => ATTN({ total: 3 }));
    await G.handlers.click['attn-refresh'](el({}));
    assert.equal(S.att.attention.error, '');
    assert.equal(S.att.attention.data.total, 3);
    s.restore();
  }));

  await check('Setup checklist: still the whole list until the first raid, then one line (unchanged); it comes after the Week and the Briefing', () => {
    const steps = done => ({ steps: ['teams', 'roster', 'attendance', 'raid', 'officers', 'loot'].map(id => ({ id, done: done.includes(id) })), done: done.length, total: 6 });
    const whole = html(ATTN({ onboarding: steps(['teams']) }));
    assert(whole.includes('<ol class="gs-onboard-steps">') && whole.indexOf('class="gs-hd-phone"') < whole.indexOf('id="setup"'));
    const line = html(ATTN({ onboarding: steps(['teams', 'roster', 'attendance', 'raid']) }));
    assert(line.includes('class="gs-onboard is-line" id="setup"') && !line.includes('<ol class="gs-onboard-steps">'));
    assert(!html(ATTN()).includes('id="setup"'));
  });

  await check('Rules: plain ASCII copy, no hover-only actions (every action is a real button or link), a 44 px phone target for every Home control, the glossary words', () => {
    const src = read('js/guild/pages-attention.js').replace(/^\s*\/\/.*$/gm, '');
    assert(!/[^\x00-\x7f]/.test(src), 'ASCII');
    assert(!/mouseenter|mouseover|:hover/.test(src), 'no hover-only action');
    const out = html(ATTN({ onboarding: null }), { hiddenOpen: true });
    for (const word of ['Line-up', 'Can\'t come', 'More', 'Hidden (2)', 'Restore', 'Open raid']) assert(textOf(out).includes(word), word);
    assert(!/Roster set|Lineup|Cant come|Cannot come|Decline/.test(out));
    const css = read('guild.css');
    const phoneCss = css.slice(css.lastIndexOf('@media (max-width:600px)'));
    for (const sel of ['.gs-hd-slb', '.gs-hd-toast-x', 'a.gs-hd-link']) assert(phoneCss.includes(sel), sel + ' in the phone block');
    assert(/\.gs-home :is\(\.gs-hd-phone, \.gs-hd-toastwrap\) \.gs-btn \{ min-height: 44px/.test(phoneCss), 'buttons are 44 px on a phone');
    const sizes = [...css.slice(css.indexOf('Officer Home, round 4')).matchAll(/font(?:-size)?:[^;{}]*?\b(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
    assert(Math.min(...sizes) >= 12, '12 px floor');
  });

  await check('Times: always the guild\'s zone (a Chicago guild reads CT)', () => {
    const out = html(ATTN(), {}, gd({ guild: { timeZone: 'America/Chicago' } }));
    assert(desk(out).includes('Tue Oct 21, 7:00 PM CT') || desk(out).includes('Wed Oct 21, 7:00 PM CT'), 'the heading moves with the guild zone');
    assert(!desk(out).includes('8:00 PM ET'));
  });

  // ═══ 7. Attendance: the Watch list card ═══
  const WATCH = (entries) => ({ below: 0.75, dropBy: 0.15, window: 8, entries });
  const ENTRY = (over) => Object.assign({ playerId: 'p_t', itemId: 'watch:t1:p_t', name: 'Thoren', class: 'PALADIN', status: 'raider', pct: 62, previousPct: 82, drop: 20, missed: 3, missedNotice: 1, counted: 8, reasons: ['below', 'drop'], reviewed: null }, over || {});
  await check('Attendance Watch list: a Reviewed secondary button per open entry; a reviewed entry stays listed (muted) with "Reviewed by X, date. Comes back if attendance drops 5 more points or a raid is missed." and an Undo', () => {
    const A = G.pages.attendance;
    const out = A.watchHtml('g1', WATCH([ENTRY(), ENTRY({ playerId: 'p_k', itemId: 'watch:t1:p_k', name: 'Kaelith', reviewed: { by: { name: 'Morwen' }, at: Date.UTC(2026, 9, 16, 16, 0) } })]));
    assert.equal(count(out, /gs-watch-item/g), 2, 'both stay listed');
    assert(out.includes('<button type="button" class="gs-btn gs-btn-sm" aria-label="Mark Reviewed for Thoren" data-action="att-watch-review" data-item="watch:t1:p_t" data-key="att-watch-watch:t1:p_t"><span>Reviewed</span></button>'));
    assert(out.includes('class="gs-watch-item is-reviewed"') && out.includes('Reviewed by Morwen, Oct 16. Comes back if attendance drops 5 more points or a raid is missed.'));
    assert(out.includes('aria-label="Undo Reviewed for Kaelith" data-action="att-watch-undo" data-item="watch:t1:p_k"') && out.includes('<span>Undo</span>'));
    assert(!out.includes('att-watch-review" data-item="watch:t1:p_k"'), 'a reviewed entry has no second Reviewed');
    assert(!A.watchHtml('g1', WATCH([ENTRY({ itemId: undefined })])).includes('att-watch-review'), 'no item id, no button');
    assertNoRawAttrs(out);
  });

  await check('Attendance Watch list: Reviewed -> POST /attention/dismissals { itemId }, Undo -> DELETE, then the page is read again and the Home badge too', withState(async () => {
    let routed = 0; let badge = 0;
    G.app.routeAll = () => { routed++; return Promise.resolve(); };
    G.app.ensureAttention = () => { badge++; return Promise.resolve(); };
    let s = stub(() => ({ ok: true }));
    await G.handlers.click['att-watch-review'](el({ 'data-item': 'watch:t1:p_t' }));
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/attention/dismissals', { itemId: 'watch:t1:p_t' }]]);
    s.restore();
    s = stub(() => ({ ok: true }));
    await G.handlers.click['att-watch-undo'](el({ 'data-item': 'watch:t1:p_t' }));
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/attention/dismissals/watch%3At1%3Ap_t']]);
    assert.equal(routed, 2); assert.equal(badge, 2);
    s.restore();
    let handled = 0;
    G.app.handleError = () => { handled++; };
    s = stub(() => { throw ApiErr(500, 'error'); });
    await G.handlers.click['att-watch-review'](el({ 'data-item': 'watch:t1:p_t' }));
    assert.equal(handled, 1); assert.equal(routed, 2, 'a failure does not reload');
    s.restore();
  }));

  await check('Attendance Watch list: the page\'s "N on the watch list" counts the open entries only', () => {
    const A = G.pages.attendance;
    assert.equal(A.watchCountText(WATCH([ENTRY(), ENTRY({ itemId: 'watch:t1:p_k', reviewed: { by: { name: 'M' }, at: 1 } })])), '1 on the watch list');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
