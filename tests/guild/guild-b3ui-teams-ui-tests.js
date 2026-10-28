/**
 * Raidsmith guild UI, lane B3 UI (teams and claims) - tests for the Request team flow, the Team Lead's to-dos on Home and the Roster, the Roster badge, "This is me"
 * on My characters and its officer rows, the Battle.net outcome copy and the not-a-member copy.
 * Run: node tests/guild/guild-b3ui-teams-ui-tests.js
 *
 * Same approach as guild-wave1-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM, the render functions return HTML strings and the handlers run
 * against a stubbed G.api. guild-b3ui-teams-contract-tests.js runs the same pages against the real Worker; the screens were checked in a real browser at 1280 and 390 px.
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

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS, GUILD_MANIFEST } = require('../guild-scripts');
const css = read('guild.css');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
function fakeEl(id, over) {
  const e = Object.assign({ id, textContent: '', hidden: false, innerHTML: '', focus() {} }, over || {});
  els[id] = e;
  return e;
}
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const stripTags = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&middot;/g, '.').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const count = (text, re) => (text.match(re) || []).length;

const HOSTILE = '<img src=x onerror=1>';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
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
const TEAMS = [
  { id: 't1', name: 'Team KJ', size: 25, archived: false, players: 31, trialDays: 14, leads: [{ id: 'u_lead', displayName: 'Leadname' }] },
  { id: 't2', name: 'Sunday Alts', size: 25, archived: false, players: 1, trialDays: 14, leads: [] },
  { id: 't3', name: 'Team Illidan', size: 25, archived: false, players: 27, trialDays: 7, leads: [] },
];
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild' };
const LEAD_CAN = { 'roster.view': 'guild', 'roster.edit': ['t1'], 'raids.view': 'guild', 'attendance.view': ['t1'], 'attendance.review': ['t1'] };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t3'], 'signups.self': ['t3'] };
function gd(can, over, teams) {
  return Object.assign({
    guild: { id: 'g1', name: 'Vindicated', realm: 'Dreamscythe', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'dreamscythe', createdAt: 1 },
    teams: (teams || TEAMS).map(t => Object.assign({}, t)),
    me: { roles: [], can, personId: 'p_me' },
    rosterFlags: {}, teamRequestFlags: {}, attendanceFlags: {},
  }, over || {});
}
const CHAR = (id, name, cls, spec, team, extra) => Object.assign({ id, name, class: cls, mainSpec: spec, offSpec: null, role: 'dps', isMain: false, realm: null, team: team ? { id: team, name: TEAMS.filter(t => t.id === team)[0].name, archived: false } : null }, extra || {});
const MAIN = CHAR('c1', 'Thornwick', 'WARRIOR', 'Protection', 't3', { isMain: true });
const WYNDRA = CHAR('c2', 'Wyndra', 'MAGE', 'Fire', null);
const SELVANE = CHAR('c3', 'Selvane', 'PRIEST', 'Holy', null);
function record(chars, over, canOver) {
  return {
    today: '2026-10-25', can: Object.assign({ edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false }, canOver || {}),
    person: Object.assign({ id: 'p_me', status: 'raider', joinedOn: '2026-09-14', trialStart: null, trialEnd: null, trialFlag: null, isMe: true, version: 3, leftReason: null, leftOn: null,
      discord: { signIn: 'signed_in', user: null, nickname: null }, account: { user: { id: 'u1', displayName: 'Thornwick' }, via: 'link' }, homeTeam: { id: 't3', name: 'Team Illidan' } }, over || {}),
    characters: chars, notes: null,
  };
}
const req = (id, character, team, over) => Object.assign({ id, status: 'pending', note: null, createdAt: Date.now() - 2 * 3600000, decidedAt: null, team: { id: team, name: TEAMS.filter(t => t.id === team)[0].name, archived: false },
  character: Object.assign({ id: 'c_' + id, name: 'Wyndra', class: 'MAGE', mainSpec: 'Fire', startsTrial: false }, character || {}), person: { id: 'p_thorn', name: 'Thornwick' }, requestedBy: null }, over || {});
const bucket = (mine, pending, decide) => ({ mine: mine || [], pending: pending || [], can: { decide: !!decide } });
const personPage = (rec, g, requests) => G.pages.person.personHtml({ guildData: g || gd(MEMBER_CAN), record: rec, linkable: [], alert: '', requests: requests === undefined ? bucket() : requests });
const head = (html) => /<header class="gs-pagehead">[\s\S]*?<\/header>/.exec(html)[0];

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const ApiErr = (status, code, extra) => new ctx.Guild.api.ApiError(status, Object.assign({ error: code, message: 'Server says so.' }, extra || {}));
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null, value: attrs.value }, extra || {});
// A dialog form: the checked radios by name, no buttons.
const formOf = (picks) => ({ querySelector: sel => { const m = /input\[name="(\w+)"\]:checked/.exec(sel); if (m) return picks[m[1]] ? { value: picks[m[1]] } : null; const id = /^#(.+)$/.exec(sel); return id && els[id[1]] ? els[id[1]] : null; }, querySelectorAll: () => [], closest: () => null, elements: {} });

function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, person: S.person, bnet: S.bnet, attention: S.attention, roster: S.roster };
    const savedApp = { requireSignin: ctx.Guild.app.requireSignin, showFailure: ctx.Guild.app.showFailure, render: ctx.Guild.app.render };
    const savedOpen = ctx.Guild.ui.openDialog;
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.person = null; S.bnet = null; S.attention = {}; S.roster = null;
    Object.keys(els).forEach(k => delete els[k]);
    try { await fn(S); } finally { Object.assign(S, saved); Object.assign(ctx.Guild.app, savedApp); ctx.Guild.ui.openDialog = savedOpen; }
  };
}

(async () => {
  // ═══ Request team: the person page ═══════════════════════════════
  await check('Request team: ONE secondary head button on the member\'s own record, only while a character on no team without a request and a team without any of their characters both exist', () => {
    const own = personPage(record([MAIN, WYNDRA, SELVANE]));
    assert(head(own).includes('data-action="team-request-open"') && head(own).includes('<span>Request team</span>') && head(own).includes('aria-label="Request a team for one of your characters"'));
    assert.equal(count(head(own), /gs-btn-molten/g), 0, 'a secondary button: the page has no primary');
    assert.equal(count(own, /data-action="team-request-open"/g), 1, 'one head button, not one per row');
    // no teamless character
    assert(!personPage(record([MAIN, CHAR('c2', 'Wyndra', 'MAGE', 'Fire', 't1')])).includes('team-request-open'));
    // no team left: a character on every team
    const everywhere = [MAIN, CHAR('c2', 'Wyndra', 'MAGE', 'Fire', 't1'), CHAR('c4', 'Dunmar', 'HUNTER', 'Survival', 't2'), WYNDRA];
    assert(!personPage(record(everywhere)).includes('team-request-open'));
    // every teamless character has a request waiting
    const pend = [{ id: 'tq_1', status: 'pending', team: { id: 't1', name: 'Team KJ' }, character: { id: 'c2' } }, { id: 'tq_2', status: 'pending', team: { id: 't2', name: 'Sunday Alts' }, character: { id: 'c3' } }];
    assert(!personPage(record([MAIN, WYNDRA, SELVANE]), null, bucket(pend)).includes('team-request-open'));
    assert(personPage(record([MAIN, WYNDRA, SELVANE]), null, bucket(pend.slice(0, 1))).includes('team-request-open'), 'one is still free to ask');
    // not their own page, and a failed read of the requests (no bucket)
    assert(!personPage(record([MAIN, WYNDRA], { isMe: false })).includes('team-request-open'));
    assert(!personPage(record([MAIN, WYNDRA]), null, null).includes('team-request-open') && !personPage(record([MAIN, WYNDRA]), null, null).includes('No team'));
    // an archived team is not offered
    const archived = TEAMS.map(t => Object.assign({}, t, { archived: t.id !== 't3' }));
    assert(!personPage(record([MAIN, WYNDRA]), gd(MEMBER_CAN, null, archived)).includes('team-request-open'));
  });

  await check('Request team: a character on no team says "No team" or "Requested Team KJ" with Withdraw; an old request for a team the person now holds shows nothing; an officer keeps Edit and More beside', () => {
    const pend = [{ id: 'tq_1', status: 'pending', team: { id: 't1', name: 'Team KJ' }, character: { id: 'c2' } }];
    const out = personPage(record([MAIN, WYNDRA, SELVANE]), null, bucket(pend));
    const chunks = {};
    out.split('<div class="gs-pr-row gs-pr-char" data-cid="').slice(1).forEach(c => { chunks[c.slice(0, c.indexOf('"'))] = c; });
    const row = id => chunks[id].split('<div class="gs-pr-row')[0].split('</section>')[0];
    assert(stripTags(row('c2')).includes('Requested Team KJ') && row('c2').includes('data-action="team-request-withdraw"') && row('c2').includes('data-trid="tq_1"') && row('c2').includes('aria-label="Withdraw the request for Wyndra"'));
    assert(stripTags(row('c3')).includes('No team') && !row('c3').includes('Withdraw'));
    assert(!stripTags(row('c1')).includes('No team') && !stripTags(row('c1')).includes('Requested'), 'a character on a team says its team as before');
    // Wyndra\'s request is for a team the person has since got a character on (another one was approved): the row is back to No team, no Withdraw
    const held = [{ id: 'tq_1', status: 'pending', team: { id: 't3', name: 'Team Illidan' }, character: { id: 'c2' } }];
    const stale = personPage(record([MAIN, WYNDRA]), null, bucket(held));
    assert(stripTags(stale).includes('No team') && !stale.includes('team-request-withdraw'));
    // decided requests are no row text
    assert(!personPage(record([MAIN, WYNDRA]), null, bucket([{ id: 'tq_9', status: 'approved', team: { id: 't1', name: 'Team KJ' }, character: { id: 'c2' } }])).includes('Requested'));
    // an officer on their own record: Request team, then More; Edit stays on the rows
    const officer = personPage(record([MAIN, WYNDRA], null, { edit: true, addCharacter: true }), gd(OFFICER_CAN));
    assert(officer.indexOf('team-request-open') > 0 && officer.indexOf('team-request-open') < officer.indexOf('person-more'), 'Request team sits left of More');
    assert(officer.includes('data-action="char-edit" data-cid="c2"'));
    assertNoRawAttrs(out);
  });

  await check('Request team: the dialog lists the characters that can ask and the teams they can ask for (name and people only - no Team Lead names, no held team); the first of each is picked; one primary', () => {
    const pend = [{ id: 'tq_1', status: 'pending', team: { id: 't1', name: 'Team KJ' }, character: { id: 'c3' } }];
    const html = G.pages.teamRequests.dialogHtml(gd(MEMBER_CAN), record([MAIN, WYNDRA, SELVANE]), pend);
    const t = stripTags(html);
    assert(t.includes('Request a team') && t.includes('A Team Lead of the team decides. You can withdraw the request until then.'));
    assert(t.includes('Wyndra') && t.includes('Fire Mage') && !t.includes('Selvane'), 'Selvane has a request waiting already');
    assert(t.includes('Team KJ 31 people') && t.includes('Sunday Alts 1 person') && !t.includes('Team Illidan'), 'the held team is out; "1 person"');
    assert(!t.includes('Leadname'), 'no Team Lead names (user decision 3)');
    assert.equal(count(html, /type="radio"/g), 3);
    assert(/name="characterId" value="c2" data-field="characterId" checked/.test(html) && /name="teamId" value="t1" data-field="teamId" checked/.test(html), 'the first of each is picked');
    assert.equal(count(html, /gs-btn-molten/g), 1, 'Send request is the one primary');
    assert(html.includes('data-submit="team-request-form"') && html.includes('<span>Cancel</span>') && html.includes('<span>Send request</span>') && html.includes('gs-forge'));
    assert(html.includes('id="dlg-err-characterId"') && html.includes('id="dlg-err-teamId"'));
    assertNoRawAttrs(html);
    const hostile = G.pages.teamRequests.dialogHtml(gd(MEMBER_CAN, null, TEAMS.map(t => Object.assign({}, t, { name: HOSTILE + t.name }))), record([MAIN, CHAR('c2', HOSTILE, 'MAGE', 'Fire', null)]), []);
    assertEscaped(hostile, 'dialog');
  });

  await check('Request team: Request team opens the dialog; Send request POSTs the picked character and team, then reads the requests again; the head and the row change with the answer', withState(async (S) => {
    const g = gd(MEMBER_CAN);
    S.currentGid = 'g1'; S.guilds.g1 = g; S.person = { gid: 'g1', pid: 'p_me', record: record([MAIN, WYNDRA, SELVANE]) };
    S.att.teamRequests = { g1: bucket() };
    let opened = null;
    ctx.Guild.ui.openDialog = (html) => { opened = html; };
    G.handlers.click['team-request-open']();
    assert(opened && opened.includes('data-submit="team-request-form"'));
    // without a pick
    G.handlers.submit['team-request-form'](formOf({}));
    // with one
    const mineAfter = [{ id: 'tq_1', status: 'pending', team: { id: 't1', name: 'Team KJ' }, character: { id: 'c2' } }];
    const s = stub((m, url) => (m === 'post' ? Promise.resolve({ request: mineAfter[0] }) : Promise.resolve({ mine: mineAfter, pending: [], can: { decide: false } })));
    G.handlers.submit['team-request-form'](formOf({ characterId: 'c2', teamId: 't1' }));
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/team-requests', { characterId: 'c2', teamId: 't1' }], ['get', '/api/guild/g1/team-requests', undefined]]);
    assert.deepEqual(plain(G.pages.teamRequests.mineOf('g1')), mineAfter);
    const out = personPage(S.person.record, g, S.att.teamRequests.g1);
    assert(stripTags(out).includes('Requested Team KJ') && out.includes('team-request-open'), 'Selvane can still ask');
    assert(!G.pages.teamRequests.dialogHtml(g, S.person.record, mineAfter).includes('Wyndra'), 'and Wyndra is not offered twice');
  }));

  await check('Request team: a refused request stays in the dialog (409 names the field); Withdraw DELETEs then reads again, with no message; a request decided meanwhile is said on the page', withState(async (S) => {
    const g = gd(MEMBER_CAN);
    S.currentGid = 'g1'; S.guilds.g1 = g; S.person = { gid: 'g1', pid: 'p_me', record: record([MAIN, WYNDRA]) };
    const pend = [{ id: 'tq_1', status: 'pending', team: { id: 't1', name: 'Team KJ' }, character: { id: 'c2' } }];
    S.att.teamRequests = { g1: bucket(pend) };
    fakeEl('dlg-error'); fakeEl('dlg-err-characterId'); fakeEl('dlg-err-teamId');
    const refused = stub(() => Promise.reject(ApiErr(409, 'request_pending', { field: 'characterId', message: 'Wyndra already has a request waiting.' })));
    G.handlers.submit['team-request-form'](formOf({ characterId: 'c2', teamId: 't1' }));
    await settle();
    refused.restore();
    assert.equal(els['dlg-err-characterId'].textContent, 'Wyndra already has a request waiting.');
    assert.equal(S.pageAlert, '', 'nothing on the page');
    const ok = stub((m) => (m === 'del' ? Promise.resolve({ request: { id: 'tq_1', status: 'withdrawn' } }) : Promise.resolve({ mine: [], pending: [], can: { decide: false } })));
    G.handlers.click['team-request-withdraw'](el({ 'data-trid': 'tq_1' }));
    await settle();
    ok.restore();
    assert.deepEqual(ok.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/team-requests/tq_1'], ['get', '/api/guild/g1/team-requests']]);
    assert.deepEqual(plain(G.pages.teamRequests.mineOf('g1')), []);
    assert(stripTags(personPage(S.person.record, g, S.att.teamRequests.g1)).includes('No team'));
    assert.equal(S.pageAlert, '');
    const late = stub((m) => (m === 'del' ? Promise.reject(ApiErr(409, 'request_decided', { message: 'That request was decided already.' })) : Promise.resolve({ mine: [], pending: [], can: { decide: false } })));
    const button = el({ 'data-trid': 'tq_1' });
    G.handlers.click['team-request-withdraw'](button);
    await settle();
    late.restore();
    assert.equal(S.pageAlert, 'That request was decided already.');
    assert.equal(button.disabled, false);
  }));

  // ═══ Roster badge ═════════════════════════════════════════════════
  await check('Roster badge: ONE number, the trials to decide plus the team requests waiting, for the selected team and only for people who can edit it; the Attendance badge no longer counts claims', () => {
    const g = gd(LEAD_CAN, { rosterFlags: { t1: 1 }, teamRequestFlags: { t1: 2 }, pendingClaims: 4, attendanceFlags: { t1: 3 } });
    assert.equal(G.shell.rosterBadge(g, 't1'), 3);
    assert.equal(G.shell.rosterBadge(g, 't3'), 0, 'a team the viewer does not edit');
    assert.equal(G.shell.rosterBadge(gd(MEMBER_CAN, { rosterFlags: { t1: 1 }, teamRequestFlags: { t1: 2 } }), 't1'), 0, 'a member sees none');
    assert.equal(G.shell.rosterBadge(gd(LEAD_CAN, { teamRequestFlags: { t1: 2 } }), 't1'), 2, 'requests alone');
    const nav = G.shell.navItems('g1', LEAD_CAN, G.shell.badgesOf(g, 't1'));
    const roster = nav.find(i => i.key === 'roster');
    const att = nav.find(i => i.key === 'attendance');
    assert.deepEqual([roster.badge, roster.ariaLabel], [3, 'Roster, 1 trial and 2 team requests to decide']);
    assert.deepEqual([att.badge, att.ariaLabel], [3, 'Attendance, 3 flags to review'], 'the 4 pending claims are on Home only');
    assert.equal(G.shell.navItems('g1', LEAD_CAN, G.shell.badgesOf(gd(LEAD_CAN, { rosterFlags: { t1: 2 } }), 't1')).find(i => i.key === 'roster').ariaLabel, 'Roster, 2 trials to decide');
    assert.equal(G.shell.navItems('g1', LEAD_CAN, G.shell.badgesOf(gd(LEAD_CAN, { teamRequestFlags: { t1: 1 } }), 't1')).find(i => i.key === 'roster').ariaLabel, 'Roster, 1 team request to decide');
    assert.equal(G.shell.navItems('g1', LEAD_CAN, 2).find(i => i.key === 'roster').ariaLabel, 'Roster, 2 trials to decide', 'a bare number is trials, as before');
    assert.equal(G.shell.claimsBadge, undefined);
  });

  await check('Roster badge: every mutation reply that carries teamRequestFlags refreshes the badge; reading the requests recounts them per team', withState(async (S) => {
    S.guilds.g1 = gd(LEAD_CAN, { teamRequestFlags: { t1: 2 } });
    G.app.applyFlags('g1', { teamRequestFlags: { t1: 1 } });
    assert.deepEqual(plain(S.guilds.g1.teamRequestFlags), { t1: 1 });
    G.app.applyFlags('g1', { ok: true });
    assert.deepEqual(plain(S.guilds.g1.teamRequestFlags), { t1: 1 }, 'a reply without them leaves them');
    const s = stub(() => Promise.resolve({ mine: [], pending: [req('tq_1', null, 't1'), req('tq_2', { name: 'Pellan' }, 't1')], can: { decide: true } }));
    await G.pages.teamRequests.read('g1');
    s.restore();
    assert.deepEqual(plain(S.guilds.g1.teamRequestFlags), { t1: 2 });
    assert.equal(G.pages.teamRequests.pendingOf('g1', 't1').length, 2);
    assert.equal(G.pages.teamRequests.pendingOf('g1', 't2').length, 0);
    const failing = stub(() => Promise.reject(ApiErr(500, 'boom')));
    assert.equal(await G.pages.teamRequests.read('g1'), null, 'a failed read answers null and never rejects');
    failing.restore();
    assert.equal(G.pages.teamRequests.bucketOf('g1'), null);
  }));

  // ═══ Home ═════════════════════════════════════════════════════════
  const ATTN = (items, over) => Object.assign({ today: '2026-10-27', total: items.length, items, more: {} }, over || {});
  const item = (kind, over) => Object.assign({ id: kind + ':1', kind, severity: 'action', teamId: 't1', teamName: 'Team KJ' }, over || {});
  const homeHtml = (data, extra, g) => G.pages.attention.attentionHtml(Object.assign({ guildData: g || gd(LEAD_CAN), data, now: Date.now() }, extra || {}));
  const claim = (id, name, cls, over) => Object.assign({ id, character: { name, realm: 'Dreamscythe', class: cls, level: null }, claimedAt: Date.now() - 3 * 3600000, claimant: { id: 'u9', displayName: 'Ravenna' },
    plan: { kind: 'link_person', reason: null, message: null, person: { id: 'p_x', name }, defaultTeamId: null, canDecide: true, record: { mainSpec: 'Frost', status: 'raider', team: { id: 't1', name: 'Team KJ' } } } }, over || {});

  await check('Home: a team request is a to-do row with Approve / Reject (who asks, spec, from whom, how long ago, the trial it starts), under a gold-count head; the count item steps aside', () => {
    const items = [item('team_requests', { id: 'team_requests:t1', count: 2, link: { name: 'teamrequests' } }), item('no_loot', { date: '2026-10-25' })];
    const pending = [req('tq_1', null, 't1'), req('tq_2', { name: 'Pellan', class: 'SHAMAN', mainSpec: 'Enhancement', startsTrial: true }, 't3', { person: { id: 'p_m', name: 'Marlowe' } })];
    const out = homeHtml(ATTN(items), { requests: pending }, gd(OFFICER_CAN));
    const t = stripTags(out);
    assert.equal(count(out, /gs-tr-hsl">Team requests <span class="gs-fg-cnt">2<\/span>/g), 2, 'desktop Guild panel and phone To do, one head each');
    assert.equal(count(out, /data-action="team-request-approve"/g), 4, 'two rows, desktop and phone');
    assert(t.includes('Wyndra asks to join') && t.includes('Fire Mage') && t.includes('From Thornwick') && t.includes('2 h ago'));
    assert(t.includes('Pellan asks to join') && t.includes('Enhancement Shaman') && t.includes('From Marlowe') && t.includes('Approving starts a 7-day trial.'), 'Team Illidan\'s trial is 7 days');
    assert(!t.includes('Approving starts a 14-day trial.'), 'only the character that starts one says so');
    assert(out.includes('aria-label="Approve Wyndra for Team KJ"') && out.includes('aria-label="Reject Pellan for Team Illidan"') && out.includes('data-trid="tq_2"') && out.includes('data-ctx="home"') && out.includes('data-gid="g1"'));
    assert(!t.includes('team requests waiting'), 'the count line is replaced by the rows');
    assert(out.includes('href="#/g/g1/roster/p/p_thorn"') || /href="#\/g\/g1\/[^"]*p_thorn"/.test(out), 'From links the person');
    const keys = out.match(/data-key="tr-approve-[^"]+"/g);
    assert.equal(new Set(keys).size, keys.length, 'desktop and phone keys differ');
    assert.equal(count(out, /gs-btn-molten/g), 0 + count(out, /gs-btn-molten/g), 'Home has its own primaries');
    assertNoRawAttrs(out);
    // the read failed or nothing was read: the count line stays and opens the Roster
    const fallback = stripTags(homeHtml(ATTN(items), { requests: null }, gd(OFFICER_CAN)));
    assert(fallback.includes('2 team requests waiting') && !fallback.includes('asks to join'));
    assert.equal(G.pages.attention.itemText({ kind: 'team_requests', count: 1 }), '1 team request waiting');
    assert(G.pages.attention.KINDS.some(k => k.id === 'team_requests'));
    assertEscaped(homeHtml(ATTN(items), { requests: [req('tq_3', { name: HOSTILE }, 't1', { person: { id: 'p_h', name: HOSTILE } })] }, gd(OFFICER_CAN)), 'home rows');
  });

  await check('Home: a "This is me" ask names the account, the character in its class colour, the record and what approving does; claims that cannot be approved in one click stay a count line', () => {
    const asks = [claim('cl_1', 'Marrowind', 'MAGE'), claim('cl_2', 'Duskwhisper', 'ROGUE', { claimant: { id: 'u8', displayName: 'Kestrel' }, plan: { kind: 'link_person', canDecide: true, record: { mainSpec: 'Subtlety', status: 'trial', team: { id: 't2', name: 'Sunday Alts' } } } })];
    const items = [item('claims', { id: 'claims', count: 4, teamId: null, teamName: null, link: { name: 'review' } })];
    const out = homeHtml(ATTN(items), { asks }, gd(OFFICER_CAN));
    const t = stripTags(out);
    assert(out.includes('gs-tr-hsl">This is me <span class="gs-fg-cnt">2</span>'));
    assert(t.includes('Ravenna says Marrowind is theirs') && t.includes('Frost Mage - Raider') && t.includes('3 h ago. Approving links this record to Ravenna\'s account.'));
    assert(t.includes('Kestrel says Duskwhisper is theirs') && t.includes('Subtlety Rogue - Trial') && t.includes('Sunday Alts'), 'the record team on top');
    assert(out.includes('data-action="this-is-me-approve"') && out.includes('data-claim="cl_1"') && out.includes('aria-label="Approve: Marrowind is Ravenna&#39;s"') && out.includes('aria-label="Reject: Marrowind is Ravenna&#39;s"'));
    assert(/gs-char-name gs-class-mage">Marrowind/.test(out) && !/gs-class-\w+">Ravenna/.test(out), 'class colour on the character only; the account name is neutral');
    assert(t.includes('2 character claims are waiting'), '4 claims, 2 shown as rows: the rest stay a line that opens the Review queue');
    const all = stripTags(homeHtml(ATTN(items.map(i => Object.assign({}, i, { count: 2 }))), { asks }, gd(OFFICER_CAN)));
    assert(!all.includes('character claims are waiting') && !all.includes('character claim is waiting'), 'every claim is a row: no line');
    assert(stripTags(homeHtml(ATTN(items), { asks: null }, gd(OFFICER_CAN))).includes('4 character claims are waiting'), 'no rows read: the line as before');
    assert.deepEqual(G.pages.thisIsMe.asksOf([claim('a', 'A', 'MAGE'), claim('b', 'B', 'MAGE', { plan: { kind: 'add_alt', canDecide: true } }), claim('c', 'C', 'MAGE', { plan: { kind: 'link_person', canDecide: false } }), claim('d', 'D', 'MAGE', { plan: { kind: 'blocked', canDecide: false, reason: 'taken' } })]).map(c => c.id), ['a']);
    assertEscaped(homeHtml(ATTN(items), { asks: [claim('cl_3', HOSTILE, 'MAGE', { claimant: { id: 'u7', displayName: HOSTILE } })] }, gd(OFFICER_CAN)), 'asks');
    assertNoRawAttrs(out);
  });

  await check('Home: the two kinds sit in the Guild panel and the phone To do panel, with "Nothing to do." only when there is neither', () => {
    const none = stripTags(homeHtml(ATTN([]), {}, gd(OFFICER_CAN)));
    assert(none.includes('Nothing to do.'));
    const out = homeHtml(ATTN([item('team_requests', { id: 'team_requests:t1', count: 1 })]), { requests: [req('tq_1', null, 't1')] }, gd(OFFICER_CAN));
    const side = /<section class="gs-hd-panel gs-hd-side" aria-label="Guild">[\s\S]*?<\/section>/.exec(out)[0];
    assert(side.includes('gs-tr-ask') && !stripTags(side).includes('Nothing to do.'));
    const phone = /<section class="gs-hd-todosec" aria-label="To do">[\s\S]*?<\/section>/.exec(out)[0];
    assert(phone.includes('gs-tr-ask') && phone.includes('gs-hd-listpanel') && !stripTags(phone).includes('Nothing to do.'));
  });

  await check('Home: Approve POSTs, drops the row at once, reads the to-dos again and says it; a refusal is the page error and the list is read again; Reject and the "This is me" pair work the same', withState(async (S) => {
    const g = gd(OFFICER_CAN);
    S.currentGid = 'g1'; S.guilds.g1 = g;
    const items = [item('team_requests', { id: 'team_requests:t1', count: 2 })];
    const pending = [req('tq_1', null, 't1'), req('tq_2', { name: 'Pellan' }, 't1')];
    S.att.teamRequests = { g1: bucket([], pending, true) };
    S.att.attention = { gid: 'g1', data: ATTN(items), refreshing: false, error: '' };
    fakeEl('attn-status');
    const rows = () => G.pages.teamRequests.pendingOf('g1').map(r => r.id);
    let s = stub((m, url) => {
      if (m === 'post') return Promise.resolve({ request: { id: 'tq_1', status: 'approved' }, personId: 'p_thorn', teamRequestFlags: { t1: 1 } });
      if (url.endsWith('/attention')) return Promise.resolve(ATTN([item('team_requests', { id: 'team_requests:t1', count: 1 })]));
      return Promise.resolve({ mine: [], pending: [pending[1]], can: { decide: true } });
    });
    await G.handlers.click['team-request-approve'](el({ 'data-trid': 'tq_1', 'data-gid': 'g1', 'data-ctx': 'home' }));
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['post', '/api/guild/g1/team-requests/tq_1/approve'], ['get', '/api/guild/g1/attention'], ['get', '/api/guild/g1/team-requests']]);
    assert.deepEqual(rows(), ['tq_2']);
    assert.deepEqual(plain(S.guilds.g1.teamRequestFlags), { t1: 1 }, 'the Roster badge follows the reply');
    assert.equal(S.att.attention.data.items[0].count, 1);
    assert.equal(els['attn-status'].textContent, 'Approved Wyndra for Team KJ.');
    // Reject
    s = stub((m, url) => (m === 'post' ? Promise.resolve({ request: { id: 'tq_2', status: 'rejected' }, teamRequestFlags: { t1: 0 } }) : url.endsWith('/attention') ? Promise.resolve(ATTN([])) : Promise.resolve({ mine: [], pending: [], can: { decide: true } })));
    await G.handlers.click['team-request-reject'](el({ 'data-trid': 'tq_2', 'data-gid': 'g1', 'data-ctx': 'home' }));
    await settle();
    s.restore();
    assert.equal(s.calls[0].url, '/api/guild/g1/team-requests/tq_2/reject');
    assert.equal(els['attn-status'].textContent, 'Rejected Pellan.');
    assert.deepEqual(rows(), []);
    // a refusal: decided by someone else meanwhile
    S.att.teamRequests = { g1: bucket([], [pending[0]], true) };
    const button = el({ 'data-trid': 'tq_1', 'data-gid': 'g1', 'data-ctx': 'home' });
    s = stub((m, url) => (m === 'post' ? Promise.reject(ApiErr(409, 'request_decided', { message: 'That request was decided already.' })) : url.endsWith('/attention') ? Promise.resolve(ATTN([])) : Promise.resolve({ mine: [], pending: [], can: { decide: true } })));
    await G.handlers.click['team-request-approve'](button);
    await settle();
    s.restore();
    assert.equal(S.att.attention.error, 'That request was decided already.');
    assert.equal(S.att.attention.errorTitle, 'Could not decide that');
    assert.equal(button.disabled, false);
    assert.deepEqual(rows(), [], 'the next read says it is gone');
    // "This is me": Approve sends what the page saw
    S.att.attention.error = '';
    S.att.thisIsMeAsks = { g1: { all: [claim('cl_1', 'Marrowind', 'MAGE')], asks: [claim('cl_1', 'Marrowind', 'MAGE')] } };
    s = stub((m, url) => (m === 'post' ? Promise.resolve({ claim: { id: 'cl_1', status: 'approved' }, outcome: 'link_person', personId: 'p_x', rosterFlags: {}, pendingClaims: 0 }) : Promise.resolve(ATTN([]))));
    await G.handlers.click['this-is-me-approve'](el({ 'data-claim': 'cl_1', 'data-gid': 'g1' }));
    await settle();
    s.restore();
    assert.deepEqual([s.calls[0].m, s.calls[0].url, s.calls[0].body], ['post', '/api/guild/g1/claims/cl_1/approve', { expectedKind: 'link_person' }]);
    assert.equal(els['attn-status'].textContent, 'Approved: Marrowind.');
    assert.deepEqual(G.pages.thisIsMe.asksFor('g1').asks, []);
    S.att.thisIsMeAsks = { g1: { all: [claim('cl_2', 'Duskwhisper', 'ROGUE')], asks: [claim('cl_2', 'Duskwhisper', 'ROGUE')] } };
    s = stub(() => Promise.resolve({ claim: { id: 'cl_2', status: 'rejected' }, pendingClaims: 0 }));
    await G.handlers.click['this-is-me-reject'](el({ 'data-claim': 'cl_2', 'data-gid': 'g1' }));
    await settle();
    s.restore();
    assert.equal(s.calls[0].url, '/api/guild/g1/claims/cl_2/reject');
    assert.equal(els['attn-status'].textContent, 'Rejected: Duskwhisper.');
  }));

  await check('Home: load() reads the rows beside the to-dos only when an item says something waits; a failed read keeps the count line', withState(async (S) => {
    const g = gd(OFFICER_CAN);
    S.guilds.g1 = g; S.currentGid = 'g1';
    const items = [item('team_requests', { id: 'team_requests:t1', count: 1 }), item('claims', { id: 'claims', count: 1, teamId: null })];
    let s = stub((m, url) => (url.endsWith('/attention') ? Promise.resolve(ATTN(items)) : url.endsWith('/team-requests') ? Promise.resolve({ mine: [], pending: [req('tq_1', null, 't1')], can: { decide: true } }) : Promise.resolve({ claims: [claim('cl_1', 'Marrowind', 'MAGE')] })));
    await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, g);
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/attention', '/api/guild/g1/team-requests', '/api/guild/g1/claims']);
    const out = G.pages.attention.main({}, g, {});
    assert(out.includes('data-action="team-request-approve"') && out.includes('data-action="this-is-me-approve"'));
    s = stub(() => Promise.resolve(ATTN([item('no_loot', { date: '2026-10-25' })])));
    await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, g);
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/attention'], 'nothing waits: no extra reads');
    s = stub((m, url) => (url.endsWith('/attention') ? Promise.resolve(ATTN(items)) : Promise.reject(ApiErr(500, 'boom'))));
    await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, g);
    s.restore();
    const line = stripTags(G.pages.attention.main({}, g, {}));
    assert(line.includes('1 team request waiting') && line.includes('1 character claim is waiting') && !line.includes('asks to join'));
  }));

  // ═══ Roster ═══════════════════════════════════════════════════════
  const person = (id, name, cls, spec, status, extra) => Object.assign({ id, status: status || 'raider', raidRole: 'melee', altCount: 0, isMe: false, trialFlag: null,
    shown: { id: 'ch_' + id, name, class: cls, mainSpec: spec, role: 'melee' }, main: { id: 'ch_' + id, name, team: { id: 't1', name: 'Team KJ' } } }, extra || {});
  const PEOPLE = [person('p_a', 'Sablewind', 'ROGUE', 'Combat'), person('p_b', 'Emra', 'ROGUE', 'Combat', 'trial', { trialFlag: { kind: 'ends', days: 2 } })];
  const rosterHtml = (extra, g, canEdit) => G.pages.roster.rosterHtml(Object.assign({ guildData: g || gd(LEAD_CAN), data: { people: PEOPLE, team: { id: 't1', name: 'Team KJ', archived: false }, can: { edit: canEdit !== false } }, view: { status: 'active', query: '' },
    shape: { status: 'loading' }, apps: null }, extra || {}));

  await check('Roster: Needs you holds the team requests of this team as the same rows (above the trial line); a phone has them as the first block of the list', () => {
    const pending = [req('tq_1', null, 't1'), req('tq_2', { name: 'Pellan', startsTrial: true }, 't1')];
    const out = rosterHtml({ requests: pending });
    const needs = /<section class="gs-hd-panel gs-rs-needs has-requests" aria-label="Needs you">[\s\S]*?<\/section>/.exec(out)[0];
    assert(needs.includes('<h2 class="gs-fg-lbl">Needs you</h2>') && needs.includes('gs-rs-needcol'));
    assert.equal(count(needs, /data-action="team-request-approve"/g), 2);
    assert(needs.indexOf('gs-tr-ask') < needs.indexOf('gs-rs-needlist') && stripTags(needs).includes('trial ends in 2 days'), 'requests, then the trial line');
    assert(!stripTags(needs).includes('Team KJ'), 'the panel is the team: no team on the row');
    assert(needs.includes('data-ctx="roster"') && needs.includes('Approving starts a 14-day trial.'));
    const phone = /<div class="gs-rs-phone">[\s\S]*$/.exec(out)[0];
    assert(phone.indexOf('gs-rs-preq') >= 0 && phone.indexOf('gs-rs-preq') < phone.indexOf('gs-rs-plist'), 'the requests lead the phone list');
    assert(/gs-rs-preq" aria-label="Team requests"><h2 class="gs-hd-sl gs-rs-pgroup">Team requests <span class="gs-fg-cnt">2<\/span>/.test(phone));
    assert(phone.includes('Needs a decision'), 'the trial still has its group');
    assert(/data-key="tr-approve-p[^"]*"/.test(phone) && /data-key="tr-approve-d[^"]*"/.test(needs), 'desktop and phone keys differ');
    assert.equal(count(out, /gs-hd-chip is-rose/g) >= 1, true, 'the trial keeps its rose chip');
    // nothing else, no panel
    assert(!rosterHtml({ requests: [] }, null).includes('has-requests') && !rosterHtml({ requests: [] }).includes('gs-rs-preq'));
    // a member decides nothing; an applicants segment on a phone has no request block; an archived team has no panel
    assert(!rosterHtml({ requests: pending }, gd(MEMBER_CAN), false).includes('team-request-approve'));
    assert(!/gs-rs-phone">[\s\S]*gs-rs-preq/.test(rosterHtml({ requests: pending, view: { status: 'applicants', query: '' } })));
    assert(!rosterHtml({ requests: pending, data: { people: PEOPLE, team: { id: 't1', name: 'Team KJ', archived: true }, can: { edit: true } } }).includes('team-request-approve'));
    // with only requests (no trial, no application) the panel is still there
    const only = rosterHtml({ requests: pending, data: { people: [PEOPLE[0]], team: { id: 't1', name: 'Team KJ', archived: false }, can: { edit: true } } });
    assert(only.includes('has-requests') && !only.includes('gs-rs-needlist'));
    assertEscaped(rosterHtml({ requests: [req('tq_3', { name: HOSTILE }, 't1')] }), 'roster rows');
    assertNoRawAttrs(out);
  });

  await check('Roster: Approve drops the row, reads the list again and says it; Reject only says it; a refusal is the page alert', withState(async (S) => {
    const g = gd(LEAD_CAN);
    S.currentGid = 'g1'; S.guilds.g1 = g; S.roster = { gid: 'g1', teamId: 't1', data: { people: PEOPLE, team: { id: 't1', name: 'Team KJ' }, can: { edit: true } } };
    S.att.teamRequests = { g1: bucket([], [req('tq_1', null, 't1'), req('tq_2', { name: 'Pellan' }, 't1')], true) };
    fakeEl('roster-status');
    let s = stub((m, url) => (m === 'post' ? Promise.resolve({ request: { id: 'tq_1', status: 'approved' }, teamRequestFlags: { t1: 1 } }) : Promise.resolve({ people: PEOPLE, team: { id: 't1', name: 'Team KJ' }, can: { edit: true } })));
    await G.handlers.click['team-request-approve'](el({ 'data-trid': 'tq_1', 'data-gid': 'g1', 'data-ctx': 'roster' }));
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.m + ' ' + c.url.replace(/\?.*$/, '')), ['post /api/guild/g1/team-requests/tq_1/approve', 'get /api/guild/g1/roster']);
    assert.deepEqual(G.pages.teamRequests.pendingOf('g1').map(r => r.id), ['tq_2']);
    assert.equal(els['roster-status'].textContent, 'Approved Wyndra for Team KJ.');
    s = stub(() => Promise.resolve({ request: { id: 'tq_2', status: 'rejected' }, teamRequestFlags: { t1: 0 } }));
    await G.handlers.click['team-request-reject'](el({ 'data-trid': 'tq_2', 'data-gid': 'g1', 'data-ctx': 'roster' }));
    await settle();
    s.restore();
    assert.equal(s.calls.length, 1, 'a rejection changes no list');
    assert.equal(els['roster-status'].textContent, 'Rejected Pellan.');
    S.att.teamRequests = { g1: bucket([], [req('tq_3', null, 't1')], true) };
    s = stub((m) => (m === 'post' ? Promise.reject(ApiErr(409, 'team_taken', { message: 'Thornwick already has a character on Team KJ.' })) : Promise.resolve({ mine: [], pending: [], can: { decide: true } })));
    await G.handlers.click['team-request-approve'](el({ 'data-trid': 'tq_3', 'data-gid': 'g1', 'data-ctx': 'roster' }));
    await settle();
    s.restore();
    assert.equal(S.pageAlert, 'Thornwick already has a character on Team KJ.');
  }));

  // ═══ This is me: My characters ════════════════════════════════════
  const bnetGuild = (over) => Object.assign({ guildId: 'g1', guildName: 'Ashen Watch', gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', realmKind: 'realm', supportLabel: 'TBC Anniversary', status: 'not_linked', message: null, onRoster: false, battlenetOnly: false, characters: [] }, over || {});
  const bnetData = (over) => Object.assign({ configured: true, link: null, guilds: [bnetGuild()] }, over || {});
  const LINK = { battletag: 'Ravenna#2210', linkedAt: 1, fetchedAt: 1760000000000, expiresAt: 1762600000000 };
  const chars = (data, extra) => G.pages.bnet.charactersHtml(Object.assign({ data }, extra || {}));
  const M1 = { name: 'Marrowind', class: 'MAGE', mainSpec: 'Frost', realm: 'Dreamscythe', team: { id: 't1', name: 'Team KJ' } };
  const M2 = { name: 'Marrowyn', class: 'PRIEST', mainSpec: 'Holy', realm: null, team: { id: 't2', name: 'Sunday Alts' } };

  await check('This is me: the "Find your character on the roster" block opens each card of a guild that takes a typed name - with Battle.net not connected, not set up or connected; an in-game guild says Battle.net only', withState(async () => {
    const off = chars(bnetData());
    assert(off.includes('aria-label="Find your character on the roster"') && off.includes('id="tim-name-g1"') && off.includes('data-input="tim-search"') && off.includes('data-submit="tim-search"'), 'not connected');
    assert(stripTags(off).includes('Connect Battle.net to see your characters') && stripTags(off).includes('Ashen Watch'), 'the invitation stays, the card follows');
    assert(stripTags(off).includes('Characters on the roster that nobody has linked yet. An officer confirms it is you.'));
    assert(chars(bnetData({ configured: false })).includes('id="bnet-not-set-up"') && chars(bnetData({ configured: false })).includes('data-input="tim-search"'), 'not set up on the server');
    const linked = chars(bnetData({ link: LINK, guilds: [bnetGuild({ status: 'ok', characters: [{ name: 'Oakmender', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'DRUID', level: 70, state: 'new', claim: null, claimable: true }] })] }));
    assert(linked.indexOf('data-input="tim-search"') < linked.indexOf('Oakmender'), 'the block is above the Battle.net list');
    const ingame = chars(bnetData({ link: LINK, guilds: [bnetGuild({ guildName: 'Vindicated', battlenetOnly: true, status: 'ok' })] }));
    assert(!ingame.includes('data-input="tim-search"') && stripTags(ingame).includes('Vindicated adds characters from Battle.net only.'));
    const ingameOff = chars(bnetData({ guilds: [bnetGuild({ guildName: 'Vindicated', battlenetOnly: true })] }));
    assert(!ingameOff.includes('tim-search') && !ingameOff.includes('Vindicated adds characters'), 'not connected: an in-game guild has no card of its own');
    assertNoRawAttrs(off + linked);
  }));

  await check('This is me: the results are the roster records (class-coloured name, spec class and team) with This is me; a name nobody has offers a new character; the waiting list has Needs an officer and Withdraw', withState(async (S) => {
    const s0 = G.pages.thisIsMe.stateOf('g1');
    Object.assign(s0, { query: 'Marrow', status: 'ready', matches: [M1, M2], more: false, waiting: [] });
    const block = G.pages.thisIsMe.blockHtml(bnetGuild());
    const t = stripTags(block);
    assert(t.includes('Find your character on the roster') && t.includes('Marrowind Frost Mage - Team KJ') && t.includes('Marrowyn Holy Priest - Sunday Alts') && !t.includes('Waiting for an officer'));
    assert.equal(count(block, /data-action="tim-claim"/g), 2);
    assert(block.includes('aria-label="This is me: Marrowind"') && block.includes('data-class="MAGE"') && block.includes('data-spec="Frost"') && block.includes('data-realm="Dreamscythe"'));
    assert(/gs-char-name gs-class-mage">Marrowind/.test(block), 'class colour on the name');
    assert(block.includes('value="Marrow"'));
    s0.more = true;
    assert(stripTags(G.pages.thisIsMe.blockHtml(bnetGuild())).includes('There are more. Type more of the name.'));
    // no match
    Object.assign(s0, { query: 'Zzqx', status: 'ready', matches: [], more: false });
    const none = G.pages.thisIsMe.blockHtml(bnetGuild());
    assert(stripTags(none).includes('Nobody on the roster by that name. Add it as a new character:') && none.includes('id="tim-class-g1"') && none.includes('data-action="tim-add"') && none.includes('<option value="DRUID">Druid</option>'));
    // not enough letters / loading / an error draw no results
    Object.assign(s0, { query: 'M', status: 'idle' });
    assert.equal(G.pages.thisIsMe.resultsHtml('g1', s0), '');
    Object.assign(s0, { query: 'Marrow', status: 'loading' });
    assert(stripTags(G.pages.thisIsMe.resultsHtml('g1', s0)).includes('Looking'));
    // waiting
    Object.assign(s0, { query: '', status: 'ready', matches: [], waiting: [Object.assign({ id: 'cl_1' }, M1)] });
    const waiting = G.pages.thisIsMe.blockHtml(bnetGuild());
    assert(waiting.indexOf('Waiting for an officer') < waiting.indexOf('Find your character on the roster'.toUpperCase() === '' ? '' : 'Find your character on the roster</h3>'), 'waiting leads');
    assert(stripTags(waiting).includes('Marrowind Frost Mage - Team KJ Needs an officer Withdraw') && waiting.includes('aria-label="Withdraw the request for Marrowind"') && waiting.includes('data-claim="cl_1"'));
    // the name waiting is not "nobody"
    Object.assign(s0, { query: 'Marrowind', status: 'ready', matches: [] });
    assert(!stripTags(G.pages.thisIsMe.resultsHtml('g1', s0)).includes('Nobody on the roster'));
    // hostile text is escaped and no raw attributes
    Object.assign(s0, { query: HOSTILE, status: 'ready', matches: [Object.assign({}, M1, { name: HOSTILE, team: { id: 't1', name: HOSTILE } })], waiting: [Object.assign({ id: 'cl_9' }, M1, { name: HOSTILE })] });
    const hostile = G.pages.thisIsMe.blockHtml(bnetGuild({ guildId: 'g1' }));
    assertEscaped(hostile, 'tim');
    assertNoRawAttrs(hostile + waiting + none);
  }));

  await check('This is me: This is me POSTs the record\'s name, class, spec and realm to /me/characters, then the page says an officer has to confirm it and the row waits; Withdraw DELETEs the claim; Add character adds at once', withState(async (S) => {
    S.bnet = { data: bnetData(), notice: '', alert: '' };
    const st0 = G.pages.thisIsMe.stateOf('g1');
    Object.assign(st0, { query: 'Marrow', status: 'ready', matches: [M1], waiting: [] });
    let s = stub((m, url, body) => {
      if (m === 'post') return Promise.resolve({ claims: [{ name: 'Marrowind', status: 'pending', outcome: 'needs_officer', reason: 'link_person', id: 'cl_1' }] });
      if (url === '/auth/bnet') return Promise.resolve(bnetData());
      return Promise.resolve({ matches: [], more: false, waiting: [Object.assign({ id: 'cl_1' }, M1)] });
    });
    const button = el({ 'data-gid': 'g1', 'data-name': 'Marrowind', 'data-class': 'MAGE', 'data-spec': 'Frost', 'data-realm': 'Dreamscythe' });
    await G.handlers.click['tim-claim'](button);
    await settle();
    s.restore();
    assert.deepEqual([s.calls[0].m, s.calls[0].url, s.calls[0].body], ['post', '/api/guild/g1/me/characters', { name: 'Marrowind', class: 'MAGE', mainSpec: 'Frost', realm: 'Dreamscythe' }]);
    assert.deepEqual(s.calls.slice(1).map(c => c.url), ['/api/guild/g1/roster/unlinked', '/auth/bnet'], 'the waiting list and the Battle.net list are read again');
    assert.equal(S.bnet.notice, 'Marrowind is on the roster and nobody has linked it, so an officer has to confirm it is yours. Nothing changes until one does.');
    assert.deepEqual(plain(st0.waiting.map(w => [w.id, w.name])), [['cl_1', 'Marrowind']]);
    assert.equal(st0.query, '', 'the field is empty again');
    // Withdraw
    s = stub((m, url) => (m === 'del' ? Promise.resolve({ ok: true }) : url === '/auth/bnet' ? Promise.resolve(bnetData()) : Promise.resolve({ matches: [], more: false, waiting: [] })));
    await G.handlers.click['tim-withdraw'](el({ 'data-gid': 'g1', 'data-claim': 'cl_1', 'data-name': 'Marrowind' }));
    await settle();
    s.restore();
    assert.deepEqual([s.calls[0].m, s.calls[0].url], ['del', '/api/guild/g1/claims/cl_1']);
    assert.deepEqual(plain(st0.waiting), []);
    assert.equal(S.bnet.notice, '', 'no message: the row going away is the answer');
    // Add character: no class chosen asks for one, a class POSTs the typed name and adds at once
    Object.assign(st0, { query: 'Zzqx', status: 'ready', matches: [] });
    fakeEl('tim-class-g1', { value: '' });
    fakeEl('tim-error-g1');
    fakeEl('tim-results-g1');
    const add = el({ 'data-gid': 'g1' });
    s = stub(() => Promise.resolve({}));
    await G.handlers.click['tim-add'](add);
    s.restore();
    assert.equal(s.calls.length, 0);
    assert.equal(st0.error, 'Choose the class of Zzqx.');
    st0.error = '';
    els['tim-class-g1'].value = 'DRUID';
    s = stub((m, url) => (m === 'post' ? Promise.resolve({ claims: [{ name: 'Zzqx', status: 'applied', outcome: 'new_person', personId: 'p_n' }] }) : url === '/auth/bnet' ? Promise.resolve(bnetData()) : Promise.resolve({ matches: [], more: false, waiting: [] })));
    await G.handlers.click['tim-add'](add);
    await settle();
    s.restore();
    assert.deepEqual([s.calls[0].m, s.calls[0].url, s.calls[0].body], ['post', '/api/guild/g1/me/characters', { name: 'Zzqx', class: 'DRUID' }]);
    assert.equal(S.bnet.notice, 'Added Zzqx to your characters.');
    // a refusal is said in the block, with the button back
    const refused = el({ 'data-gid': 'g1', 'data-name': 'Marrowind', 'data-class': 'MAGE', 'data-spec': '', 'data-realm': '' });
    s = stub(() => Promise.reject(ApiErr(409, 'name_taken', { message: 'Marrowind is on a roster entry that belongs to someone else.' })));
    await G.handlers.click['tim-claim'](refused);
    await settle();
    s.restore();
    assert.equal(refused.disabled, false);
    assert.equal(st0.error, 'Marrowind is on a roster entry that belongs to someone else.');
  }));

  await check('This is me: typing asks after a pause (two letters or more); a short name asks nothing; the results are painted in place; a failed look-up is said under the field', withState(async () => {
    const st0 = G.pages.thisIsMe.stateOf('g1');
    st0.query = ''; st0.status = 'idle'; st0.matches = []; st0.waiting = []; st0.error = '';
    const host = fakeEl('tim-results-g1');
    fakeEl('tim-error-g1');
    let s = stub(() => Promise.resolve({ matches: [M1], more: false, waiting: [] }));
    const input = (value) => el({ 'data-gid': 'g1' }, { value });
    G.handlers.input['tim-search'](input('M'));
    await new Promise(r => setTimeout(r, 450));
    assert.equal(s.calls.length, 0, 'one letter asks nothing');
    G.handlers.input['tim-search'](input('Mar'));
    G.handlers.input['tim-search'](input('Marr'));
    await new Promise(r => setTimeout(r, 450));
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/roster/unlinked?q=Marr'], 'one request after the pause, for what was typed last');
    assert(host.innerHTML.includes('Marrowind') && host.innerHTML.includes('data-action="tim-claim"'));
    s = stub(() => Promise.reject(ApiErr(429, 'rate_limited', { message: 'You have looked up a lot of names. Wait a few minutes and try again.' })));
    G.handlers.input['tim-search'](input('Marro'));
    await new Promise(r => setTimeout(r, 450));
    s.restore();
    assert.equal(st0.error, 'You have looked up a lot of names. Wait a few minutes and try again.');
    assert.equal(host.innerHTML, '', 'no stale results under an error');
    // Enter in the field asks at once
    s = stub(() => Promise.resolve({ matches: [], more: false, waiting: [] }));
    G.handlers.submit['tim-search']({ getAttribute: () => 'g1', elements: { name: { value: 'Zz' } } });
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/roster/unlinked?q=Zz']);
  }));

  await check('Battle.net outcomes (board 7): Add, Needs an officer with its reason, and a notice per outcome; the intro says characters go on your profile at once', () => {
    const rows = [
      { name: 'Oakheart', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'DRUID', level: 70, state: 'new', claim: null, claimable: true },
      { name: 'Dunmar', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'HUNTER', level: 70, state: 'taken', claim: { id: 'cl_1', status: 'pending' }, claimable: false },
      { name: 'Quillbane', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'ROGUE', level: 70, state: 'on_roster', claim: { id: 'cl_2', status: 'pending' }, claimable: false },
    ];
    const out = chars(bnetData({ link: LINK, guilds: [bnetGuild({ status: 'ok', characters: rows })] }));
    const t = stripTags(out);
    assert(t.includes('Add the characters that are yours. They go on your profile at once.') && !t.includes('officers approve each claim'));
    assert(out.includes('aria-label="Add Oakheart"') && out.includes('aria-label="Withdraw the request for Dunmar"'));
    assert(/Needs an officer\s*<\/span>\s*<span class="gs-bnet-why">On another account/.test(out.replace(/<svg[\s\S]*?<\/svg>/g, '')) || t.includes('Needs an officer On another account'), t);
    assert(t.includes('Needs an officer On a different roster entry than yours'));
    const note = G.pages.bnet.claimNotice;
    assert.equal(note('Selvane', { status: 'applied', outcome: 'add_alt' }), 'Added Selvane to your characters.');
    assert.equal(note('Marrowind', { status: 'applied', outcome: 'link_person' }), 'Added Marrowind. It was on the roster already and is linked to you now.');
    assert.equal(note('Dunmar', { status: 'pending', outcome: 'needs_officer', reason: 'other_person' }), 'Dunmar is on a different roster entry than yours, so an officer has to decide. Nothing changes until one does.');
    assert.equal(note('Dunmar', { status: 'pending', outcome: 'needs_officer', reason: 'hand_added' }), 'Dunmar is on someone else\'s record, so an officer has to decide. Nothing changes until one does.');
    assert.equal(note('Dunmar', { status: 'failed', reason: 'changed' }), 'Dunmar changed while you were adding it. Try again.');
  });

  await check('This is me: the read that opens the page fails quietly (the block still works); after a decision the keyboard goes to the next ask, else the page title', withState(async () => {
    const st0 = G.pages.thisIsMe.stateOf('g1');
    st0.error = ''; st0.query = ''; st0.waiting = [];
    const s = stub(() => Promise.reject(ApiErr(500, 'boom', { message: 'Something broke.' })));
    await G.pages.thisIsMe.loadFor(bnetData());
    s.restore();
    assert.equal(st0.error, '', 'no error text for the waiting read');
    assert(G.pages.thisIsMe.blockHtml(bnetGuild()).includes('data-input="tim-search"'));
    // focus after a decision
    const focused = [];
    const node = (visible, name) => ({ offsetParent: visible ? {} : null, focus: () => focused.push(name) });
    const realQuery = ctx.document.querySelectorAll;
    ctx.document.querySelectorAll = () => [node(false, 'hidden desktop copy'), node(true, 'visible ask'), node(true, 'second ask')];
    G.pages.teamRequests.focusAfterDecision();
    assert.deepEqual(focused, ['visible ask']);
    ctx.document.querySelectorAll = () => [];
    fakeEl('page-title', { focus: () => focused.push('title') });
    G.pages.teamRequests.focusAfterDecision();
    assert.deepEqual(focused, ['visible ask', 'title']);
    ctx.document.querySelectorAll = realQuery;
  }));

  // ═══ copy and files ═══════════════════════════════════════════════
  await check('copy: Away says where to find your roster entry (no officer to link you); Privacy says how an account becomes yours; the new files are ASCII, in the manifest in order', () => {
    const away = G.pages.away.awayHtml ? null : null;
    const src = read('js/guild/pages-away.js') + read('js/guild/pages-privacy.js');
    assert(!/Ask an officer to link your account/.test(src) && !/an officer can link your account/.test(src) && !/whose account an officer has linked/.test(src));
    const files = ['js/guild/pages-team-requests.js', 'js/guild/pages-this-is-me.js', 'worker/routes/roster-unlinked.js'];
    for (const f of files) assert(!/[^\x00-\x7f]/.test(read(f).split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')), f + ' is ASCII outside its comments');
    for (const f of files.slice(0, 2)) {
      const text = read(f);
      assert(!/\bstyle=/.test(text.replace(/\/\/.*$/gm, '')) && !/\bon(click|change|input|submit)=/i.test(text), f + ': no inline style or handler');
      assert(GUILD_MANIFEST.includes('/' + f), f + ' is in the manifest');
    }
    const order = GUILD_MANIFEST;
    assert(order.indexOf('/js/guild/pages-team-requests.js') < order.indexOf('/js/guild/pages-roster.js'), 'before the Roster, which registers its hook when it loads');
    assert(order.indexOf('/js/guild/pages-this-is-me.js') < order.indexOf('/js/guild/pages-attention.js') && order.indexOf('/js/guild/pages-team-requests.js') < order.indexOf('/js/guild/pages-attention.js'));
    assert(!/team_requests/.test(read('tests/guild/guild-wave4-ui-tests.js').split('\n').filter(l => /ATTENTION_KINDS = /.test(l)).join('\n').replace(/team_requests \(lane B3[^;]*;/, '')), 'the sync check no longer exempts team_requests');
  });

  await check('guild.css: every gs-tr- / gs-tim- class the new pages draw has a rule; tokens only (no colour literal) in the block; the phone query has no space; hit areas 44 px on a phone', () => {
    const block = css.slice(css.indexOf('/* ── Team requests and "This is me"'), css.indexOf('/* ── Raids list on Forge'));
    assert(block.length > 1500, 'the block is there');
    assert(!/#[0-9a-fA-F]{3,8}\b/.test(block) && !/rgba?\(/.test(block), 'no colour literal');
    assert(!/@media \(max-width: 600px\)/.test(block) && /@media \(max-width:600px\)/.test(block), 'the phone query is written without a space');
    const used = new Set();
    for (const f of ['js/guild/pages-team-requests.js', 'js/guild/pages-this-is-me.js']) for (const m of read(f).matchAll(/\b(gs-(?:tr|tim)-[a-z0-9-]+)/g)) used.add(m[1]);
    used.add('gs-rs-needcol'); used.add('gs-rs-preq'); used.add('gs-bnet-why');
    for (const c of used) assert(css.includes('.' + c), c + ' has a rule');
    assert(/\.gs-tr-line \.gs-fg-u \{[^}]*padding: 14px 0/.test(block), 'the From link reaches 44 px on a phone');
    assert(/\.gs-tr-row, \.gs-tim-row \{ min-height: 56px; \}/.test(block));
    assert(/gs-rs-needs\.has-requests/.test(block));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
