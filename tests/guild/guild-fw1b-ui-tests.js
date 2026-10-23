/**
 * Raidsmith guild UI - design framework Wave 1 (items 3 and 4): Home on the T4 template (the officer variant: Needs attention first, the setup checklist folding to
 * one line once the guild has a raid, the invite message; the member variant: next raid with the viewer's own line-up seat, attendance, loot, away notices and the
 * calendar), the member landing choice, "My profile", and the Planner's landing for guild members (upcoming raids to plan, filtered by what the viewer may edit).
 * Run: node tests/guild/guild-fw1b-ui-tests.js
 *
 * Same approach as guild-guilds-ui-tests.js: the guild scripts load in a vm with no DOM, the pages return HTML strings and the handlers run against a stubbed
 * G.api. guild-fw1b-worker-tests.js pins the Worker side (me.personId); guild-shell-tests.js runs the member Home through the real router.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('../guild-scripts');

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

const ROOT = require('path').join(__dirname, '..', '..');
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
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null }, extra || {});

// A stub of G.api: handler(method, url, body) -> value | Promise. Every call is recorded.
function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => {
    o[m] = (url, body) => {
      calls.push({ m, url, body: body && plain(body) });
      try { return Promise.resolve(handler(m, url, body)); } catch (error) { return Promise.reject(error); } // a handler that throws is a request that fails
    };
    return o;
  }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const ApiErr = (status, code) => new ctx.Guild.api.ApiError(status, { error: code, message: 'Server says so.' });

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
}

// ── fixtures ─────────────────────────────────────────────────────
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'guild.access': 'guild' };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'loot.view': ['t1'], 'signups.self': ['t1'] };
const TEAM = (id, name, archived) => ({ id, name, size: 25, archived: !!archived, players: 3, leads: [] });
function gd(can, over) {
  const o = over || {};
  return {
    guild: Object.assign({ id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'firemaw', createdAt: 1 }, o.guild || {}),
    teams: o.teams || [TEAM('t1', 'Main team')],
    me: { roles: [{ role: can === MEMBER_CAN ? 'member' : 'officer' }], can, personId: o.personId === undefined ? null : o.personId },
    attendanceFlags: {}, rosterFlags: {},
  };
}
const STEP_IDS = ['teams', 'roster', 'attendance', 'raid', 'officers', 'loot'];
const onboarding = done => ({ steps: STEP_IDS.map(id => ({ id, done: done.includes(id) })), done: done.length, total: 6 });
const item = (kind, over) => Object.assign({ id: kind + ':1', kind, severity: 'action', teamId: 't1', teamName: 'Main team', link: { name: 'raid', rid: 'r_1' } }, over || {});
const ATTN = (items, over) => Object.assign({ today: '2026-10-18', total: items.length, items, more: {}, onboarding: null }, over || {});
const attnHtml = (data, extra, g) => G.pages.attention.attentionHtml(Object.assign({ guildData: g || gd(OFFICER_CAN), data }, extra || {}));
const LOW = item('low_signups', { raidId: 'r_1', date: '2026-10-23', zone: 'Serpentshrine Cavern', expected: 9, size: 25 });

function withState(fn) {
  return async () => {
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, attention: S.attention, teamByGuild: S.teamByGuild, me: S.me };
    const savedApp = { requireSignin: G.app.requireSignin, showFailure: G.app.showFailure, render: G.app.render, handleError: G.app.handleError };
    const savedUi = { openDialog: G.ui.openDialog, announce: G.ui.announce, focusByKey: G.ui.focusByKey, runDialog: G.ui.runDialog };
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.attention = {}; S.teamByGuild = { g1: 't1' }; S.currentGid = 'g1';
    S.me = { user: { id: 'u1', displayName: 'Brewmaw', username: 'brew' }, guilds: [{ id: 'g1', name: 'Ravens' }] };
    Object.keys(els).forEach(k => delete els[k]);
    delete ctx.copyText;
    try { await fn(S); } finally { Object.assign(S, saved); Object.assign(G.app, savedApp); Object.assign(G.ui, savedUi); delete ctx.copyText; }
  };
}

(async () => {
  // ═══ 1. Officer Home ═══
  await check('officer Home: the Week and the Briefing first, then the setup checklist; readiness facts are not to-dos', () => {
    const info = item('unlocked', { severity: 'info', raidId: 'r_1', date: '2026-10-21', minutes: 45, readiness: true });
    const out = attnHtml(ATTN([Object.assign({}, LOW, { readiness: true }), info], { total: 0, onboarding: onboarding(['teams']) }));
    assert(out.indexOf('class="gs-hd-desk"') > 0 && out.indexOf('class="gs-hd-desk"') < out.indexOf('class="gs-hd-phone"') && out.indexOf('class="gs-hd-phone"') < out.indexOf('id="setup"'));
    assert(!out.includes('9 of 25 signed up') && !out.includes('Sign-ups for'), 'the facts feed the raid sentence, they are no rows');
    assertNoRawAttrs(out);
  });

  await check('officer Home: with nothing to do there is one primary (Add raid) per variant and the checklist comes after the Week', () => {
    const out = attnHtml(ATTN([], { onboarding: onboarding(['teams']) }));
    assert(out.includes('Nothing to do.') && out.includes('No raid this week'));
    assert(out.indexOf('No raid this week') < out.indexOf('id="setup"') && out.includes('Set up your guild'));
    assert.equal(count(out, /gs-btn-molten/g), 2, 'one primary in the Week, one in the Briefing (guild.css shows one of them)');
  });

  await check('setup checklist: the whole list until the guild has a raid, one line after ("Setup 4 of 6 steps done. Next: ..."); All steps / Hide steps fold it', () => {
    const noRaid = attnHtml(ATTN([], { onboarding: onboarding(['teams', 'roster']) }));
    assert(noRaid.includes('class="gs-onboard" id="setup"') && !noRaid.includes('is-line') && !noRaid.includes('data-action="setup-toggle"'));
    const withRaid = attnHtml(ATTN([], { onboarding: onboarding(['teams', 'roster', 'attendance', 'raid']) }));
    assert(withRaid.includes('class="gs-onboard is-line" id="setup"'), 'one line once the guild has a raid');
    const text = stripTags(withRaid);
    assert(text.includes('Setup') && text.includes('4 of 6 steps done. Next: invite your officers .'), text);
    assert(withRaid.includes('<a class="gs-onboard-link" href="#/g/g1/settings/people">invite your officers</a>'), 'the next step is the link');
    assert(withRaid.includes('data-action="copy-invite" data-key="copy-invite-line"') && withRaid.includes('<span>All steps</span>'));
    assert(!withRaid.includes('<ol class="gs-onboard-steps">'), 'the steps are folded');
    // The officer's own choice wins: All steps opens the list (with Hide steps), Hide steps folds it again; before a raid there is no Hide.
    const opened = attnHtml(ATTN([], { onboarding: onboarding(['teams', 'roster', 'attendance', 'raid']) }), { setupOpen: true });
    assert(opened.includes('<ol class="gs-onboard-steps">') && opened.includes('<span>Hide steps</span>') && opened.includes('data-action="onboarding-dismiss"'));
    const foldedEarly = attnHtml(ATTN([], { onboarding: onboarding(['teams']) }), { setupOpen: false });
    assert(foldedEarly.includes('is-line') && stripTags(foldedEarly).includes('1 of 6 steps done. Next: import your roster .'));
    assert(!foldedEarly.includes('data-action="copy-invite"'), 'the invite button belongs to step 5');
    assert(attnHtml(ATTN([], { onboarding: onboarding(['teams', 'roster', 'attendance', 'raid', 'officers', 'loot']) })).includes('is-line') === false, 'nothing left: the Worker sends no card, and none is drawn from a full set');
  });

  await check('setup checklist: step 1 ticks when the Worker says so; step 5 carries the Copy invite message button (only while open)', () => {
    const out = attnHtml(ATTN([], { onboarding: onboarding(['teams']) }));
    assert(/gs-onboard-step is-done"><span class="gs-onboard-mark" aria-hidden="true"><svg[^]*?<\/svg><\/span><a class="gs-onboard-link" href="#\/g\/g1\/settings\/teams">Set up your teams<span class="gs-sr"> \(done\)/.test(out));
    const step5 = out.slice(out.indexOf('Invite your officers'), out.indexOf('Import loot'));
    assert(step5.includes('data-action="copy-invite" data-key="copy-invite-step"') && step5.includes('Copy invite message'));
    assert.equal(count(out, /data-action="copy-invite"/g), 1);
    const done5 = attnHtml(ATTN([], { onboarding: onboarding(['officers']) }));
    assert(!done5.slice(done5.indexOf('Invite your officers'), done5.indexOf('Import loot')).includes('copy-invite'), 'a finished step has no invite button');
  });

  await check('setup toggle: flips the choice, redraws and keeps the keyboard on the button; nothing without a checklist', withState(async () => {
    S.guilds.g1 = gd(OFFICER_CAN);
    S.att.attention = { gid: 'g1', data: ATTN([], { onboarding: onboarding(['teams', 'roster', 'attendance', 'raid']) }), refreshing: false, error: '' };
    let renders = 0; const focused = [];
    G.app.render = () => { renders++; };
    G.ui.focusByKey = (key) => { focused.push(key); return true; };
    G.handlers.click['setup-toggle'](el({}));
    assert.equal(S.att.attention.setupOpen, true, 'folded by default -> open');
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('<ol class="gs-onboard-steps">'));
    G.handlers.click['setup-toggle'](el({}));
    assert.equal(S.att.attention.setupOpen, false);
    assert.equal(renders, 2);
    assert.deepEqual(focused, ['setup-toggle', 'setup-toggle']);
    S.att.attention.data.onboarding = null;
    G.handlers.click['setup-toggle'](el({}));
    assert.equal(renders, 2, 'no checklist, nothing to fold');
  }));

  await check('invite message: the guild, the site address and "sign in with Discord"; Copy invite message copies it through copyText and says so; Accounts has the button too', withState(async () => {
    const msg = G.pages.attention.inviteMessage('Ravens', 'https://raidsmith.test/');
    assert(msg.includes('Ravens') && msg.includes('https://raidsmith.test/') && msg.includes('sign in with Discord'), msg);
    assert(!/[^\x00-\x7f]/.test(msg), 'ASCII');
    assert(G.pages.attention.inviteMessage('', '').includes('sign in with Discord') && G.pages.attention.inviteMessage('', '').startsWith('Our guild'), 'no name or address: still sendable');
    S.guilds.g1 = gd(OFFICER_CAN);
    const said = []; const copied = [];
    G.ui.announce = (id, text) => said.push([id, text]);
    ctx.copyText = (text, ok) => { copied.push([text, ok]); return Promise.resolve(true); };
    await G.handlers.click['copy-invite'](el({}));
    assert.deepEqual(copied, [['Ravens is on Raidsmith. Open https://raidsmith.test/ and sign in with Discord to see the raids, confirm your spot, and check your attendance and loot.', 'Invite message copied']]);
    assert.deepEqual(said, [['invite-status', 'Invite message copied.']]);
    ctx.copyText = () => Promise.resolve(false);
    await G.handlers.click['copy-invite'](el({}));
    assert(said[1][1].includes('would not copy it'), 'a refused clipboard is said');
    delete ctx.copyText;
    await G.handlers.click['copy-invite'](el({}));
    assert(said[2][1].includes('not available'), 'no copy helper: said, nothing thrown');
    // Settings > Accounts
    const people = G.pages.people.peopleHtml({ guildData: S.guilds.g1, data: { people: [], removed: [], signedInCount: 0 }, sort: null, query: '' });
    assert(people.includes('data-action="copy-invite" data-key="copy-invite-accounts"') && people.includes('Copy invite message') && people.includes('id="invite-status" role="status"'));
    assertNoRawAttrs(people);
    assertEscaped(attnHtml(ATTN([], { onboarding: onboarding([]) }), {}, gd(OFFICER_CAN, { guild: { name: HOSTILE + QUOTES } })), 'invite card');
  }));

  // ═══ 2. The landing choice and the member Home ═══
  const RAID = (over) => Object.assign({
    id: 'r_next', raidOn: '2026-10-21', startsAt: Date.UTC(2026, 9, 22, 1, 0), timeKnown: true, upcoming: true, zone: 'Gruul\'s Lair', size: 25, title: null,
    signups: { signed: 17, late: 0, standby: 0, bench: 1, tentative: 0, absence: 0 }, signupsOpen: true, closesAt: Date.UTC(2026, 9, 22, 1, 0), closeHours: 0, mine: null, planned: true,
  }, over || {});
  const RAIDS = (upcoming, can) => ({ team: { id: 't1', name: 'Main team' }, today: '2026-10-18', can: Object.assign({ edit: false, signup: true }, can || {}), upcoming, raids: [], hasMore: false });
  const SEAT = (status) => ({ published: true, publishedAt: Date.UTC(2026, 9, 19, 23, 12), mine: { group: 2, name: 'Brewmaw', class: 'SHAMAN', spec: 'Enhancement', status } });
  const cell = (date, outcome, letter) => ({ raid: { id: 'r_' + date, raidOn: date, zone: 'Karazhan' }, outcome, letter, credit: 1, pending: false, preStart: false, via: null, reason: null });
  const CELLS = [['2026-10-14', 'present', 'P'], ['2026-10-11', 'present', 'P'], ['2026-10-09', 'missed', 'A'], ['2026-10-07', 'present', 'P'], ['2026-10-04', 'late', 'L'],
    ['2026-10-02', 'present', 'P'], ['2026-09-30', 'present', 'P'], ['2026-09-25', 'present', 'P'], ['2026-09-23', 'present', 'P'], ['2026-09-18', 'present', 'P']].map(c => cell(...c));
  const ATT = { person: { id: 'p_me', name: 'Brewmaw' }, teams: [{ team: { id: 't1', name: 'Main team' }, window: 8, metrics: { pct: 92.5 }, cells: CELLS }] };
  const LOOT = { person: { id: 'p_me', name: 'Brewmaw' }, awards: [
    { id: 'a1', itemId: 28830, itemName: 'Dragonspine Trophy', quality: 4, raidOn: '2026-10-14' }, { id: 'a2', itemId: 28789, itemName: 'Eye of Magtheridon', quality: 4, raidOn: '2026-10-07' },
    { id: 'a3', itemId: 28770, itemName: null, quality: 4, raidOn: '2026-09-30' }, { id: 'a4', itemId: 1, itemName: 'Too old', quality: 3, raidOn: '2026-09-01' }], totals: {} };
  const AWAY = { today: '2026-10-18', personId: 'p_me', notices: [{ id: 'n1', kind: 'away', from: '2026-10-30', to: '2026-11-01', weekday: null, atTime: null }, { id: 'n0', kind: 'away', from: '2026-09-01', to: '2026-09-03', weekday: null, atTime: null }], max: 30 };
  const memberApi = (over) => (m, url) => {
    const o = over || {};
    if (url === '/api/guild/g1/raids?team=t1') return o.raids || RAIDS([RAID()]);
    if (url === '/api/guild/g1/raids/r_next/roster') return o.seat || SEAT('pending');
    if (url === '/api/guild/g1/attendance/person/p_me') { if (o.attendance) return o.attendance(); return ATT; }
    if (url === '/api/guild/g1/loot/person/p_me') return o.loot ? o.loot() : LOOT;
    if (url === '/api/guild/g1/away/mine') return o.away ? o.away() : AWAY;
    throw new Error('unexpected ' + m + ' ' + url);
  };
  const seatRaid = (status) => RAIDS([RAID({ mine: { kind: 'signed', source: 'raidsmith', characterName: 'Brewmaw', roster: { group: 2, status } } })]);
  const memberGd = () => gd(MEMBER_CAN, { personId: 'p_me' });
  const loadMember = async (api) => { const s = stub(api); S.guilds.g1 = memberGd(); await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, S.guilds.g1); s.restore(); return s; };

  await check('landing choice: attention viewers get the officer list (GET /attention), everyone else the member Home (their own reads, never /attention)', withState(async () => {
    let s = stub((m, url) => { if (url.endsWith('/attention')) return ATTN([LOW]); throw new Error('unexpected ' + url); });
    S.guilds.g1 = gd(OFFICER_CAN);
    await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, S.guilds.g1);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/attention']);
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('This week'));
    s.restore();
    s = await loadMember(memberApi({ raids: seatRaid('pending') }));
    assert(!s.calls.some(c => c.url.endsWith('/attention')), 'a member never asks for the list');
    assert.deepEqual(s.calls.map(c => c.url).sort(), ['/api/guild/g1/attendance/person/p_me', '/api/guild/g1/away/mine', '/api/guild/g1/loot/person/p_me', '/api/guild/g1/raids/r_next/roster', '/api/guild/g1/raids?team=t1']);
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    assert(out.includes('Welcome back, Brewmaw - Ravens') && out.includes('id="home-next"') && !out.includes('Needs attention'));
    assert(out.startsWith('<div class="gs-page gs-home-page gs-home-member">') && out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Home</h1>'));
    S.att.homeMember = null;
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('Loading'), 'until the reads are in');
    // A team lead (team-list item action) is an attention viewer too.
    assert(G.shell.canSeeAttention({ 'raids.edit': ['t1'] }) && !G.shell.canSeeAttention(MEMBER_CAN));
  }));

  await check('member Home: a seat waiting on the viewer reads "You\'re in Group 2 as Enhancement Shaman (Brewmaw)" with Confirm as the one primary and Can\'t come beside it', withState(async () => {
    await loadMember(memberApi({ raids: seatRaid('pending') }));
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    const next = out.slice(out.indexOf('id="home-next"'), out.indexOf('class="gs-mgrid"'));
    assert(next.includes('Next raid<span class="gs-mnext-rel"> - in 3 days</span>'), 'relative to the guild date');
    assert(next.includes('>Wed Oct 21, 8:00 PM CT</a>'), 'the date and time in the guild zone, with the zone');
    assert(stripTags(next).includes('Gruul\'s Lair'));
    assert(stripTags(next).includes('You\'re in Group 2 as Enhancement Shaman (Brewmaw).') && stripTags(next).includes('Waiting for you'));
    assert(/<button type="button" class="gs-btn gs-btn-molten" disabled? ?data-action="home-confirm"|<button type="button" class="gs-btn gs-btn-molten" data-action="home-confirm"/.test(next));
    assert(next.includes('data-action="home-decline"') && count(next, /gs-btn-molten/g) === 1, 'one primary');
    assert(next.includes('data-rid="r_next"'));
    assert(next.includes('Line-up published Mon Oct 19, 6:12 PM CT.'));
    assert.equal(count(out, /gs-btn-molten/g), 1, 'one primary on the whole page');
    assertNoRawAttrs(out);
  }));

  await check('member Home: confirmed is a quiet line with Can\'t come; declined offers Confirm after all; no seat shows the sign-up, or Sign up while the window is open', withState(async () => {
    const html = async (api) => { await loadMember(api); return G.pages.attention.main({}, S.guilds.g1, {}); };
    let out = await html(memberApi({ raids: seatRaid('confirmed'), seat: SEAT('confirmed') }));
    assert(out.includes('Confirmed') && out.includes('You told the officers you\'re coming.') && !out.includes('data-action="home-confirm"') && out.includes('data-action="home-decline"'));
    assert.equal(count(out, /gs-btn-molten/g), 0, 'nothing left to press first');
    out = await html(memberApi({ raids: seatRaid('declined'), seat: SEAT('declined') }));
    assert(out.includes('You told the officers you can\'t come.') && out.includes('Confirm after all') && !out.includes('data-action="home-decline"'));
    out = await html(memberApi({ raids: RAIDS([RAID({ mine: { kind: 'tentative', source: 'raidsmith', characterName: 'Brewmaw' } })]) }));
    assert(out.includes('You\'re signed up.') && out.includes('Tentative') && out.includes('href="#/g/g1/raids"') && !out.includes('data-action="home-signup"'));
    out = await html(memberApi({ raids: RAIDS([RAID()]) }));
    assert(out.includes('You\'re not signed up yet.') && out.includes('data-action="home-signup"') && out.includes('gs-btn-molten'));
    out = await html(memberApi({ raids: RAIDS([RAID({ signupsOpen: false })]) }));
    assert(out.includes('Sign-ups are closed.') && !out.includes('home-signup'));
    out = await html(memberApi({ raids: RAIDS([RAID()], { signup: false }) }));
    assert(out.includes('Sign-ups are for the people on the roster.'));
    out = await html(memberApi({ raids: RAIDS([]) }));
    assert(out.includes('No upcoming raid is scheduled for your team.') && !out.includes('gs-btn-molten'));
  }));

  await check('member Home: my attendance (rolling-window percentage, the last 8 raids with a letter in every cell, who can see it), my last 3 loot awards, away notices and the calendar link', withState(async () => {
    await loadMember(memberApi({ raids: seatRaid('pending') }));
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    const att = out.slice(out.indexOf('id="home-attendance"'), out.indexOf('id="home-loot"'));
    assert(stripTags(att).includes('93% 8-week attendance') || stripTags(att).includes('92% 8-week attendance') || stripTags(att).includes('92.5% 8-week attendance'), stripTags(att));
    assert.equal(count(att, /class="gs-cell /g), 8, 'the last 8 raids');
    assert(!att.includes('Sep 18') && att.includes('Oct 14'), 'newest 8, oldest of those first');
    assert(att.indexOf('Sep 23') < att.indexOf('Oct 14'), 'oldest to newest, left to right');
    assert(/role="img" aria-label="Wed Oct 14: [^"]*" title="[^"]*">P<\/span>/.test(att), 'a letter in every cell, named for a screen reader');
    assert(stripTags(att).includes('6 on time, 1 late, 1 absent in the last 8 raids.'), stripTags(att));
    assert(stripTags(att).includes('Attendance is visible to the members of your team.'));
    assert(att.includes('href="#/g/g1/attendance/p/p_me">See my record</a>'));
    const loot = out.slice(out.indexOf('id="home-loot"'), out.indexOf('id="home-away"'));
    assert.equal(count(loot, /<li>/g), 3, 'the last three awards');
    assert(loot.includes('>Dragonspine Trophy</a>') && loot.includes('Item 28770') && !loot.includes('Too old'));
    assert(loot.indexOf('Dragonspine') < loot.indexOf('Eye of Magtheridon'), 'newest first');
    assert(loot.includes('href="#/g/g1/loot/p/p_me">See my loot</a>'));
    const away = out.slice(out.indexOf('id="home-away"'));
    assert(stripTags(away).includes('Away Oct 30 - Nov 1') && !stripTags(away).includes('Sep 1'), 'current notices only: ' + stripTags(away));
    assert(away.includes('href="#/g/g1/away"') && away.includes('Add away notice'));
    assert(away.includes('data-action="home-cal"') && away.includes('Subscribe in your calendar'));
    assertNoRawAttrs(out);
  }));

  await check('member Home: a card whose read is refused or fails says so and the rest still draws; an account on no roster is told how to get on it', withState(async () => {
    await loadMember(memberApi({ raids: seatRaid('pending'), attendance: () => { throw ApiErr(403, 'forbidden'); }, loot: () => { throw ApiErr(500, 'error'); } }));
    let out = G.pages.attention.main({}, S.guilds.g1, {});
    assert(out.includes('Your attendance is not shared with you in this guild.') && out.includes('Server says so.') && out.includes('home-next'));
    // Not on a roster: no person id, so no per-person reads at all.
    const s = stub(memberApi({ raids: RAIDS([RAID()], { signup: false }) }));
    S.guilds.g1 = gd(MEMBER_CAN, { personId: null });
    await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, S.guilds.g1);
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/raids?team=t1']);
    out = G.pages.attention.main({}, S.guilds.g1, {});
    assert(out.includes('once an officer links your account to a roster person.') && out.includes('Away notices are for the people on the roster.') && !out.includes('Add away notice'));
    // A lost session in a card is the sign-in page, not a card message.
    const lost = stub(memberApi({ attendance: () => { throw ApiErr(401, 'signed_out'); } }));
    S.guilds.g1 = memberGd();
    await assert.rejects(() => G.pages.attention.load({}, S.guilds.g1), e => e.status === 401);
    lost.restore();
    // The raids read failing is the page's failure.
    const failing = stub((m, url) => { if (url.includes('/raids?')) throw ApiErr(500, 'error'); return {}; });
    await assert.rejects(() => G.pages.attention.load({}, S.guilds.g1), e => e.status === 500);
    failing.restore();
  }));

  await check('member Home loot: one head per raid night with the true night total; rows stay the newest 3; no raidId gives a span title', withState(async () => {
    const lootOf = (awards) => () => ({ person: { id: 'p_me', name: 'Brewmaw' }, awards, totals: {} });
    const A = (id, extra) => Object.assign({ id, itemId: 100 + Number(id.slice(1)), itemName: 'Item ' + id, quality: 4, raidOn: '2026-10-14' }, extra);
    const loot = async (awards) => { await loadMember(memberApi({ raids: seatRaid('pending'), loot: lootOf(awards) })); const o = G.pages.attention.main({}, S.guilds.g1, {}); return o.slice(o.indexOf('id="home-loot"'), o.indexOf('id="home-away"')); };
    let out = await loot([A('a1', { raidId: 'r1' }), A('a2', { raidId: 'r2', raidOn: '2026-10-07' }), A('a3', { raidId: 'r3', raidOn: '2026-09-30' })]);
    assert.equal(count(out, /<h3 class="gs-fg-gh">/g), 3);
    assert(out.includes('<a class="gs-fg-ght" href="#/g/g1/loot/night/r1">') || /<a class="gs-fg-ght" href="[^"]*r1">/.test(out), 'night link');
    out = await loot([A('a1', { raidId: 'r1' }), A('a2', { raidId: 'r1' })]);
    assert.equal(count(out, /<h3 class="gs-fg-gh">/g), 1);
    assert(out.includes('<span class="gs-fg-ghn">2 items</span>') && count(out, /<li>/g) === 2);
    out = await loot([A('a1', { raidId: 'r1' }), A('a2', { raidId: 'r2', raidOn: '2026-10-07' }), A('a3', { raidId: 'r3', raidOn: '2026-09-30' }), A('a4', { raidId: 'r3', raidOn: '2026-09-30' })]);
    assert.equal(count(out, /<li>/g), 3, 'only the newest 3 rows');
    assert(out.includes('<span class="gs-fg-ghn">2 items</span>') && count(out, /<span class="gs-fg-ghn">1 item<\/span>/g) === 2, 'the 4th counts toward the head');
    out = await loot([A('a1')]);
    assert(/<h3 class="gs-fg-gh"><span class="gs-fg-ght">[^<]+<\/span><span class="gs-fg-ghn">1 item<\/span><\/h3>/.test(out), 'no raidId: span title');
    const css = fs.readFileSync(path.join(ROOT, 'guild.css'), 'utf8');
    assert(/\.gs-mloot-nights \{/.test(css) && /\.gs-mloot-night \{/.test(css) && /\.gs-mloot-night \.gs-mlist > li \{/.test(css));
  }));

  await check('member Home: hostile names, titles and items are escaped everywhere', withState(async () => {
    await loadMember(memberApi({
      raids: RAIDS([RAID({ title: HOSTILE + QUOTES, zone: HOSTILE, mine: { kind: 'signed', source: 'raidsmith', characterName: HOSTILE + QUOTES } })]),
      loot: () => ({ person: { id: 'p_me', name: HOSTILE }, awards: [{ id: 'a1', itemId: 1, itemName: HOSTILE + QUOTES, quality: 4, raidOn: HOSTILE }] }),
      away: () => ({ today: HOSTILE, notices: [{ id: 'n1', kind: 'away', from: HOSTILE, to: QUOTES, weekday: null }] }),
    }));
    S.me.user.displayName = HOSTILE + QUOTES;
    const out = G.pages.attention.main({}, S.guilds.g1, {});
    assertEscaped(out, 'member Home');
    assertNoRawAttrs(out);
  }));

  await check('member Home handlers: Confirm and Sign up call the Worker then read the card again; Can\'t come asks first (data-from home) and answers through the same dialog', withState(async () => {
    await loadMember(memberApi({ raids: seatRaid('pending') }));
    let renders = 0; const spoken = [];
    G.app.render = () => { renders++; };
    G.ui.announce = (id, text) => spoken.push([id, text]);
    let confirmed = false;
    const s = stub((m, url) => {
      if (m === 'post' && url === '/api/guild/g1/raids/r_next/roster/confirm') { confirmed = true; return {}; }
      if (url === '/api/guild/g1/raids?team=t1') return seatRaid(confirmed ? 'confirmed' : 'pending');
      if (url === '/api/guild/g1/raids/r_next/roster') return SEAT(confirmed ? 'confirmed' : 'pending');
      throw new Error('unexpected ' + m + ' ' + url);
    });
    await G.handlers.click['home-confirm'](el({ 'data-rid': 'r_next' }));
    assert.deepEqual(s.calls.map(c => c.m + ' ' + c.url).slice(0, 2), ['post /api/guild/g1/raids/r_next/roster/confirm', 'get /api/guild/g1/raids?team=t1']);
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('You told the officers you\'re coming.'));
    assert.deepEqual(spoken, [['home-status', 'You confirmed.']]);
    assert.equal(S.att.homeMember.busy, false);
    s.restore();
    // Sign up: the plain one-click sign-up of the Raids list.
    S.att.homeMember.data = RAIDS([RAID()]); S.att.homeMember.seat = null;
    let signedUp = false;
    const t = stub((m, url, body) => {
      if (m === 'put' && url === '/api/guild/g1/raids/r_next/signup') { signedUp = true; return {}; }
      if (url === '/api/guild/g1/raids?team=t1') return RAIDS([RAID(signedUp ? { mine: { kind: 'signed', source: 'raidsmith', characterName: 'Brewmaw' } } : {})]);
      throw new Error('unexpected ' + m + ' ' + url);
    });
    await G.handlers.click['home-signup'](el({ 'data-rid': 'r_next' }));
    assert.deepEqual(t.calls[0], { m: 'put', url: '/api/guild/g1/raids/r_next/signup', body: { kind: 'signed' } });
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('You\'re signed up.'));
    t.restore();
    // Can't come: the dialog first.
    let opened = '';
    G.ui.openDialog = (html) => { opened = html; };
    G.handlers.click['home-decline'](el({ 'data-rid': 'r_next' }));
    assert(opened.includes('data-submit="roster-decline-form" data-from="home" data-rid="r_next"') && opened.includes("Tell the officers you can't come?"), opened);
    // Its submit declines, then reads the card again.
    let declined = false;
    const u = stub((m, url) => {
      if (m === 'post' && url === '/api/guild/g1/raids/r_next/roster/decline') { declined = true; return {}; }
      if (url === '/api/guild/g1/raids?team=t1') return seatRaid(declined ? 'declined' : 'pending');
      if (url === '/api/guild/g1/raids/r_next/roster') return SEAT(declined ? 'declined' : 'pending');
      throw new Error('unexpected ' + m + ' ' + url);
    });
    S.currentGid = 'g1';
    G.ui.runDialog = (form, call, done) => Promise.resolve(call).then(res => done(res));
    const form = { getAttribute: k => ({ 'data-from': 'home', 'data-rid': 'r_next' })[k] };
    await G.handlers.submit['roster-decline-form'](form);
    await settle();
    assert(declined && G.pages.attention.main({}, S.guilds.g1, {}).includes('Confirm after all'));
    assert(spoken.some(x => x[1].includes('can\'t come')));
    u.restore();
    // A failed answer re-reads the card and says why in it (the raid started, the line-up changed).
    const f = stub((m, url) => { if (m === 'post') throw ApiErr(409, 'raid_started'); if (url.includes('/raids?')) return seatRaid('pending'); return SEAT('pending'); });
    await G.handlers.click['home-confirm'](el({ 'data-rid': 'r_next' }));
    assert.equal(S.att.homeMember.error, 'Server says so.');
    assert(G.pages.attention.main({}, S.guilds.g1, {}).includes('id="home-next-error" role="alert">Server says so.'));
    f.restore();
    // While one answer runs a second click does nothing.
    S.att.homeMember.busy = true;
    const g = stub(() => ({}));
    assert.equal(G.handlers.click['home-confirm'](el({ 'data-rid': 'r_next' })), null);
    assert.equal(g.calls.length, 0);
    g.restore();
  }));

  await check('member Home: the calendar link opens the calendar dialog for the selected team', withState(async () => {
    await loadMember(memberApi({ raids: seatRaid('pending') }));
    const opened = [];
    const real = G.pages.calendar.open;
    G.pages.calendar.open = (gid, tid, name) => { opened.push([gid, tid, name]); return null; };
    G.handlers.click['home-cal'](el({}));
    G.pages.calendar.open = real;
    assert.deepEqual(opened, [['g1', 't1', 'Main team']]);
  }));

  await check('member Home: the relative day, and the attendance summary', () => {
    const inText = G.pages.homeMember.inText;
    assert.equal(inText('2026-10-18', '2026-10-18'), 'today');
    assert.equal(inText('2026-10-18', '2026-10-19'), 'tomorrow');
    assert.equal(inText('2026-10-18', '2026-10-21'), 'in 3 days');
    assert.equal(inText('2026-10-18', 'junk'), '');
    assert.equal(G.pages.homeMember.summaryText(CELLS.slice(0, 8)), '6 on time, 1 late, 1 absent in the last 8 raids.');
    assert.equal(G.pages.homeMember.summaryText(CELLS.slice(0, 1)), '1 on time in the last 1 raid.');
    assert.equal(G.pages.homeMember.summaryText([]), '');
  });

  // ═══ 3. The shell ═══
  await check('shell: every member has Home (the officer one counts items, the member one does not); My profile opens the viewer\'s own person page and is absent while they are on no roster', () => {
    const ctxOf = (g) => ({ section: 'guild', page: 'app', me: { user: { id: 'u1', displayName: 'Brewmaw', username: 'brew', avatarUrl: null, initials: 'B', prefs: {} }, identities: { discord: true }, guilds: [{ id: 'g1', name: 'Ravens' }] }, route: { name: 'section', gid: 'g1', section: 'home' }, guildData: g, teamId: 't1', attentionCount: 4 });
    const memberSide = G.shell.slots(ctxOf(memberGd()));
    assert(memberSide.sidebar.includes('href="#/g/g1"') && !/gs-nav-badge/.test(memberSide.sidebar.slice(0, memberSide.sidebar.indexOf('href="#/g/g1/roster"'))));
    assert(memberSide.account.includes('<a class="gs-menu-item" role="menuitem" href="#/g/g1/roster/p/p_me">') && memberSide.account.includes('<span>My profile</span>'));
    assert(memberSide.account.indexOf('My profile') < memberSide.account.indexOf('My characters'), 'first in the menu');
    const stranger = G.shell.slots(ctxOf(gd(MEMBER_CAN, { personId: null })));
    assert(!stranger.account.includes('My profile') && stranger.account.includes('My characters'));
    const officerSide = G.shell.slots(ctxOf(gd(OFFICER_CAN, { personId: 'p_boss' })));
    assert(/gs-nav-badge" aria-hidden="true">4</.test(officerSide.sidebar) && officerSide.account.includes('href="#/g/g1/roster/p/p_boss"'));
    const outside = G.shell.slots({ section: 'page', page: 'faq', me: ctxOf(null).me, route: null, guildData: null });
    assert(!outside.account.includes('My profile'), 'no guild in play, no profile');
  });

  await check('shell: signed out on the planner, Sign in is a text link; on a guild page it stays the button', () => {
    const planner = G.shell.slots({ section: 'planner', page: 'app', me: null, signedOut: true, guildData: null });
    assert(planner.account.includes('<a class="gs-signin-link" href="#/signin">') && planner.account.includes('Sign in or sign up') && planner.account.includes('>Sign in<'));
    assert(!planner.account.includes('gs-btn-molten') && !planner.account.includes('gs-signin-btn'));
    const guildPage = G.shell.slots({ section: 'guild', page: 'app', me: null, signedOut: true, route: { name: 'view' }, guildData: null });
    assert(guildPage.account.includes('gs-btn gs-btn-molten gs-signin-btn'), 'a page with nothing of its own to press keeps the button');
    for (const name of ['signin', 'home', 'join', 'apply']) {
      const own = G.shell.slots({ section: 'guild', page: 'app', me: null, signedOut: true, route: { name }, guildData: null });
      assert(own.account.includes('<a class="gs-signin-link"') && !own.account.includes('gs-btn-molten'), name + ': the page has its own primary, so one orange button per screen');
    }
  });

  // ═══ 4. The Planner's landing for guild members ═══
  const T = (id, name, archived) => TEAM(id, name, archived);
  const upcoming = (id, hours, over) => RAID(Object.assign({ id, raidOn: '2026-10-2' + hours, startsAt: Date.UTC(2026, 9, 20 + hours, 1, 0) }, over || {}));
  function plannerWorld(guilds) {
    // guilds: { gid: { name, can, teams, raids: { teamId: [upcoming] } } }; S.me.guilds lists them, S.guilds holds the loaded payloads for the ones named in `loaded`.
    S.me = { user: { id: 'u1', displayName: 'Brewmaw' }, guilds: Object.keys(guilds).map(id => ({ id, name: guilds[id].name })) };
    S.guilds = {};
    const api = (m, url) => {
      let hit = /^\/api\/guild\/([^/?]+)$/.exec(url);
      if (hit) { const g = guilds[hit[1]]; return { guild: { id: hit[1], name: g.name, timeZone: g.zone || 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm' }, teams: g.teams, me: { roles: [], can: g.can, personId: null } }; }
      hit = /^\/api\/guild\/([^/?]+)\/raids\?team=(.+)$/.exec(url);
      if (hit) {
        const g = guilds[hit[1]];
        if (g.fail === hit[2]) throw ApiErr(500, 'error');
        return { team: { id: hit[2] }, today: '2026-10-18', can: { edit: true, signup: false }, upcoming: (g.raids || {})[hit[2]] || [], raids: [], hasMore: false };
      }
      throw new Error('unexpected ' + url);
    };
    return api;
  }
  const PL = () => G.pages.plannerLanding;

  await check('Planner landing: a viewer who may edit raids sees their upcoming raids, soonest first, from the teams they may edit only; date in the guild zone, sign-ups, plan state, a Plan button', withState(async () => {
    PL().reset();
    const api = plannerWorld({
      g1: { name: 'Ravens', can: { 'raids.edit': ['t2'], 'raids.view': 'guild' }, teams: [T('t1', 'Main team'), T('t2', 'Alts'), T('t3', 'Old', true)], raids: { t1: [upcoming('r_main', 3)], t2: [upcoming('r_alt2', 5, { planned: false, signups: null }), upcoming('r_alt1', 1, { zone: 'Karazhan', title: 'Prog night' })], t3: [upcoming('r_old', 2)] } },
    });
    const s = stub(api);
    assert.equal(await PL().refresh(), true);
    assert.deepEqual(s.calls.map(c => c.url).sort(), ['/api/guild/g1', '/api/guild/g1/raids?team=t2'], 'only the team the viewer may edit is read; nothing for an archived or other team');
    s.restore();
    const out = PL().html();
    assert(out.includes('id="pl-h"><span class="gs-ph-sl">Upcoming'));
    assert.deepEqual([...out.matchAll(/<a class="gs-ph-cardlink"[^>]+data-rid="([^"]+)"/g)].map(m => m[1]), ['r_alt1', 'r_alt2'], 'soonest first');
    const first = out.slice(out.indexOf('<li class="gs-hd-panel gs-ph-rcard">'), out.indexOf('</li>'));
    assert(first.includes('Wed Oct 21') && first.includes('8:00 PM CT'), 'date and time in the guild zone');
    assert(first.includes('href="#/planner?raid=g1.r_alt1"'), 'the whole card links to the raid plan');
    assert(first.includes('Prog night') && first.includes('Karazhan - 25-man - Alts'));
    assert(stripTags(first).includes('17 / 25 signed up, 1 bench') && first.includes('is-green">Planned'));
    assert(first.includes('data-action="pl-plan" data-gid="g1" data-rid="r_alt1"'));
    assert(first.includes('>Open plan</button>'), 'the soonest planned raid still owns the primary');
    assert(out.includes('is-grey">Not planned') && out.includes('<p class="gs-ph-su">-</p>'), 'no counts for a viewer who may not see them');
    assert.equal(count(out, /gs-btn-molten/g), 1, 'only the soonest raid has a molten action');
    assert(!out.includes('saved on this device only'), 'guild raid cards do not claim browser-only storage');
    assertNoRawAttrs(out);
  }));

  await check('Planner landing: nothing for a plain member (no raids.edit), nothing signed out or with no guild; an empty list says so; a failing team read is skipped', withState(async () => {
    PL().reset();
    let api = plannerWorld({ g1: { name: 'Ravens', can: MEMBER_CAN, teams: [T('t1', 'Main team')], raids: { t1: [upcoming('r1', 1)] } } });
    let s = stub(api);
    await PL().refresh();
    assert.equal(PL().html(), '', 'a member who cannot plan sees the Planner as it always was');
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1'], 'no raids list is read for a team the viewer may not edit');
    s.restore();
    PL().reset();
    api = plannerWorld({ g1: { name: 'Ravens', can: { 'raids.edit': 'guild' }, teams: [T('t1', 'Main team')], raids: { t1: [] } } });
    s = stub(api);
    await PL().refresh();
    assert(PL().html().includes('No upcoming raids to plan.') && PL().html().includes('href="#/g/g1/raids"'));
    s.restore();
    PL().reset();
    api = plannerWorld({ g1: { name: 'Ravens', can: { 'raids.edit': 'guild' }, teams: [T('t1', 'Main team'), T('t2', 'Alts')], raids: { t1: [upcoming('r1', 1)], t2: [] }, fail: 't2' } });
    s = stub(api);
    await PL().refresh();
    assert.deepEqual([...PL().html().matchAll(/<a class="gs-ph-cardlink"[^>]+data-rid="([^"]+)"/g)].map(m => m[1]), ['r1'], 'the team that fails adds no rows and breaks nothing');
    s.restore();
    PL().reset();
    S.me = null;
    assert.equal(await PL().refresh(), false);
    assert.equal(PL().html(), '');
    S.me = { user: { id: 'u1' }, guilds: [] };
    assert.equal(await PL().refresh(), false);
    assert.equal(PL().html(), '');
  }));

  await check('Planner landing: several guilds merge by date and name the guild; more than six raids end with a count; reads are shared and not repeated while fresh', withState(async () => {
    PL().reset();
    const many = []; for (let i = 1; i <= 7; i++) many.push(upcoming('r' + i, i % 9 || 1));
    const api = plannerWorld({
      g1: { name: 'Ravens', can: { 'raids.edit': 'guild' }, teams: [T('t1', 'Main team')], raids: { t1: many.slice(0, 4) } },
      g2: { name: 'Owls', can: { 'raids.edit': 'guild' }, teams: [T('t9', 'Owl team')], raids: { t9: many.slice(4).map(r => Object.assign({}, r, { id: 'o' + r.id })) } },
    });
    const s = stub(api);
    const first = PL().refresh(); const second = PL().refresh();
    assert.equal(first, second, 'two callers share one read');
    await first;
    const n = s.calls.length;
    const out = PL().html();
    assert.equal(count(out, /class="gs-hd-panel gs-ph-rcard"/g), 6, 'at most six rows');
    assert(stripTags(out).includes('and 1 more on the Raids page'));
    assert(stripTags(out).includes('Ravens') && stripTags(out).includes('Owls'), 'with two guilds each row names its guild');
    assert.equal(await PL().refresh(), false, 'fresh: no new read');
    assert.equal(s.calls.length, n);
    assert.equal(S.guilds.g1.guild.id, 'g1', 'the payload is kept for the guild pages');
    assert.equal(await PL().refresh({ force: true }), true);
    s.restore();
  }));

  await check('Planner landing: Plan opens the planner for the raid (the Raids list\'s own Plan in Planner); an event-sourced raid refreshes its sign-ups first; a failure shows in the panel', withState(async () => {
    PL().reset();
    const api = plannerWorld({ g1: { name: 'Ravens', can: { 'raids.edit': 'guild' }, teams: [T('t1', 'Main team')], raids: { t1: [upcoming('r_a', 1), upcoming('r_b', 2, { eventSourced: true, eventId: '1234567890123456789', otherServer: false })] } } });
    const s = stub(api);
    await PL().refresh();
    s.restore();
    const planned = [];
    const real = G.pages.raids.planInPlanner;
    G.pages.raids.planInPlanner = (gid, rid, event) => { planned.push([gid, rid, event]); return Promise.resolve(true); };
    const button = el({ 'data-gid': 'g1', 'data-rid': 'r_a' });
    await G.handlers.click['pl-plan'](button);
    await G.handlers.click['pl-plan'](el({ 'data-gid': 'g1', 'data-rid': 'r_b' }));
    assert.deepEqual(plain(planned), [['g1', 'r_a', null], ['g1', 'r_b', { id: '1234567890123456789', otherServer: false }]]);
    assert.equal(button.disabled, true, 'the button waits for the planner to open');
    assert.equal(G.handlers.click['pl-plan'](el({ 'data-gid': 'g1', 'data-rid': 'nope' })), null, 'a row that is no longer listed does nothing');
    G.pages.raids.planInPlanner = () => Promise.resolve(false);
    const cancelled = el({ 'data-gid': 'g1', 'data-rid': 'r_a' });
    await G.handlers.click['pl-plan'](cancelled);
    assert.equal(cancelled.disabled, false, 'a cancelled move question leaves the button usable');
    let renders = 0; G.app.render = () => { renders++; };
    G.pages.raids.planInPlanner = () => Promise.reject(ApiErr(500, 'error'));
    const failed = el({ 'data-gid': 'g1', 'data-rid': 'r_a' });
    await G.handlers.click['pl-plan'](failed);
    assert.equal(failed.disabled, false);
    assert(PL().html().includes('id="pl-error" role="alert">Server says so.') && renders === 1);
    G.pages.raids.planInPlanner = real;
  }));

  await check('Planner home cards: unplanned primary, date-only cards, escaped titles and modified link clicks', withState(async () => {
    PL().reset();
    const s = stub(plannerWorld({ g1: { name: 'Ravens', can: OFFICER_CAN, teams: [T('t1', 'Main team')], raids: { t1: [upcoming('r1', 1, { planned: false, timeKnown: false, title: HOSTILE })] } } }));
    await PL().refresh(); s.restore();
    const out = PL().html();
    assert(out.includes('>Plan raid</button>'));
    assert(!out.includes('PM CT'), 'date-only raids do not invent a start time');
    assertEscaped(out, 'card title');
    const link = el({ 'data-gid': 'g1', 'data-rid': 'r1' }, { tagName: 'A', setAttribute() {}, removeAttribute() {} });
    const real = G.pages.raids.planInPlanner;
    let calls = 0, prevented = 0;
    G.pages.raids.planInPlanner = () => { calls++; return Promise.resolve(false); };
    try {
      assert.equal(G.handlers.click['pl-plan'](link, { ctrlKey: true }), null);
      assert.equal(calls, 0, 'modified clicks use the real href');
      await G.handlers.click['pl-plan'](link, { preventDefault() { prevented++; } });
      assert.equal(calls, 1); assert.equal(prevented, 1, 'ordinary clicks refresh sign-ups before navigation');
    } finally { G.pages.raids.planInPlanner = real; }
  }));

  await check('Planner home Show all: moves the original lists, restores on close, and closes before planner actions', withState(async () => {
    const realDoc = ctx.document;
    function parent() { return { children: [], replaceChild(next, old) { const i = this.children.indexOf(old); assert(i >= 0); this.children[i] = next; next.parentNode = this; old.parentNode = null; }, appendChild(n) { this.children.push(n); n.parentNode = this; } }; }
    const home = parent();
    const ids = ['landing-saved-list', 'landing-copies-wrap', 'landing-history-wrap'];
    const nodes = ids.map(id => { const n = { id }; home.appendChild(n); return n; });
    const opener = { id: 'btn-landing-showall' };
    let body, listeners, dialog, opens = 0;
    ctx.document = { getElementById: id => id === opener.id ? opener : (id === 'pl-all-body' ? body : nodes.find(n => n.id === id)), createComment: () => ({}) };
    G.ui.openDialog = () => {
      opens++; body = parent(); listeners = {};
      dialog = { open: true, querySelector: () => body, addEventListener: (type, fn, capture) => { listeners[type] = { fn, capture }; }, close() { this.open = false; } };
      return dialog;
    };
    try {
      PL().openAllPlans();
      assert.equal(G.app.lastActionEl, opener, 'focus returns to Show all');
      assert.deepEqual(body.children, nodes, 'no cloned forms or duplicate hook IDs');
      assert.equal(PL().openAllPlans(), null); assert.equal(opens, 1);
      listeners.close.fn(); body = null;
      assert.deepEqual(home.children, nodes, 'Escape/Close restores all three lists');
      for (const action of ['.saved-open', '[data-delete-plan]', '[data-delete-copy]', '[data-history-open]', '[data-history-delete]', '.history-more']) {
        PL().openAllPlans();
        assert.equal(listeners.click.capture, true);
        listeners.click.fn({ target: { closest: selector => selector.includes(action) } });
        assert.equal(dialog.open, false, action + ' closes the dialog before its own handler');
        assert.deepEqual(home.children, nodes, action + ' restores synchronously');
        listeners.close.fn(); body = null;
      }
    } finally { ctx.document = realDoc; }
  }));

  await check('guild.css: every gs- class the new Home and Planner landing markup uses has a rule', () => {
    const css = (read('planner-forge.css') + '\n' + read('guild.css'));
    const markup = ['js/guild/pages-home-member.js', 'js/guild/pages-planner-landing.js', 'js/guild/pages-attention.js'].map(f => read(f)).join('\n');
    const used = new Set();
    for (const m of markup.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/^gs-[a-z0-9_-]+$/.test(c)) used.add(c);
    const defined = new Set([...css.matchAll(/\.(gs-[a-z0-9_-]+)/g)].map(m => m[1]));
    const notClasses = ['gs-page-alert']; // an element id passed to alertHtml as a plain string
    assert.deepEqual([...used].filter(c => !defined.has(c) && !notClasses.includes(c)), []);
    assert(!/[^\x00-\x7f]/.test(markup.replace(/^\s*\/\/.*$/gm, '')), 'ASCII in code and copy (the comments keep their rules)');
    assert(!/\.style\.|style=/.test(markup.replace(/'style'/g, '')), 'no inline styles');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
