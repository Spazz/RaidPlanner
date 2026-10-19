/**
 * Raidsmith guild UI, PM wave 8 - tests for the Roster's Launch tab, the guest sign-up page (#/join/<token>) and the raid page's duties, pasted roster and guest
 * sign-up link, plus the browser's two-part character names.
 * Run: node guild-wave8-ui-tests.js
 *
 * Same approach as guild-wave7-ui-tests.js: the shared guild script list (tests/guild-scripts.js) is loaded in a vm with no DOM; the render functions return
 * HTML strings and the handlers run against a stubbed G.api and a fake document. guild-wave8-worker-tests.js covers the Worker half.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }
async function run() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const css = read('guild.css');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
let els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
const TOKEN = 'A'.repeat(43);

function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

const OFFICER = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'guild.teams': 'guild' };
const MEMBER = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': 'guild' };
const TEAMS = [{ id: 't1', name: 'Alpha', size: 20, archived: false, players: 3, leads: [] }];
function gd(can, version, teams) {
  return {
    guild: { id: 'g1', name: 'Ravens', realm: version === 'forever' ? 'Normal' : 'Nightslayer', realmKind: version === 'forever' ? 'ruleset' : 'realm', region: 'US', timeZone: 'America/Chicago', gameVersion: version || 'forever', createdAt: 1 },
    teams: teams || TEAMS.map(t => Object.assign({}, t)),
    me: { roles: [], can: can || OFFICER },
    attendanceFlags: {},
  };
}

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, join: S.join };
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.join = null;
    els = {};
    const savedRender = G.app.render, savedOpen = G.ui.openDialog, savedHandle = G.app.handleError;
    const probe = { renders: 0, opened: [], handled: [] };
    G.app.render = () => { probe.renders++; };
    G.ui.openDialog = (html, opts) => { probe.opened.push({ html, opts }); return { open: true }; };
    G.app.handleError = (err, o) => { probe.handled.push([err, o]); };
    try { await fn(S, probe); } finally {
      Object.assign(S, saved);
      G.app.render = savedRender; G.ui.openDialog = savedOpen; G.app.handleError = savedHandle;
    }
  };
}
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null }, extra || {});
const okRes = body => Promise.resolve(body);
const rejectWith = (status, body) => Promise.reject(new G.api.ApiError(status, body));
const field = id => { els[id] = { textContent: '', hidden: true, innerHTML: '', focus() {} }; return els[id]; };
function formEl(elements, attrs) {
  return { getAttribute: k => (attrs || {})[k], elements, closest: () => null, querySelector: () => null, querySelectorAll: () => [] };
}

// ---------------------------------------------------------------------------
// Routes, tabs, the API

check('router: #/join/<token> and the Launch tab parse and format back; the join page works signed out', () => {
  assert.deepEqual(plain(G.router.parse('#/join/' + TOKEN)), { name: 'join', token: TOKEN });
  assert.equal(G.router.format({ name: 'join', token: TOKEN }), '#/join/' + TOKEN);
  assert.deepEqual(plain(G.router.parse('#/join/short')), { name: 'notfound' });
  assert.deepEqual(plain(G.router.parse('#/join/' + TOKEN + '/extra')), { name: 'notfound' });
  assert.equal(G.router.format({ name: 'join', token: 'nope' }), '#/');
  assert.equal(G.router.isViewerRoute({ name: 'join', token: TOKEN }), true);
  assert.deepEqual(plain(G.router.parse('#/g/g1/roster/launch')), { name: 'launch', gid: 'g1' });
  assert.equal(G.router.format({ name: 'launch', gid: 'g1' }), '#/g/g1/roster/launch');
  assert(G.router.ROSTER_TABS.includes('launch'));
});

check('api: duties, launch, join links, the guest page and the pasted roster hit the contract paths with the contract bodies', async () => {
  const s = stub(() => Promise.resolve({}));
  await G.api.duties.get('g1', 'r1');
  await G.api.duties.save('g1', 'r1', [{ duty: 'logger', personId: 'p1' }]);
  await G.api.launch.get('g1', 't1');
  await G.api.launch.set('g1', 'p1', { teamId: 't1', ready: true });
  await G.api.launch.mark('g1', 't1', true);
  await G.api.joinLinks.list('g1', 'r1');
  await G.api.joinLinks.create('g1', 'r1', { maxUses: 4 });
  await G.api.joinLinks.revoke('g1', 'r1', 'jl_1');
  await G.api.joinLinks.removeGuest('g1', 'r1', 3);
  await G.api.join.view(TOKEN);
  await G.api.join.submit({ token: TOKEN, name: 'Aldric' });
  await G.api.pasteRoster.preview('g1', 'r1', 'Aldric');
  await G.api.pasteRoster.save('g1', 'r1', 'Aldric');
  await G.api.pasteRoster.save('g1', 'r1', 'Aldric', 'Because');
  assert.deepEqual(plain(s.calls), [
    { m: 'get', url: '/api/guild/g1/raids/r1/duties' },
    { m: 'put', url: '/api/guild/g1/raids/r1/duties', body: { duties: [{ duty: 'logger', personId: 'p1' }] } },
    { m: 'get', url: '/api/guild/g1/launch?team=t1' },
    { m: 'put', url: '/api/guild/g1/launch/p1', body: { teamId: 't1', ready: true } },
    { m: 'put', url: '/api/guild/g1/teams/t1/launch', body: { enabled: true } },
    { m: 'get', url: '/api/guild/g1/raids/r1/join-links' },
    { m: 'post', url: '/api/guild/g1/raids/r1/join-links', body: { maxUses: 4 } },
    { m: 'del', url: '/api/guild/g1/raids/r1/join-links/jl_1', body: {} },
    { m: 'del', url: '/api/guild/g1/raids/r1/guests/3', body: {} },
    { m: 'post', url: '/api/join/view', body: { token: TOKEN } },
    { m: 'post', url: '/api/join', body: { token: TOKEN, name: 'Aldric' } },
    { m: 'post', url: '/api/guild/g1/raids/r1/manual/paste/preview', body: { text: 'Aldric' } },
    { m: 'post', url: '/api/guild/g1/raids/r1/manual/paste', body: { text: 'Aldric' } },
    { m: 'post', url: '/api/guild/g1/raids/r1/manual/paste', body: { text: 'Aldric', reason: 'Because' } },
  ]);
  s.restore();
});

check('Roster tabs: Launch is not a tab (roster redesign, lane U1): the Launch list is a page opened from the Spec poll, which stays the lit tab on it', () => {
  const labels = (data) => [...G.pages.rosterTabs.html(data, 'roster').matchAll(/>([A-Za-z ]+)<\/a>/g)].map(m => m[1]);
  assert.deepEqual(labels(gd(MEMBER, 'forever')), ['Roster', 'Spec poll']);
  assert.deepEqual(labels(gd(OFFICER, 'forever')), ['Roster', 'Spec poll', 'Recruiting']);
  assert.deepEqual(labels(gd(MEMBER, 'tbc')), ['Roster', 'Spec poll']);
  assert.deepEqual(labels(gd(MEMBER, 'tbc', [Object.assign({}, TEAMS[0], { launchTeam: true })])), ['Roster', 'Spec poll']);
  const onLaunch = G.pages.rosterTabs.html(gd(MEMBER, 'forever'), 'launch');
  assert(onLaunch.includes('href="#/g/g1/roster/intent" aria-current="page">Spec poll') && !onLaunch.includes('roster/launch'), 'the Spec poll tab is lit on the launch page');
  assert(G.pages.rosterTabs.html(gd(OFFICER, 'forever'), 'applications').includes('href="#/g/g1/roster/recruiting" aria-current="page">Recruiting'), 'the old Applications address lights Recruiting');
});

// ---------------------------------------------------------------------------
// The Launch funnel

const row = (id, name, over) => Object.assign({
  personId: id, name, class: 'WARRIOR', status: 'raider', role: 'tank', intent: { class: 'WARRIOR', spec: 'Protection' }, level: null, ready: false, mine: false,
  flags: { intent: true, character: true, level: false, ready: false }, stage: 2,
}, over || {});
const FUNNEL = (over) => Object.assign({
  team: { id: 't1', name: 'Alpha', size: 20, archived: false, launchTeam: false }, enabled: true, gameVersion: 'forever', canEdit: true, canMark: true, myPersonId: 'p2', levelBands: ['1-19', '20-39', '40-59', '60+'],
  round: { id: 'ir_1', title: 'Launch intent', status: 'open' },
  rows: [
    row('p1', 'Aldric', { level: { band: '40-59', source: 'manual' }, flags: { intent: true, character: true, level: true, ready: false }, stage: 3 }),
    row('p2', 'Brenna', { role: 'healer', class: 'PRIEST', intent: { class: 'PRIEST', spec: 'Holy' }, level: { band: '60+', source: 'battlenet' }, ready: true, mine: true, flags: { intent: true, character: true, level: true, ready: true }, stage: 4 }),
    row('p3', 'Corwin', { role: null, class: 'MAGE', intent: null, flags: { intent: false, character: true, level: false, ready: false }, stage: 0 }),
  ],
  totals: {
    people: 3, stages: { intent: 2, character: 3, level: 2, topLevel: 1, ready: 1 }, gap: 19,
    roles: [
      { role: 'tank', people: 1, intent: 1, character: 1, level: 1, ready: 0, target: 2, gap: 2 }, { role: 'healer', people: 1, intent: 1, character: 1, level: 1, ready: 1, target: 5, gap: 4 },
      { role: 'melee', people: 0, intent: 0, character: 0, level: 0, ready: 0, target: 7, gap: 7 }, { role: 'ranged', people: 0, intent: 0, character: 0, level: 0, ready: 0, target: 6, gap: 6 },
      { role: 'none', people: 1, intent: 0, character: 1, level: 0, ready: 0, target: null, gap: null },
    ],
  },
}, over || {});
const launchState = (data) => ({ gid: 'g1', teamId: 't1', data: data || FUNNEL(), note: '', busy: false });

check('launch page (officer): the four stages as bars with counts, the gap to the raid size, a table by role and a row per person with the controls', () => {
  const out = G.pages.launch.launchHtml({ guildData: gd(OFFICER, 'forever'), state: launchState() });
  const t = text(out);
  assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Roster</h1>') && t.includes('Alpha - Launch'));
  for (const label of ['Spec poll picked', 'Character created', 'Level band', 'Attuned / ready']) assert(t.includes(label), label);
  assert(out.includes('<progress class="gs-funnel-bar" max="3" value="2" aria-labelledby="fn-intent"></progress>'));
  assert(out.includes('value="3" aria-labelledby="fn-character"') && out.includes('value="1" aria-labelledby="fn-ready"'));
  assert(t.includes('19 spots short of the 20-man raid') && t.includes('1 person is at the top level band'));
  assert(t.includes('Tanks') && t.includes('Melee DPS') && t.includes('No pick yet') && t.includes('Need 2'));
  // A row per person; officers get a level select and a ready button on every one.
  assert.equal((out.match(/data-change="launch-band"/g) || []).length, 3);
  assert(out.includes('data-action="launch-ready" data-pid="p1" data-ready="true"') && out.includes('data-action="launch-ready" data-pid="p2" data-ready="false"'));
  assert(out.includes('aria-pressed="true"') && out.includes('Mark as ready: Aldric'));
  assert(t.includes('Battle.net') && t.includes('Not picked') && t.includes('Launch intent'));
  assert(!out.includes('data-action="launch-team" data-enabled="false"'), 'a Forever guild cannot turn the funnel off');
  assertNoRawAttrs(out);
  assert(!G.pages.launch.rowsHtml(FUNNEL({ rows: [row('p9', '<img src=x onerror=1>')] })).includes('<img'), 'a name is escaped');
});

check('launch page (member): only their own row has controls; the rest is read-only; a non-Forever launch team can turn the funnel off', () => {
  const member = G.pages.launch.launchHtml({ guildData: gd(MEMBER, 'forever'), state: launchState(FUNNEL({ canEdit: false, canMark: false })) });
  assert.equal((member.match(/data-change="launch-band"/g) || []).length, 1);
  assert.equal((member.match(/data-action="launch-ready"/g) || []).length, 1);
  assert(member.includes('data-pid="p2"') && text(member).includes('(you)'));
  assert(text(member).includes('You can set your own row.'));
  const tbc = G.pages.launch.launchHtml({ guildData: gd(OFFICER, 'tbc'), state: launchState(FUNNEL({ gameVersion: 'tbc', team: Object.assign({}, FUNNEL().team, { launchTeam: true }) })) });
  assert(tbc.includes('data-action="launch-team" data-enabled="false"'));
});

check('launch page: the funnel off for the team says so; an officer can turn it on; nobody else gets the button', () => {
  const off = (over) => G.pages.launch.launchHtml({ guildData: gd(OFFICER, 'tbc'), state: launchState(FUNNEL(Object.assign({ enabled: false, gameVersion: 'tbc', rows: [], totals: null }, over))) });
  assert(text(off()).includes('The Launch funnel is off for this team'));
  assert(off().includes('data-action="launch-team" data-enabled="true"'));
  assert(!off({ canMark: false }).includes('data-action="launch-team"'));
});

check('launch page: Ready sends the tick, the level select sends the band (null clears), the team button marks it; the answer replaces the funnel', withState(async (S, probe) => {
  S.guilds.g1 = gd(OFFICER, 'tbc'); S.currentGid = 'g1';
  S.att.launch = launchState();
  const sent = [];
  const after = FUNNEL({ rows: FUNNEL().rows.map(r => (r.personId === 'p1' ? Object.assign({}, r, { ready: true }) : r)) });
  const s = stub((m, url, body) => { sent.push([m, url, plain(body)]); return okRes(after); });
  G.handlers.click['launch-ready'](el({ 'data-pid': 'p1', 'data-ready': 'true' }));
  await settle();
  assert.deepEqual(sent[0], ['put', '/api/guild/g1/launch/p1', { teamId: 't1', ready: true }]);
  assert.equal(S.att.launch.data.rows[0].ready, true);
  assert.equal(S.att.launch.busy, false);
  G.handlers.change['launch-band'](Object.assign(el({ 'data-pid': 'p3' }), { value: '20-39' }));
  await settle();
  G.handlers.change['launch-band'](Object.assign(el({ 'data-pid': 'p3' }), { value: '' }));
  await settle();
  assert.deepEqual(sent.slice(1).map(c => c[2]), [{ teamId: 't1', levelBand: '20-39' }, { teamId: 't1', levelBand: null }]);
  G.handlers.click['launch-team'](el({ 'data-enabled': 'true' }));
  await settle();
  assert.deepEqual(sent[3], ['put', '/api/guild/g1/teams/t1/launch', { enabled: true }]);
  assert.equal(S.att.launch.note, 'The Launch funnel is on for this team.');
  // A refusal goes to the page alert and the funnel stays as it was.
  s.restore();
  const refused = stub(() => rejectWith(403, { error: 'forbidden', message: 'No.' }));
  G.handlers.click['launch-ready'](el({ 'data-pid': 'p1', 'data-ready': 'false' }));
  await settle();
  assert.equal(probe.handled.length, 1);
  assert.equal(S.att.launch.busy, false);
  refused.restore();
}));

// ---------------------------------------------------------------------------
// The guest sign-up page

const JOIN_DATA = (over) => Object.assign({
  guild: { name: 'Ravens', gameVersion: 'tbc', realmKind: 'realm' },
  raid: { raidOn: '2027-01-20', startsAt: Date.UTC(2027, 0, 21, 1), timeKnown: true, zone: 'Karazhan', title: 'Sunday Karazhan', teamName: 'Alpha' },
  spotsLeft: 3, noteMax: 120,
  rosterOptions: null,
}, over || {});

check('join page: the raid, the form with a hidden field, a hint per game version; loading, a link that does not work and a sign-up done', () => {
  const state = (over) => Object.assign({ token: TOKEN, status: 'ok', data: JOIN_DATA(), draft: {}, busy: false, error: '', done: false, message: '', title: '' }, over || {});
  const out = G.pages.join.joinHtml({ state: state() });
  const t = text(out);
  assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Sign up for Ravens</h1>'));
  assert(t.includes('Sunday Karazhan - Karazhan') && t.includes('Alpha') && t.includes('3 spots are left on the link.'));
  for (const name of ['name', 'class', 'spec', 'note', 'website']) assert(out.includes('name="' + name + '"'), name);
  assert(out.includes('data-submit="join-form"') && out.includes('class="gs-hp" aria-hidden="true"'));
  assert(t.includes('2 to 12 letters.') && !t.includes('a first name, then a surname'));
  assert(text(G.pages.join.joinHtml({ state: state({ data: JOIN_DATA({ guild: { name: 'Ravens', gameVersion: 'forever', realmKind: 'ruleset' } }) }) })).includes('a first name, then a surname if it has one'));
  assert(text(G.pages.join.joinHtml({ state: state({ data: JOIN_DATA({ spotsLeft: 1 }) }) })).includes('One spot is left on the link.'));
  assert(G.pages.join.joinHtml({ state: state({ done: true }) }).includes('You are signed up'));
  assert(text(G.pages.join.joinHtml({ state: state({ status: 'gone', title: 'This link has stopped working', message: 'It stopped when the raid started.' }) })).includes('This link has stopped working'));
  assert(G.pages.join.joinHtml({ state: null }).includes('Loading'));
  assert(G.pages.join.joinHtml({ state: state({ draft: { name: '"><b>' } }) }).includes('value="&quot;&gt;&lt;b&gt;"'), 'the draft is escaped');
  assertNoRawAttrs(out);
});

check('join page: load asks the Worker once with the token; 404 and 410 become "does not work", the rest an error with a retry', withState(async (S) => {
  let answer = () => okRes(JOIN_DATA());
  const s = stub(() => answer());
  const ok = await G.pages.join.load({ name: 'join', token: TOKEN });
  assert.deepEqual(plain(s.calls), [{ m: 'post', url: '/api/join/view', body: { token: TOKEN } }]);
  assert.equal(ok.status, 'ok');
  assert.equal(S.join, ok);
  answer = () => rejectWith(410, { error: 'link_revoked', message: 'An officer turned this sign-up link off.' });
  const gone = await G.pages.join.load({ name: 'join', token: TOKEN });
  assert.deepEqual([gone.status, gone.title, gone.message], ['gone', 'This link has stopped working', 'An officer turned this sign-up link off.']);
  answer = () => rejectWith(404, { error: 'link_invalid', message: 'Not valid.' });
  assert.equal((await G.pages.join.load({ name: 'join', token: TOKEN })).title, 'This link is not valid');
  answer = () => rejectWith(500, { error: 'server_error', message: 'Boom' });
  assert.equal((await G.pages.join.load({ name: 'join', token: TOKEN })).status, 'error');
  s.restore();
}));

check('join page: the form checks name, class and spec, sends the body with the hidden field, shows a refusal at its field, and ends on "You are signed up"', withState(async (S, probe) => {
  const x = S.join = { token: TOKEN, status: 'ok', data: JOIN_DATA(), draft: {}, busy: false, error: '', done: false, message: '', title: '' };
  const form = (values) => formEl({ name: { value: values.name || '' }, class: { value: values.class || '' }, spec: { value: values.spec || '' }, note: { value: values.note || '' }, website: { value: values.website || '' } });
  assert.deepEqual(plain(G.pages.join.problemOf({ name: '', class: '', spec: '' })), { field: 'name', text: 'Enter your character\'s name.' });
  assert.deepEqual(plain(G.pages.join.problemOf({ name: 'Aldric', class: '', spec: '' })), { field: 'class', text: 'Choose a class.' });
  assert.deepEqual(plain(G.pages.join.bodyFrom({ name: 'Aldric', class: 'MAGE', spec: 'Fire', note: '' }, TOKEN, '')), { token: TOKEN, name: 'Aldric', class: 'MAGE', spec: 'Fire', website: '' });
  assert.deepEqual(plain(G.pages.join.bodyFrom({ name: 'Aldric', class: 'MAGE', spec: 'Fire', note: 'Hi' }, TOKEN, 'http://x')), { token: TOKEN, name: 'Aldric', class: 'MAGE', spec: 'Fire', note: 'Hi', website: 'http://x' });
  const nameErr = field('jn-name-err');
  G.handlers.submit['join-form'](form({}));
  assert.equal(nameErr.hidden, false);
  assert(nameErr.innerHTML.includes('Enter your character&#39;s name.'), 'the message sits under the field and says what to do');
  nameErr.hidden = true;
  let answer = () => rejectWith(409, { error: 'on_roster', message: 'That character is on the guild\'s roster.', field: 'name' });
  const s = stub(() => answer());
  G.handlers.submit['join-form'](form({ name: 'Aldric', class: 'MAGE', spec: 'Fire' }));
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(nameErr.hidden, false);
  assert.match(nameErr.innerHTML, /on the guild&#39;s roster/);
  assert.equal(x.done, false);
  answer = () => okRes({ ok: true, spotsLeft: 2 });
  G.handlers.submit['join-form'](form({ name: 'Aldric', class: 'MAGE', spec: 'Fire', note: 'From Beta' }));
  await settle();
  assert.equal(x.done, true);
  assert.deepEqual(s.calls[1].body, { token: TOKEN, name: 'Aldric', class: 'MAGE', spec: 'Fire', note: 'From Beta', website: '' });
  s.restore();
  void probe;
}));

// ---------------------------------------------------------------------------
// The raid page: duties, a pasted roster, the guest sign-up link

const RAID = (over, rover) => Object.assign({
  raid: Object.assign({ id: 'r4', team: { id: 't1', name: 'Alpha' }, teamId: 't1', raidOn: '2027-01-12', startsAt: 1, zone: 'Karazhan', size: 10, state: 'awaiting_log', openFlags: 0, stale: false, version: 1 }, rover || {}),
  can: { edit: true, review: true, seeAttendance: true, seeNicknames: true }, sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [], duties: [],
}, over || {});

check('raid page: the header line lists the duties; the Actions menu offers duties everywhere, a guest link before the start and a pasted roster after it - editors only', () => {
  const duties = [{ duty: 'leader', label: 'Raid leader', personId: 'p1', name: 'Aldric', class: 'WARRIOR' }, { duty: 'extra', label: 'Bring <flasks>', personId: 'p2', name: 'Brenna', class: 'PRIEST' }];
  const out = G.pages.raid.raidHtml({ guildData: gd(OFFICER, 'tbc'), data: RAID({ duties }) });
  assert(out.includes('id="raid-duties"'));
  assert(text(out.slice(out.indexOf('id="raid-duties"'), out.indexOf('</p>', out.indexOf('id="raid-duties"')))).includes('Raid leader: Aldric') && out.includes('Bring &lt;flasks&gt;'));
  assert(!G.pages.raid.raidHtml({ guildData: gd(OFFICER, 'tbc'), data: RAID() }).includes('raid-duties'), 'no duties, no line');
  const labels = (data) => plain(G.pages.raidExtras.menuItems(data).map(i => i.label));
  assert.deepEqual(labels(RAID()), ['Set raid duties', 'Paste raid roster']);
  assert.deepEqual(labels(RAID({}, { upcoming: true })), ['Set raid duties', 'Guest sign-up link']);
  assert.deepEqual(labels(RAID({ sources: { event: null, reports: [{ code: 'Aaaa000000000001' }], plan: null } })), ['Set raid duties'], 'a raid with a log has no pasted roster');
  assert.deepEqual(labels(RAID({}, { state: 'manual', manual: { reason: 'x' } })), ['Set raid duties', 'Paste raid roster (replaces who is present)']);
  assert.deepEqual(labels(RAID({ can: { edit: false } })), []);
  assert(G.pages.raid.raidHtml({ guildData: gd(OFFICER, 'tbc'), data: RAID() }).includes('data-action="raid-extra" data-op="paste"'));
});

const ROSTER_RES = { people: [{ id: 'p1', status: 'raider', main: { name: 'Aldric', class: 'WARRIOR' } }, { id: 'p2', status: 'raider', main: { name: 'Brenna', class: 'PRIEST' } }, { id: 'p3', status: 'inactive', main: { name: 'Gone', class: 'MAGE' } }] };

check('duties dialog: a select per duty from the roster (inactive people left out), the last raid\'s duties on a button, and the form reads into the body', withState(async (S, probe) => {
  S.guilds.g1 = gd(OFFICER, 'tbc'); S.currentGid = 'g1';
  S.att.raid = { gid: 'g1', rid: 'r4', data: RAID() };
  const prior = [{ duty: 'logger', label: 'Logger', personId: 'p2', name: 'Brenna', class: 'PRIEST' }];
  const s = stub((m, url, body) => {
    if (/\/duties$/.test(url) && m === 'get') return okRes({ duties: [{ duty: 'leader', label: 'Raid leader', personId: 'p1', name: 'Aldric', class: 'WARRIOR' }], previous: prior });
    if (/\/roster\?team=/.test(url)) return okRes(ROSTER_RES);
    return okRes(RAID({ duties: [] }));
  });
  G.handlers.click['raid-extra'](el({ 'data-op': 'duties' }));
  await settle();
  assert.equal(probe.opened.length, 1);
  const html = probe.opened[0].html;
  assert(html.includes('data-submit="duties-form"') && html.includes('Raid leader') && html.includes('Loot master') && html.includes('Plan maker'));
  assert(html.includes('>Aldric<') && html.includes('>Brenna<') && !html.includes('Gone'), 'people from the roster, inactive ones left out');
  assert(/<option value="p1" selected>Aldric<\/option>/.test(html), 'the current Raid leader is selected');
  assert(html.includes('data-action="duties-copy"') && html.includes('Same as the last raid'));
  assertNoRawAttrs(html);
  // The form -> duties.
  const form = (v) => formEl({ leader: { value: v.leader || '' }, loot: { value: '' }, logger: { value: v.logger || '' }, planner: { value: '' }, extraLabel: { value: v.label || '' }, extra: { value: v.extra || '' } });
  assert.deepEqual(plain(G.pages.raidExtras.readDuties(form({ leader: 'p1', logger: 'p2', label: ' Flasks ', extra: 'p2' }))), { duties: [{ duty: 'leader', personId: 'p1' }, { duty: 'logger', personId: 'p2' }, { duty: 'extra', personId: 'p2', label: 'Flasks' }] });
  assert.match(G.pages.raidExtras.readDuties(form({ label: 'Flasks' })).error, /Pick who gets "Flasks"/);
  assert.match(G.pages.raidExtras.readDuties(form({ extra: 'p1' })).error, /Name your own duty/);
  // Copy from the last raid fills the form.
  const copyForm = formEl({ leader: { value: 'p1' }, loot: { value: '' }, logger: { value: '' }, planner: { value: '' }, extraLabel: { value: '' }, extra: { value: '' } });
  G.handlers.click['duties-copy'](Object.assign(el({}), { closest: () => copyForm }));
  assert.equal(copyForm.elements.logger.value, 'p2');
  assert.equal(copyForm.elements.leader.value, '', 'the form becomes the last raid\'s duties');
  // Saving sends the list and draws the answer.
  const err = field('dlg-err-duties');
  G.handlers.submit['duties-form'](form({ label: 'Flasks' }));
  assert.equal(err.hidden, false);
  s.calls.length = 0;
  const closed = [];
  G.ui.closeDialogOf = (f) => closed.push(f);
  G.handlers.submit['duties-form'](form({ leader: 'p1' }));
  await settle();
  assert.deepEqual(s.calls.filter(c => c.m === 'put').map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/raids/r4/duties', { duties: [{ duty: 'leader', personId: 'p1' }] }]]);
  assert(closed.length >= 1);
  s.restore();
}));

check('paste dialog: the first press checks the names and shows who matched, the second saves what was shown; editing the text starts over; nothing usable stays on Check', withState(async (S, probe) => {
  S.guilds.g1 = gd(OFFICER, 'tbc'); S.currentGid = 'g1';
  S.att.raid = { gid: 'g1', rid: 'r4', data: RAID() };
  G.handlers.click['raid-extra'](el({ 'data-op': 'paste' }));
  assert.equal(probe.opened.length, 1);
  assert(probe.opened[0].html.includes('data-submit="paste-form"') && probe.opened[0].html.includes('data-input="paste-text"'));
  assert(text(probe.opened[0].html).includes('The raid becomes hand-entered attendance'));
  const result = field('pr-result');
  const go = field('pr-go');
  const box = { value: 'Aldric\nBrenna\nStranger' };
  const form = formEl({ text: box });
  const PREVIEW = { matched: [{ name: 'Aldric', personId: 'p1', class: 'WARRIOR' }], guests: [{ name: 'Visitor' }], unmatched: [{ name: 'Stranger' }], ignored: [{ line: 4, text: '1234' }], ignoredCount: 1, tooLong: false, replacing: false };
  const s = stub((m, url) => (/preview$/.test(url) ? okRes(PREVIEW) : okRes(RAID({ duties: [] }))));
  const empty = field('dlg-err-text');
  G.handlers.submit['paste-form'](formEl({ text: { value: '  ', focus() {} } }));
  assert.equal(empty.hidden, false, 'empty text asks for names');
  G.handlers.submit['paste-form'](form);
  await settle();
  assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/raids/r4/manual/paste/preview', { text: box.value }]]);
  const shown = text(result.innerHTML);
  assert(shown.includes('Present (1)') && shown.includes('Aldric') && shown.includes('Matched nobody') && shown.includes('Stranger') && shown.includes('Known guests') && shown.includes('1 line was not a name'));
  assert.equal(go.textContent, 'Save attendance');
  // Typing again drops the preview.
  G.handlers.input['paste-text']();
  assert.equal(go.textContent, 'Check names');
  assert.equal(result.innerHTML, '');
  G.handlers.submit['paste-form'](form);
  await settle();
  assert.equal(go.textContent, 'Save attendance');
  G.ui.closeDialogOf = () => {};
  G.handlers.submit['paste-form'](form);
  await settle();
  const saves = s.calls.filter(c => c.m === 'post' && !/preview$/.test(c.url));
  assert.deepEqual(saves.map(c => [c.url, c.body]), [['/api/guild/g1/raids/r4/manual/paste', { text: box.value }]]);
  assert.equal(S.att.note, 'Attendance saved from the pasted roster.');
  s.restore();
}));

check('guest sign-up link dialog: the links with their state, a form for how many guests, the new link shown once with Copy, Turn off for a working one', withState(async (S, probe) => {
  S.guilds.g1 = gd(OFFICER, 'tbc'); S.currentGid = 'g1';
  S.att.raid = { gid: 'g1', rid: 'u1', data: RAID({}, { id: 'u1', upcoming: true }) };
  const LIST = { links: [{ id: 'jl_a', maxUses: 5, uses: 2, status: 'active', createdAt: 1 }, { id: 'jl_b', maxUses: 3, uses: 3, status: 'full', createdAt: 1 }, { id: 'jl_c', maxUses: 3, uses: 0, status: 'revoked', createdAt: 1 }], limits: { defaultUses: 10, maxUses: 50, perRaid: 5 } };
  const s = stub((m, url, body) => {
    if (m === 'get') return okRes(LIST);
    if (m === 'post') return okRes(Object.assign({}, LIST, { created: { id: 'jl_n', token: TOKEN, path: '/#/join/' + TOKEN } }));
    return okRes(Object.assign({}, LIST, { links: LIST.links.map(l => (l.id === 'jl_a' ? Object.assign({}, l, { status: 'revoked' }) : l)) }));
  });
  G.handlers.click['raid-extra'](el({ 'data-op': 'join' }));
  await settle();
  const html = probe.opened[0].html;
  const t = text(html);
  assert(t.includes('2 guests of 5') && t.includes('Works') && t.includes('Used up') && t.includes('Turned off'));
  assert.equal((html.match(/data-action="join-revoke"/g) || []).length, 1, 'only the working link has Turn off');
  assert(html.includes('name="maxUses"') && html.includes('value="10"') && html.includes('max="50"'));
  assertNoRawAttrs(html);
  // Making a link opens the "shown once" dialog with the full address.
  const closed = [];
  G.ui.closeDialogOf = (f) => closed.push(f);
  G.handlers.submit['join-make-form'](formEl({ maxUses: { value: '4' } }));
  await settle();
  assert.deepEqual(s.calls.filter(c => c.m === 'post').map(c => [c.url, c.body]), [['/api/guild/g1/raids/u1/join-links', { maxUses: 4 }]]);
  const made = probe.opened[probe.opened.length - 1].html;
  assert(made.includes('value="' + '/#/join/' + TOKEN + '"') || made.includes('/#/join/' + TOKEN));
  assert(made.includes('data-action="join-copy"') && text(made).includes('shown only once'));
  // Turn off re-draws the list.
  G.handlers.click['join-revoke'](el({ 'data-jid': 'jl_a' }));
  await settle();
  assert.deepEqual(s.calls[s.calls.length - 1].url, '/api/guild/g1/raids/u1/join-links/jl_a');
  assert.equal((probe.opened[probe.opened.length - 1].html.match(/data-action="join-revoke"/g) || []).length, 0);
  const bad = field('dlg-err-maxUses');
  G.handlers.submit['join-make-form'](formEl({ maxUses: { value: '0' } }));
  assert.equal(bad.hidden, false);
  s.restore();
}));

check('sign-ups panel: a guest is listed with a Guest chip; an officer can remove it, nobody else sees the button', () => {
  const entry = { key: 'x:raidsmith:3', personId: null, source: 'raidsmith', kind: 'signed', name: 'Guestmage', classId: 'MAGE', className: 'Mage', spec: 'Frost', role: 'ranged', note: 'From Beta', matched: false, isMe: false, nickname: null, guest: true, signupId: 3 };
  const html = (edit) => G.pages.raidSignups.listHtml ? G.pages.raidSignups.listHtml({ raid: { size: 10 }, can: { edit, self: false, seeList: true, seeNicknames: edit }, counts: null, entries: [entry], notices: [], roster: [] }, edit) : '';
  const officer = html(true);
  assert(officer.includes('>Guest<') && officer.includes('Guestmage') && officer.includes('From Beta'));
  assert(officer.includes('data-action="su-guest-remove" data-sid="3"') && officer.includes('Remove the guest Guestmage'));
  assert(!html(false).includes('su-guest-remove'));
});

check('sign-ups panel: Remove on a guest asks the Worker for that sign-up number and draws the new list', withState(async (S) => {
  S.guilds.g1 = gd(OFFICER, 'tbc'); S.currentGid = 'g1';
  S.att.raid = { gid: 'g1', rid: 'u1', data: RAID({}, { id: 'u1', upcoming: true }) };
  S.att.raidSignups = { gid: 'g1', rid: 'u1', status: 'ok', data: { raid: { size: 10 }, can: { edit: true }, entries: [], counts: null, roster: [] }, ui: G.pages.raidSignups.freshUi({ raid: { size: 10 }, can: { edit: true }, entries: [], counts: null, roster: [] }) };
  const s = stub(() => okRes({ raid: { size: 10 }, can: { edit: true }, entries: [], counts: null, roster: [] }));
  G.handlers.click['su-guest-remove'](el({ 'data-sid': '3' }));
  await settle();
  assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/raids/u1/guests/3']]);
  assert.equal(S.att.raidSignups.data.entries.length, 0);
  s.restore();
}));

// ---------------------------------------------------------------------------
// Home, Settings > Teams, the apply page, the browser's names

check('Needs attention: "Upload the log for ..." names the Logger and the page lists the new kind in the Worker\'s order', () => {
  const item = { id: 'log_missing:r1', kind: 'log_missing', severity: 'action', teamId: 't1', teamName: 'Alpha', date: '2027-01-12', loggerName: 'Brenna', link: { name: 'raid', rid: 'r1' } };
  const out = G.pages.attention.itemText ? G.pages.attention.itemText(item) : '';
  assert.match(out, /^Upload the log for .*Jan 12 \(Logger: Brenna\)$/);
  assert.match(G.pages.attention.itemText(Object.assign({}, item, { loggerName: null })), /^Upload the log for [^()]*$/);
});

check('Guild settings > Teams: a launch toggle for a team of a guild that is not WoW Forever; none on Forever (every team has it)', withState(async (S) => {
  const tbc = gd(OFFICER, 'tbc', [Object.assign({}, TEAMS[0], { launchTeam: true })]);
  S.guilds.g1 = tbc; S.currentGid = 'g1';
  const html = G.pages.teams.teamActionsHtml(tbc.teams[0], true);
  assert(html.includes('data-action="team-launch"') && html.includes('aria-pressed="true"') && text(html).includes('Launch on'));
  assert(G.pages.teams.teamActionsHtml(Object.assign({}, TEAMS[0]), true).includes('Launch off'));
  S.guilds.g1 = gd(OFFICER, 'forever');
  assert(!G.pages.teams.teamActionsHtml(TEAMS[0], true).includes('team-launch'));
  // The click marks the team and draws it.
  S.guilds.g1 = gd(OFFICER, 'tbc');
  const s = stub(() => okRes({}));
  G.handlers.click['team-launch'](el({ 'data-team': 't1' }));
  await settle();
  assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/teams/t1/launch', { enabled: true }]]);
  assert.equal(S.guilds.g1.teams[0].launchTeam, true);
  G.handlers.click['team-launch'](el({ 'data-team': 't1' }));
  await settle();
  assert.equal(s.calls[1].body.enabled, false);
  assert.equal(S.guilds.g1.teams[0].launchTeam, undefined);
  s.restore();
}));

check('apply page: a Forever guild is told a surname is welcome', () => {
  const data = (version) => ({ guild: { id: 'g1', name: 'Ravens', realm: 'Normal', realmKind: 'ruleset', region: 'US', gameVersion: version }, teams: [{ id: 't1', name: 'Alpha' }], rosterOptions: null, questions: [], signedInAs: null });
  const html = (version) => G.pages.apply.applyHtml({ state: { gid: 'g1', status: 'ok', data: data(version), draft: {}, busy: false, error: '', done: false } });
  assert(text(html('forever')).includes('a first name, then a surname if it has one'));
  assert(text(html('tbc')).includes('Your character\'s name, 2 to 12 letters.'));
});

check('names in the browser: a Forever guild\'s plans, Gargul winners, TMB and softres names may have a surname; every other version is one word as before', async () => {
  // Plans: the same sanitizer the Worker's plan route mirrors.
  const players = [{ name: 'Thrall Stormrage', group: 1 }, { name: 'Jaina', group: 2 }, { name: 'Too Many Words', group: 3 }, { name: 'thrall stormrage', group: 4 }];
  const forever = G.planSource.sanitize(players, true);
  assert.deepEqual(plain(forever.players.map(p => p.name)), ['Thrall Stormrage', 'Jaina']);
  assert.equal(forever.skipped, 2, 'three words, and a repeat of the first');
  const tbc = G.planSource.sanitize(players);
  assert.deepEqual(plain(tbc.players.map(p => p.name)), ['Jaina']);
  // Gargul: "Name Surname-Realm".
  assert.deepEqual(plain(G.gargul.parseWinner('thrall stormrage-Maladath', true)), { name: 'Thrall Stormrage', realm: 'Maladath' });
  assert.deepEqual(plain(G.gargul.parseWinner('Thrall', true)), { name: 'Thrall', realm: null });
  assert.equal(G.gargul.parseWinner('Thrall Stormrage'), null);
  assert.equal(G.gargul.parseWinner('A B C', true), null);
  const award = { checksum: 'abcd1234', itemID: 28830, timestamp: 1800000000, awardedTo: 'Thrall Stormrage-Maladath' };
  const parsed = G.gargul.parse(JSON.stringify([award]), { surname: true });
  assert.equal(parsed.awards.length, 1);
  assert.equal(parsed.awards[0].winnerName, 'Thrall Stormrage');
  assert.equal(G.gargul.parse(JSON.stringify([award])).awards.length, 0, 'TBC: a space is not a name');
  // TMB and softres.
  assert.equal(G.tmb.displayName('thrall stormrage-Realm', true), 'Thrall Stormrage');
  assert.equal(G.tmb.displayName('thrall stormrage-Realm'), null);
  assert.equal(G.tmb.displayName('thrall-Realm'), 'Thrall');
  const soft = JSON.stringify({ softreserves: [{ name: 'Thrall Stormrage', items: [{ id: 28830 }] }, { name: 'Jaina', items: [28831] }] });
  const withSurname = G.softres.normalize(JSON.parse(soft), { surname: true });
  assert.deepEqual(plain(withSurname.entries.map(e => e.name)), ['Thrall Stormrage', 'Jaina']);
  const without = G.softres.normalize(JSON.parse(soft));
  assert.deepEqual(plain(without.entries.map(e => e.name)), ['Jaina']);
  assert.equal(without.skipped.length, 1);
});

check('guild.css styles the new pieces (funnel, duties line and rows, the paste list and box, the sign-up link rows)', () => {
  for (const cls of ['gs-funnel', 'gs-funnel-row', 'gs-funnel-bar', 'gs-funnel-n', 'gs-duties-line', 'gs-duty-row', 'gs-paste-box', 'gs-paste-list', 'gs-join-rows']) {
    assert(new RegExp('\\.' + cls + '\\b').test(css), cls + ' has a rule');
  }
});

(async () => {
  await run();
  console.log(`\nWave 8 UI tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
