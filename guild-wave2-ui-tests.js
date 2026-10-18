/**
 * Raidsmith guild UI, PM wave 2 (raid sizes, the sign-up deadline, date-only raids) - tests for Team settings (the team's raid size and the
 * Add team select), Settings > Raid schedule (the "Close sign-ups ... hours before the start" field), the Raids list (zone and size, "18 / 20 signed
 * up", "time not set", the deadline beside Sign up, the Raid size select of New raid), the raid page (the title, "Time not set", the officers'
 * Raid settings card) and the Sign-ups panel ("Expected", the Open until / Closed pill, the deadline sentence and the 409 it answers with).
 * PM wave 2, part 3: standing sign-ups (Raids page card, Skip this week), the published roster (officers' Roster card, Your group, the Raids list chip) and the Needs attention line.
 * PM wave 2, part 2: the Away notices page, the officers' card and person section, and Standby / away notices in the Sign-ups panel and the Raids list.
 * Run: node guild-wave2-ui-tests.js
 *
 * Same approach as guild-signups-ui-tests.js and guild-wave1-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render
 * functions return HTML strings and the handlers run against a stubbed G.api and a fake document. The mock data follows the Worker contract of
 * the wave (tasks/guild-pm-wave2-spec.md, sections B1 to B3); guild-wave1-contract-tests.js and guild-signups-contract-tests.js run the same
 * pages against the real Worker.
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
const { GUILD_SCRIPTS, guildScriptsOf } = require('./tests/guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
// A fake document: elements are registered by id so the handlers' error-slot writes and focus calls can be read back.
let els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
function fakeEl(id, over) {
  const e = Object.assign({ id, value: '', textContent: '', hidden: false, focused: 0, attrs: {}, focus() { e.focused++; }, select() { e.selected = true; }, setAttribute(k, v) { e.attrs[k] = v; } }, over || {});
  els[id] = e;
  return e;
}
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const ws = s => String(s).replace(/[  ]/g, ' '); // newer ICU writes a narrow no-break space before AM / PM

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
const OFFICER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'roster.edit': 'guild', 'signups.self': ['t1'] };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'signups.self': ['t1'] };
const TEAMS = [
  { id: 't1', name: 'Team KJ', size: 20, archived: false, players: 3, leads: [] },
  { id: 't2', name: 'Weekend team', size: 40, archived: false, players: 1, leads: [] },
];
function gd(can, over, zone) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: zone || 'America/Chicago', gameVersion: 'forever', realmKind: 'ruleset', realmSlug: null, createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({}, t)),
    me: { roles: [], can },
    attendanceFlags: {},
  }, over || {});
}

const STARTS = Date.UTC(2026, 9, 25, 1, 0); // Sat Oct 24 2026, 20:00 in Chicago (CDT)
const HOUR = 3600000;
const NOON_UTC = Date.UTC(2026, 9, 24, 12, 0); // the placeholder start of a date-only raid
const DETAIL = (over, rover) => Object.assign({
  raid: Object.assign({
    id: 'u1', team: { id: 't1', name: 'Team KJ' }, teamId: 't1', raidOn: '2026-10-24', startsAt: STARTS, timeKnown: true, upcoming: true, title: 'Prog night', zone: 'Hyjal Summit', size: 20, sizeOverride: null,
    closesAt: STARTS, closeHours: 0, closeHoursOverride: null, signupsLocked: false, state: 'awaiting_log', openFlags: 0, stale: false, version: 1,
  }, rover || {}),
  can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
  sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [],
}, over || {});

const CHAR_PRIEST = { id: 'c_eli', name: 'Eliora', class: 'PRIEST', mainSpec: 'Holy', offSpec: 'Discipline', isMain: true, teamId: 't1', specs: ['Holy', 'Discipline', 'Shadow'] };
function entry(over) {
  return Object.assign({
    key: 'p:p_x', personId: 'p_x', source: 'raidsmith', kind: 'signed', name: 'Thoren', classId: 'PALADIN', className: 'Paladin', spec: 'Protection', role: 'tank',
    characterId: 'c_th', note: null, updatedAt: 1, matched: true, isMe: false, nickname: null,
  }, over || {});
}
const COUNTS = { signed: 17, late: 1, tentative: 1, bench: 1, absence: 1, expected: 18, byRole: { tank: 1, healer: 1, melee: 2, ranged: 1, none: 0 }, byClass: { PALADIN: 1, PRIEST: 1 } };
const VIEW_RAID = (over) => Object.assign({ id: 'u1', teamId: 't1', startsAt: STARTS, timeKnown: true, upcoming: true, locked: false, closed: null, closesAt: STARTS, closeHours: 0, closeHoursOverride: null, size: 20, sizeOverride: null }, over || {});
function view(over, raidOver) {
  return Object.assign({
    raid: VIEW_RAID(raidOver),
    can: { edit: false, self: true, seeList: true, seeNicknames: false },
    me: { personId: 'p_e', signup: entry({ key: 'p:p_e', personId: 'p_e', name: 'Eliora', classId: 'PRIEST', isMe: true, characterId: 'c_eli' }), characters: [CHAR_PRIEST], defaultCharacterId: 'c_eli', canChange: true, closed: null },
    counts: COUNTS,
    entries: [entry()],
    roster: null,
  }, over || {});
}
const state = (v, over) => Object.assign({ gid: 'g1', rid: 'u1', status: 'ok', data: v, ui: G.pages.raidSignups.freshUi(v) }, over || {});
const panel = (v, opts) => G.pages.raidSignups.panelHtml(Object.assign({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: state(v) }, opts || {}));

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
    els = {};
    const savedTeamFor = ctx.Guild.app.teamFor;
    try { await fn(S); } finally { Object.assign(S, saved); ctx.Guild.app.teamFor = savedTeamFor; els = {}; }
  };
}
// The open raid page: the attendance state bag holds the detail and the panel's state.
function openRaid(S, v, can, detail) {
  S.guilds.g1 = gd(can || MEMBER_CAN); S.currentGid = 'g1';
  S.att.raid = { gid: 'g1', rid: 'u1', data: detail || DETAIL(), filter: null };
  S.att.raidSignups = state(v);
  return S.att.raidSignups;
}
class ApiErr extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.body = extra || {}; Object.assign(this, extra || {}); }
}
// A form control the handlers read and focus.
const control = (value) => ({ value, focused: 0, attrs: {}, focus() { this.focused++; }, setAttribute(k, v) { this.attrs[k] = v; } });

(async () => {
  // ═══ 1. Team settings ═══════════════════════════════════════════
  await check('Teams: the list and the phone cards say each team\'s size ("20-man"); only guild.teams gets a Size button', () => {
    const out = G.pages.teams.teamsHtml({ guildData: gd(OFFICER_CAN), alert: '' });
    assert(out.includes('<td>20-man</td>') && out.includes('<td>40-man</td>'), 'the table');
    assert(out.includes('20-man - 3 players') && out.includes('40-man - 1 player'), 'the cards');
    assert(/data-action="team-size" data-team="t1" data-key="size-t1" aria-label="Change the raid size of Team KJ">Size<\/button>/.test(out));
    assert.equal(out.split('data-action="team-size"').length - 1, 4, 'two teams, a table row and a card each');
    const member = G.pages.teams.teamsHtml({ guildData: gd({ 'guild.access': 'guild' }), alert: '' });
    assert(member.includes('20-man') && !member.includes('team-size') && !member.includes('team-rename'));
    assertNoRawAttrs(out);
    assertEscaped(G.pages.teams.teamsHtml({ guildData: gd(OFFICER_CAN, { teams: [{ id: 't"x', name: HOSTILE + QUOTES, size: 25, archived: false, players: 1, leads: [] }] }) }), 'team size button');
  });

  await check('Team dialogs: Add team has a Raid size select (10 / 20 / 25 / 40, 25 chosen); the Size dialog starts at the team\'s size; Rename has no select', () => {
    const add = G.pages.teams.teamDialogHtml('add', null, 'g1');
    assert(add.includes('data-mode="add"') && add.includes('id="dlg-team-name"') && add.includes('<label class="gs-label" for="dlg-team-size">Raid size</label>'));
    assert.deepEqual(optionsOf(add, 'dlg-team-size'), [
      { value: '10', selected: false, label: '10-man' }, { value: '20', selected: false, label: '20-man' },
      { value: '25', selected: true, label: '25-man' }, { value: '40', selected: false, label: '40-man' }]);
    assert(add.includes('id="dlg-err-size" role="alert" hidden') && add.includes('aria-describedby="dlg-team-size-help"'));
    const size = G.pages.teams.teamDialogHtml('size', TEAMS[0], 'g1');
    assert(size.includes('data-mode="size"') && size.includes('data-team="t1"') && size.includes('Raid size of Team KJ') && !size.includes('id="dlg-team-name"'));
    assert.deepEqual(optionsOf(size, 'dlg-team-size').filter(o => o.selected).map(o => o.value), ['20']);
    assert(size.includes('>Save</button>') && add.includes('>Add team</button>'));
    const rename = G.pages.teams.teamDialogHtml('rename', TEAMS[0], 'g1');
    assert(rename.includes('Rename Team KJ') && rename.includes('id="dlg-team-name"') && !rename.includes('dlg-team-size'));
    // A team whose stored size is none of the four (nothing stopped one before) has to pick.
    const odd = optionsOf(G.pages.teams.teamDialogHtml('size', Object.assign({}, TEAMS[0], { size: 15 }), 'g1'), 'dlg-team-size');
    assert.deepEqual(odd[0], { value: '', selected: true, label: 'Choose a size' });
    assert.equal(odd.length, 5);
    assertEscaped(G.pages.teams.teamDialogHtml('size', Object.assign({}, TEAMS[0], { name: HOSTILE + QUOTES }), HOSTILE + QUOTES), 'size dialog');
    assertNoRawAttrs(size);
  });

  await check('Team dialogs: the buttons open the Size dialog for that team (an unknown team opens nothing)', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html, o) => { opened.push({ html, o }); return null; };
    fakeEl('dlg-team-size');
    G.handlers.click['team-size'](el({ 'data-team': 't2' }));
    G.handlers.click['team-size'](el({ 'data-team': 't_nobody' }));
    G.handlers.click['team-add'](el({}));
    G.ui.openDialog = realOpen;
    assert.equal(opened.length, 2);
    assert(opened[0].html.includes('Raid size of Weekend team') && opened[0].o.labelledBy === 'dlg-title');
    assert(opened[1].html.includes('Add team'));
    assert.equal(els['dlg-team-size'].focused, 1, 'focus starts on the select');
  }));

  await check('Team form: Add sends the name and the size; the Size dialog sends only { size }; the same size sends nothing; a bad size never leaves the browser', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    ['dlg-team-name-error', 'dlg-err-size', 'dlg-error'].forEach(id => fakeEl(id, { hidden: true }));
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf;
    let closed = 0;
    G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => { closed++; };
    const form = (mode, name, size) => ({
      getAttribute: k => ({ 'data-gid': 'g1', 'data-mode': mode, 'data-team': 't1' }[k] ?? null),
      elements: Object.assign({}, mode !== 'size' ? { name: control(name) } : {}, mode !== 'rename' ? { size: control(size) } : {}),
    });
    // Add.
    let s = stub((m) => Promise.resolve({ team: { id: 't3', name: 'Alts', size: 10, archived: false } }));
    G.handlers.submit['team-form'](form('add', '  Alts ', '10'));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/teams', { name: 'Alts', size: 10 }]]);
    assert.deepEqual(plain(S.guilds.g1.teams[2]), { players: 0, leads: [], id: 't3', name: 'Alts', size: 10, archived: false });
    assert.equal(closed, 1);
    s.restore();
    // Size.
    s = stub((m, url, body) => Promise.resolve({ team: { id: 't1', name: 'Team KJ', size: body.size, archived: false } }));
    G.handlers.submit['team-form'](form('size', '', '40'));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['patch', '/api/guild/g1/teams/t1', { size: 40 }]]);
    assert.equal(S.guilds.g1.teams[0].size, 40, 'the list now says 40-man');
    assert.equal(S.guilds.g1.teams[0].players, 3, 'the rest of the row is kept');
    assert.equal(closed, 2);
    s.calls.length = 0;
    G.handlers.submit['team-form'](form('size', '', '40'));
    await settle();
    assert.equal(s.calls.length, 0, 'the team is 40-man already');
    assert.equal(closed, 3);
    // Not a size.
    const bad = form('size', '', '');
    G.handlers.submit['team-form'](bad);
    assert.equal(s.calls.length, 0);
    assert.equal(els['dlg-err-size'].textContent, 'Choose a size.');
    assert.equal(els['dlg-err-size'].hidden, false);
    assert.equal(bad.elements.size.focused, 1);
    // Rename keeps sending only the name.
    s.restore();
    s = stub(() => Promise.resolve({ team: { id: 't1', name: 'Renamed', size: 40, archived: false } }));
    G.handlers.submit['team-form'](form('rename', 'Renamed'));
    await settle();
    assert.deepEqual(s.calls.map(c => c.body), [{ name: 'Renamed' }]);
    s.restore();
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
  }));

  await check('Team form: the Worker\'s 400 for the size is shown next to the select; a taken name stays on the name; other errors go to the dialog', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    ['dlg-team-name-error', 'dlg-err-size', 'dlg-error'].forEach(id => fakeEl(id, { hidden: true }));
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf;
    G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => {};
    const f = control('20');
    const form = { getAttribute: k => ({ 'data-gid': 'g1', 'data-mode': 'size', 'data-team': 't1' }[k] ?? null), elements: { size: f } };
    let s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'size is 10, 20, 25 or 40.', field: 'size' })));
    f.value = '25';
    G.handlers.submit['team-form'](form);
    await settle();
    assert.equal(els['dlg-err-size'].textContent, 'size is 10, 20, 25 or 40.');
    assert.equal(els['dlg-error'].hidden, true);
    assert.equal(f.attrs['aria-invalid'], 'true');
    assert.equal(f.focused, 1);
    assert.equal(S.guilds.g1.teams[0].size, 20, 'nothing changed');
    s.restore();
    s = stub(() => Promise.reject(new ApiErr(500, 'error', { message: 'Something went wrong. Try again in a moment.' })));
    G.handlers.submit['team-form'](form);
    await settle();
    assert.equal(els['dlg-error'].textContent, 'Something went wrong. Try again in a moment.');
    s.restore();
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
  }));

  // ═══ 2. Settings > Raid schedule ════════════════════════════════
  const SCHED = (over) => Object.assign({
    team: { id: 't1', name: 'Team KJ', archived: false },
    slots: [{ id: 'ts_a', weekday: 2, startTime: '20:00', zone: 'Hyjal Summit', title: 'Prog' }],
    weeks: 2, auto: false, signupCloseHours: 24, can: { edit: true }, timeZone: 'America/Chicago', zones: ['Barrow Deeps', 'Hyjal Summit', 'Onyxia\'s Lair'],
  }, over || {});
  const schedState = (data, over) => Object.assign({ gid: 'g1', teamId: 't1', data, draft: G.pages.settingsSchedule.draftFrom(data), error: '', closeError: '', note: '', busy: false }, over || {});
  const schedPage = (s, can) => G.pages.settingsSchedule.scheduleHtml({ guildData: gd(can || OFFICER_CAN), s });

  await check('schedule page: "Close sign-ups" is a labelled number field 0 to 72 with a one-line hint, after the weeks and the auto box; no field when the Worker sent none', () => {
    const out = schedPage(schedState(SCHED()));
    assert(out.includes('<label class="gs-label" for="sched-close">Close sign-ups this many hours before the start</label>'));
    assert(/<input class="gs-input gs-sched-hours" type="number" id="sched-close" data-input="sched-close" data-key="sched-close" min="0" max="72" step="1" inputmode="numeric" autocomplete="off" value="24" aria-describedby="sched-close-hint">/.test(out));
    assert(out.includes('id="sched-close-hint">Members can change their sign-up until then. 0 = until the raid starts (72 at most).'));
    assert(out.includes('id="sched-close-error" role="alert" hidden'));
    assert(out.indexOf('id="sched-auto"') < out.indexOf('id="sched-close"') && out.indexOf('id="sched-close"') < out.indexOf('Save schedule'));
    assert(/id="sched-close"[^>]*value="0"/.test(schedPage(schedState(SCHED({ signupCloseHours: 0 })))), '0 is a value, not an empty field');
    assert(!schedPage(schedState(SCHED({ signupCloseHours: undefined }))).includes('sched-close'), 'an older Worker: no field');
    assertNoRawAttrs(out);
  });

  await check('schedule page: the field\'s value and validation - whole hours 0 to 72; the body carries a number; no field, no key', () => {
    const H = G.pages.settingsSchedule;
    assert.equal(H.draftFrom(SCHED()).signupCloseHours, '24');
    assert.equal(H.draftFrom(SCHED({ signupCloseHours: undefined })).signupCloseHours, null);
    const body = H.bodyOf(H.draftFrom(SCHED({ signupCloseHours: 6 })));
    assert.deepEqual(plain(body), { slots: [{ weekday: 2, startTime: '20:00', zone: 'Hyjal Summit', title: 'Prog' }], weeks: 2, auto: false, signupCloseHours: 6 });
    assert.equal(typeof body.signupCloseHours, 'number');
    assert.equal(H.bodyOf(H.draftFrom(SCHED({ signupCloseHours: 0 }))).signupCloseHours, 0, '0 is sent');
    assert(!('signupCloseHours' in H.bodyOf(H.draftFrom(SCHED({ signupCloseHours: undefined })))), 'a Worker that sent none is not sent one');
    for (const ok of ['0', '1', '24', '72', ' 5 ', '07']) assert.equal(H.closeProblemOf({ signupCloseHours: ok }), '', ok);
    for (const bad of ['', '  ', '73', '100', '-1', '1.5', '2e1', 'abc', '+3']) assert(/^Enter whole hours from 0 to 72/.test(H.closeProblemOf({ signupCloseHours: bad })), JSON.stringify(bad));
    assert.equal(H.closeProblemOf({ signupCloseHours: null }), '');
  });

  await check('schedule page: typing updates the draft; Save sends the number with the schedule; an out-of-range value never leaves the browser and shows the field error', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const sc = S.att.settingsSchedule = schedState(SCHED());
    G.handlers.input['sched-close'](el({}, { value: '12' }));
    assert.equal(sc.draft.signupCloseHours, '12');
    let s = stub(() => Promise.resolve(SCHED({ signupCloseHours: 12 })));
    G.handlers.submit['sched-form']();
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['put', '/api/guild/g1/teams/t1/schedule']]);
    assert.equal(s.calls[0].body.signupCloseHours, 12);
    assert.equal(S.att.settingsSchedule.draft.signupCloseHours, '12');
    assert.equal(S.att.settingsSchedule.note, '', 'the page head says Saved at; there is no banner');
    assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'schedule');
    // Zero is a real answer.
    G.handlers.input['sched-close'](el({}, { value: '0' }));
    s.calls.length = 0;
    G.handlers.submit['sched-form']();
    await settle();
    assert.equal(s.calls[0].body.signupCloseHours, 0);
    s.restore();
    // Out of range.
    s = stub(() => Promise.resolve(SCHED()));
    G.handlers.input['sched-close'](el({}, { value: '99' }));
    G.handlers.submit['sched-form']();
    assert.equal(s.calls.length, 0);
    assert(/^Enter whole hours from 0 to 72/.test(S.att.settingsSchedule.closeError));
    assert.equal(S.att.settingsSchedule.error, '', 'not the form-wide message');
    const out = schedPage(S.att.settingsSchedule);
    assert(/id="sched-close"[^>]*value="99" aria-invalid="true" aria-describedby="sched-close-hint sched-close-error"/.test(out));
    assert(/id="sched-close-error" role="alert">Enter whole hours from 0 to 72/.test(out));
    // Blank is not 0.
    G.handlers.input['sched-close'](el({}, { value: '' }));
    G.handlers.submit['sched-form']();
    assert.equal(s.calls.length, 0);
    assert(S.att.settingsSchedule.closeError);
    s.restore();
  }));

  await check('schedule page: the Worker\'s 400 for the deadline is the field\'s own error; any other 400 stays the form\'s message; changing team clears it', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.settingsSchedule = schedState(SCHED());
    let s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'signupCloseHours is a whole number of hours from 0 to 72.', field: 'signupCloseHours' })));
    G.handlers.submit['sched-form']();
    await settle();
    assert.equal(S.att.settingsSchedule.closeError, 'signupCloseHours is a whole number of hours from 0 to 72.');
    assert.equal(S.att.settingsSchedule.error, '');
    assert.equal(S.att.settingsSchedule.busy, false);
    assert(schedPage(S.att.settingsSchedule).includes('role="alert">signupCloseHours is a whole number of hours from 0 to 72.</p>'));
    s.restore();
    s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'Pick a zone from the list.', field: 'slots', index: 0, slotField: 'zone' })));
    G.handlers.submit['sched-form']();
    await settle();
    assert.equal(S.att.settingsSchedule.error, 'Slot 1: Pick a zone from the list.');
    assert.equal(S.att.settingsSchedule.closeError, '', 'the field is fine this time');
    s.restore();
    s = stub(() => Promise.resolve(SCHED({ signupCloseHours: 3 })));
    S.att.settingsSchedule.closeError = 'old';
    G.handlers.change['sched-team'](el({}, { value: 't1' }));
    await settle();
    assert.equal(S.att.settingsSchedule.closeError, '');
    assert.equal(S.att.settingsSchedule.draft.signupCloseHours, '3');
    s.restore();
  }));

  // ═══ 3. The Raids list ═══════════════════════════════════════════
  const UP = (over) => Object.assign({
    id: 'u1', raidOn: '2026-10-24', startsAt: STARTS, timeKnown: true, upcoming: true, zone: 'Hyjal Summit', size: 20, sizeOverride: null, title: null, eventSourced: false, eventId: null, otherServer: false,
    signups: { signed: 17, late: 1, bench: 2, tentative: 1, absence: 1 }, locked: false, signupsOpen: true, closesAt: STARTS, closeHours: 0, mine: null, planned: false, planLive: null,
  }, over || {});
  const LIST = (over) => Object.assign({
    team: { id: 't1', name: 'Team KJ', archived: false, size: 20, signupCloseHours: 0 }, today: '2026-10-17', can: { edit: false, signup: true }, schedule: null, hasMore: false,
    upcoming: [UP()], raids: [],
  }, over || {});
  const listPage = (data, can, over, zone) => ws(G.pages.raids.raidsHtml(Object.assign({ guildData: gd(can || MEMBER_CAN, null, zone), teamId: 't1', data, tab: 'upcoming' }, over || {})));
  const PAST = (over) => Object.assign({ id: 'r9', raidOn: '2026-10-10', startsAt: 1, timeKnown: true, upcoming: false, zone: 'Barrow Deeps', size: 10, sizeOverride: null, bosses: { kills: 2, pulls: 3 }, sources: { event: false, reports: 1, plan: false }, counts: null, openFlags: 0, state: 'reviewed', stale: false }, over || {});

  await check('Raids list: the event cell says "zone - size"; no zone is "20-player"; a title comes first; an older reply without a size shows the zone only', () => {
    const out = listPage(LIST({ upcoming: [UP(), UP({ id: 'u2', zone: null, size: 20 }), UP({ id: 'u3', title: 'Prog night', zone: 'Onyxia\'s Lair', size: 40 }), UP({ id: 'u4', size: undefined })] }));
    // One markup is the table and the phone card (below 760 px a row is a card; each cell carries its label).
    assert(out.includes('<td class="" data-label="Raid">Hyjal Summit - 20</td>'), 'the cell');
    assert(out.includes('<td class="" data-label="Raid">20-player</td>'), 'no zone');
    assert(out.includes('<td class="" data-label="Raid"><span class="gs-ev-title">Prog night</span> &middot; Onyxia&#39;s Lair - 40</td>') || out.includes('<td class="" data-label="Raid"><span class="gs-ev-title">Prog night</span> &middot; Onyxia\'s Lair - 40</td>'), 'a title first');
    assert(out.includes('<td class="" data-label="Raid">Hyjal Summit</td>'), 'no size: as before');
    assert.equal(G.pages.raids.zoneSizeText('Hyjal Summit', 20), 'Hyjal Summit - 20');
    assert.equal(G.pages.raids.zoneSizeText(null, 10), '10-player');
    assert.equal(G.pages.raids.zoneSizeText('', undefined), '');
    assertNoRawAttrs(out);
    assertEscaped(listPage(LIST({ upcoming: [UP({ zone: HOSTILE + QUOTES, title: HOSTILE + QUOTES })] })), 'event cell');
  });

  await check('Raids list: a date-only raid says "time not set" (muted) and never a made-up 12:00; a timed raid keeps its time', () => {
    const dateOnly = listPage(LIST({ upcoming: [UP({ timeKnown: false, startsAt: NOON_UTC })] }));
    assert(/<a class="gs-raid-link" href="#\/g\/g1\/raids\/r\/u1">Sat Oct 24<\/a> <span class="gs-muted gs-time-unset">time not set<\/span>/.test(dateOnly), 'the date is the row link, and says the time is not set');
    assert(!/12:00|7:00 AM|\bAM\b|\bPM\b/.test(stripTags(dateOnly)), 'no time at all: ' + stripTags(dateOnly));
    const timed = listPage(LIST());
    assert(timed.includes('>Sat Oct 24, 8:00 PM CT</a>') && !timed.includes('time not set'));
    const unknown = listPage(LIST({ upcoming: [UP({ timeKnown: undefined })] }));
    assert(unknown.includes('Sat Oct 24, 8:00 PM') && !unknown.includes('time not set'), 'an older reply is read as timed');
    const W = G.pages.raids.whenText;
    assert.equal(ws(W({ raidOn: '2026-10-24', startsAt: STARTS, timeKnown: true }, gd(MEMBER_CAN))), 'Sat Oct 24, 8:00 PM CT');
    assert.equal(W({ raidOn: '2026-10-24', startsAt: NOON_UTC, timeKnown: false }, gd(MEMBER_CAN)), 'Sat Oct 24');
    assert.equal(G.pages.raids.timeNotSetHtml({ timeKnown: true }), '');
  });

  await check('Raids list: the count is "expected / size signed up" with the old breakdown after it; late counts as signed up; no size keeps the old words', () => {
    const T = G.pages.raids.signupsText;
    assert.equal(T({ signed: 17, late: 1, bench: 2, tentative: 1, absence: 1 }, 20), '18 / 20 signed up, 2 bench, 1 tentative, 1 can\'t come');
    assert.equal(T({ signed: 3, late: 0, bench: 0, tentative: 0, absence: 0 }, 10), '3 / 10 signed up');
    assert.equal(T({ signed: 0, late: 0, bench: 0, tentative: 2, absence: 0 }, 25), '0 / 25 signed up, 2 tentative');
    assert.equal(T({ signed: 0, late: 0, bench: 0, tentative: 0, absence: 0 }, 20), 'No sign-ups yet');
    assert.equal(T({ signed: 21, late: 2, bench: 2, tentative: 0, absence: 1 }), '23 signed, 2 bench, 1 can\'t come', 'no size: as before');
    assert.equal(T(null, 20), '-');
    assert.equal(T({ signed: 4, late: 1, bench: 0, tentative: 0, absence: 0, expected: 7 }, 20), '7 / 20 signed up', 'a Worker that sends expected is believed');
    const out = listPage(LIST());
    assert(out.includes('<td class="" data-label="Sign-ups">18 / 20 signed up, 2 bench, 1 tentative, 1 can&#39;t come</td>'));
    assert(!listPage(LIST({ can: { edit: false, signup: false }, upcoming: [UP({ signups: null })] })).includes('signed up'), 'a viewer who may not see counts gets none');
  });

  await check('Raids list: the deadline beside Sign up - "Sign-ups close Fri 8:00 PM" in the guild\'s time zone while open and a deadline is set; "Sign-ups closed" and no button when closed', () => {
    const open = listPage(LIST({ upcoming: [UP({ closeHours: 24, closesAt: STARTS - 24 * HOUR })] }));
    assert(open.includes('<span class="gs-fine">Sign-ups close Fri 8:00 PM CT</span>'), open.slice(open.indexOf('Your sign-up')));
    assert.equal(open.split('Sign-ups close Fri 8:00 PM').length - 1, 1, 'one row (it is the phone card too)');
    assert(/data-action="raids-signup" data-rid="u1"/.test(open) && open.indexOf('data-action="raids-signup"') < open.indexOf('Sign-ups close'), 'the button, then the deadline');
    // The guild's zone decides, not the browser's.
    const auckland = listPage(LIST({ upcoming: [UP({ closeHours: 24, closesAt: STARTS - 24 * HOUR })] }), MEMBER_CAN, null, 'Pacific/Auckland');
    assert(auckland.includes('Sign-ups close Sat 2:00 PM') && !auckland.includes('Fri 8:00 PM'));
    // Already signed up: still told when it closes (they may change it).
    const signed = listPage(LIST({ upcoming: [UP({ closeHours: 24, closesAt: STARTS - 24 * HOUR, mine: { kind: 'signed', source: 'raidsmith', characterName: 'Eliora' } })] }));
    assert(signed.includes('Signed up - Eliora') && signed.includes('Sign-ups close Fri 8:00 PM') && !signed.includes('data-action="raids-signup"'));
    // No deadline (0 hours): nothing to add.
    assert(!listPage(LIST()).includes('Sign-ups close'));
    // Closed by the deadline: the sentence, no button, no "close" line.
    const closed = listPage(LIST({ upcoming: [UP({ signupsOpen: false, closeHours: 24, closesAt: STARTS - 24 * HOUR })] }));
    assert(closed.includes('Sign-ups closed') && !closed.includes('Sign-ups close ') && !closed.includes('data-action="raids-signup"'));
    // Officers who cannot sign up have no column to put it in.
    assert(!listPage(LIST({ can: { edit: true, signup: false }, upcoming: [UP({ closeHours: 24, closesAt: STARTS - 24 * HOUR })] }), OFFICER_CAN).includes('Sign-ups close'));
    assert.equal(G.pages.raids.mineHtml(UP({ closeHours: 24, closesAt: STARTS - 24 * HOUR }), false, gd(MEMBER_CAN)), '');
    assertNoRawAttrs(open);
  });

  await check('Raids list: past rows show the size next to the zone; none is "10-player"; an older reply shows the zone', () => {
    const out = listPage(LIST({ upcoming: [], raids: [PAST(), PAST({ id: 'r8', zone: null, size: 25 }), PAST({ id: 'r7', size: undefined })] }), MEMBER_CAN, { tab: 'past' });
    assert(out.includes('<td class="" data-label="Zone">Barrow Deeps - 10</td>') && out.includes('<td class="" data-label="Zone">25-player</td>') && out.includes('<td class="" data-label="Zone">Barrow Deeps</td>'));
    assert(out.includes('<td class="" data-label="Bosses">2 kills, 1 wipe</td>'), 'the card carries the same facts');
    assert(!/data-label="Zone"><span class="gs-muted">-/.test(out), 'every row has a zone or a size here');
    assert(listPage(LIST({ upcoming: [], raids: [PAST({ zone: null, size: undefined })] }), MEMBER_CAN, { tab: 'past' }).includes('<td class="" data-label="Zone"><span class="gs-muted">-</span></td>'));
  });

  await check('Raids list: a 409 for the deadline reads the list again, shows the Worker\'s sentence and takes the button away', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const open = LIST({ upcoming: [UP({ closeHours: 24, closesAt: STARTS - 24 * HOUR })] });
    const x = S.att.raids = { gid: 'g1', teamId: 't1', data: open, more: false, tab: 'upcoming' };
    const closed = LIST({ upcoming: [UP({ signupsOpen: false, closeHours: 24, closesAt: STARTS - 24 * HOUR })] });
    const message = 'Sign-ups closed 24 hours before the start of this raid. Ask an officer.';
    const s = stub((m) => (m === 'put' ? Promise.reject(new ApiErr(409, 'signups_closed', { message, reason: 'deadline', closesAt: STARTS - 24 * HOUR })) : Promise.resolve(closed)));
    const button = el({ 'data-rid': 'u1' });
    G.handlers.click['raids-signup'](button);
    await settle();
    assert.deepEqual(s.calls.map(c => c.m), ['put', 'get']);
    assert.equal(button.disabled, false);
    assert.equal(S.pageAlert, message);
    assert.equal(x.data.upcoming[0].signupsOpen, false);
    assert(!listPage(x.data).includes('data-action="raids-signup"'));
    s.restore();
  }));

  await check('New raid: a Raid size select - Automatic first and chosen, then 10 / 20 / 25 / 40; its help says what Automatic does', () => {
    const nr = (f) => ws(G.pages.raidNew.raidNewHtml({ guildData: gd(OFFICER_CAN), state: { gid: 'g1', form: Object.assign({ teamId: 't1', event: '', reports: [''], plan: '', mode: 'log', date: '', time: '20:00', zone: '', title: '', size: '' }, f || {}), run: null, error: '' }, today: '2026-10-17' }));
    const out = nr();
    assert(out.includes('<label class="gs-label" for="nr-size">Raid size</label>') && out.includes('aria-describedby="nr-size-help"'));
    assert.deepEqual(optionsOf(out, 'nr-size'), [
      { value: '', selected: true, label: 'Automatic - from the zone, else the team&#39;s size' }, { value: '10', selected: false, label: '10-man' }, { value: '20', selected: false, label: '20-man' },
      { value: '25', selected: false, label: '25-man' }, { value: '40', selected: false, label: '40-man' }].map(o => (o.label.includes('&#39;') ? Object.assign({}, o, { label: o.label }) : o)));
    assert(out.includes('data-key="nr-size"') && out.includes('id="nr-size-help">How many players the raid is for.'));
    assert.deepEqual(optionsOf(nr({ size: '20' }), 'nr-size').filter(o => o.selected).map(o => o.value), ['20'], 'a chosen size survives a re-render');
    assert(nr({ date: '2026-10-10' }).includes('id="nr-size"'), 'whatever the date');
    assert.equal(G.ui.sizeChoices().length, 4);
    assertNoRawAttrs(out);
  });

  await check('New raid: the create body omits size when Automatic and sends the number otherwise; the form state reads the select', withState(async (S) => {
    const base = { teamId: 't1', event: '', reports: [''], plan: '', mode: 'log', date: '2026-10-24', time: '20:00', zone: '', title: '', size: '' };
    const body = (f) => plain(G.pages.raidNew.createBody(Object.assign({}, base, f), false, '2026-10-17'));
    assert.deepEqual(body({}), { teamId: 't1', raidOn: '2026-10-24', startTime: '20:00' }, 'Automatic: no size key at all');
    assert(!('size' in body({ size: '' })) && !('size' in body({ size: null })) && !('size' in body({ size: undefined })));
    assert.deepEqual(body({ size: '20', zone: 'Hyjal Summit' }), { teamId: 't1', raidOn: '2026-10-24', startTime: '20:00', zone: 'Hyjal Summit', size: 20 });
    assert.equal(typeof body({ size: '40' }).size, 'number');
    assert.equal(body({ size: '10', date: '2026-10-10' }).size, 10, 'a past raid too');
    // The form is read from the select (and a fresh form starts Automatic).
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    ctx.Guild.app.teamFor = () => 't1';
    G.pages.raidNew.load({ name: 'raidnew' }, S.guilds.g1);
    assert.equal(S.att.nr.form.size, '');
    fakeEl('nr-size', { value: '25' });
    G.pages.raidNew.syncForm();
    assert.equal(S.att.nr.form.size, '25');
    // Submitting posts it.
    S.att.nr.form.date = '2026-10-24';
    const s = stub((m, url) => Promise.resolve({ raid: { id: 'r_new' } }));
    fakeEl('nr-date', { value: '2026-10-24' });
    G.handlers.submit['nr-create-form']();
    await settle();
    assert.equal(s.calls[0].url, '/api/guild/g1/raids');
    assert.equal(s.calls[0].body.size, 25);
    s.restore();
  }));

  // ═══ 4. The raid page ════════════════════════════════════════════
  const raidPage = (data, can, signups) => ws(G.pages.raid.raidHtml({ guildData: gd(can || OFFICER_CAN), data, signups: signups || null }));

  await check('raid page: the title carries "zone - size"; a date-only raid says "Time not set" and shows no time; a timed one shows its start', () => {
    const timed = raidPage(DETAIL());
    assert(/<h1 class="gs-h1" id="page-title" tabindex="-1">Sat Oct 24 - Hyjal Summit - 20<\/h1>/.test(timed));
    assert(timed.includes('Prog night &middot; Starts Sat Oct 24, 8:00 PM') && !timed.includes('Time not set'));
    const noZone = raidPage(DETAIL(null, { zone: null, size: 25 }));
    assert(noZone.includes('>Sat Oct 24 - 25-player</h1>'));
    const old = raidPage(DETAIL(null, { size: undefined }));
    assert(old.includes('>Sat Oct 24 - Hyjal Summit</h1>'), 'an older reply: the zone alone');
    const dateOnly = raidPage(DETAIL(null, { timeKnown: false, startsAt: NOON_UTC }));
    assert(dateOnly.includes('Starts Sat Oct 24 &middot; <span class="gs-time-unset">Time not set</span>'), dateOnly.slice(dateOnly.indexOf('gs-sub')));
    assert(!/12:00|\bAM\b|\bPM\b/.test(stripTags(dateOnly)), 'no made-up time');
    // A past raid: the title has the size; the sub line is the bosses as before.
    const past = raidPage(DETAIL(null, { upcoming: false, state: 'reviewed' }));
    assert(past.includes('>Sat Oct 24 - Hyjal Summit - 20</h1>') && !past.includes('Starts '));
    assertEscaped(raidPage(DETAIL(null, { zone: HOSTILE + QUOTES })), 'raid title');
  });

  await check('raid settings card: officers only; the size select (Automatic / 10 / 20 / 25 / 40) starts at the override; what is in effect is written under each control', () => {
    const out = raidPage(DETAIL());
    assert(out.includes('<h2 class="gs-h2" id="rs-h">Raid settings</h2>') && out.includes('data-submit="raid-settings-form"') && out.includes('data-key="rs-save"'));
    const sizes = optionsOf(out, 'rs-size');
    assert.deepEqual(sizes.map(o => o.value), ['', '10', '20', '25', '40']);
    assert.deepEqual(sizes.filter(o => o.selected).map(o => o.value), [''], 'no override: Automatic');
    assert(sizes[0].label.startsWith('Automatic - from the zone'));
    assert(out.includes('id="rs-size-help">In effect: 20 players, picked from the zone, else the team&#39;s size.') || out.includes('id="rs-size-help">In effect: 20 players, picked from the zone, else the team\'s size.'));
    const over = raidPage(DETAIL(null, { sizeOverride: 10, size: 10 }));
    assert.deepEqual(optionsOf(over, 'rs-size').filter(o => o.selected).map(o => o.value), ['10']);
    assert(over.includes('In effect: 10 players, set for this raid.'));
    assert(out.includes('id="rs-error" role="alert" hidden') && out.includes('id="rs-err-size" role="alert" hidden'));
    // Members and anyone without raids.edit do not see it.
    const member = raidPage(DETAIL({ can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } }), MEMBER_CAN);
    assert(!member.includes('Raid settings') && !member.includes('rs-size') && !member.includes('raid-settings-form'));
    assert.equal(G.pages.raid.settingsCardHtml(gd(MEMBER_CAN), DETAIL({ can: { edit: false } })), '');
    assertNoRawAttrs(out);
    assertEscaped(raidPage(DETAIL(null, { zone: HOSTILE + QUOTES })), 'settings card');
  });

  await check('raid settings card: the deadline - "Team default (N hours)" or "Set for this raid" with hours 0 to 72; what is in effect is written, in the guild\'s time zone', () => {
    const none = raidPage(DETAIL());
    assert.deepEqual(optionsOf(none, 'rs-hours-mode'), [{ value: '', selected: true, label: 'Team default (0 hours)' }, { value: 'custom', selected: false, label: 'Set for this raid' }]);
    assert(/id="rs-hours-field" hidden>/.test(none) && /<input class="gs-input" type="number" id="rs-hours" name="hours" data-key="rs-hours" min="0" max="72" step="1" inputmode="numeric" autocomplete="off" value="">/.test(none));
    assert(none.includes('id="rs-hours-help">In effect: members can change their sign-up until the raid starts, the team&#39;s setting.') || none.includes("In effect: members can change their sign-up until the raid starts, the team's setting."));
    assert(none.includes('data-change="rs-hours-mode"') && none.includes('<label class="gs-label" for="rs-hours">Hours before the start (0 = when the raid starts)</label>'));
    const team = raidPage(DETAIL(null, { closeHours: 24, closesAt: STARTS - 24 * HOUR }));
    assert(team.includes('>Team default (24 hours)<') && team.includes('until 24 hours before the start (Fri Oct 23, 8:00 PM CT)'), 'the team\'s deadline, written in Chicago time');
    assert(team.includes('(Fri Oct 23, 8:00 PM CT), the team'));
    const one = raidPage(DETAIL(null, { closeHours: 1, closesAt: STARTS - HOUR }));
    assert(one.includes('>Team default (1 hour)<') && one.includes('until 1 hour before the start'));
    const own = raidPage(DETAIL(null, { closeHours: 6, closeHoursOverride: 6, closesAt: STARTS - 6 * HOUR }));
    assert.deepEqual(optionsOf(own, 'rs-hours-mode').filter(o => o.selected).map(o => o.value), ['custom']);
    assert(/id="rs-hours-field">/.test(own) && /id="rs-hours"[^>]*value="6"/.test(own), 'the box shows with the raid\'s own hours');
    assert(own.includes('until 6 hours before the start (Sat Oct 24, 2:00 PM CT), set for this raid.'));
    assert(own.includes('>Set for this raid<'));
    // An own value of 0 is still an override.
    const zero = raidPage(DETAIL(null, { closeHours: 0, closeHoursOverride: 0 }));
    assert(/id="rs-hours"[^>]*value="0"/.test(zero) && zero.includes('until the raid starts, set for this raid.'));
    // The same moment in another zone.
    const nz = ws(G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN, null, 'Pacific/Auckland'), data: DETAIL(null, { closeHours: 24, closesAt: STARTS - 24 * HOUR }), signups: null }));
    assert(nz.includes('(Sat Oct 24, 2:00 PM UTC+13)'));
    // A past raid has no deadline to set, only the size.
    const past = raidPage(DETAIL(null, { upcoming: false, state: 'reviewed' }));
    assert(past.includes('id="rs-size"') && !past.includes('rs-hours') && !past.includes('Sign-up deadline'));
  });

  await check('raid settings card: "Team default (N hours)" still names the team\'s hours when the raid has its own - from the Raids list\'s copy of the team', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const detail = DETAIL(null, { closeHours: 6, closeHoursOverride: 6 });
    assert(raidPage(detail).includes('>Team default<'), 'nothing to read it from: no number');
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ team: { id: 't1', name: 'Team KJ', archived: false, size: 20, signupCloseHours: 12 } }) };
    assert(raidPage(detail).includes('>Team default (12 hours)<'));
    S.att.raids.data.team.id = 't2';
    assert(raidPage(detail).includes('>Team default<'), 'another team\'s copy is not used');
  }));

  await check('raid settings: the mode select shows the hours box in place and moves focus to it', withState(async () => {
    const field = fakeEl('rs-hours-field', { hidden: true });
    const input = fakeEl('rs-hours');
    G.handlers.change['rs-hours-mode'](el({}, { value: 'custom' }));
    assert.equal(field.hidden, false);
    assert.equal(input.focused, 1);
    G.handlers.change['rs-hours-mode'](el({}, { value: '' }));
    assert.equal(field.hidden, true);
    assert.equal(input.focused, 1, 'no focus when it goes away');
  }));

  // A fake settings form: size, mode and hours controls, the way the card names them.
  const settingsForm = (size, mode, hours) => ({ elements: Object.assign({ size: control(size) }, mode === undefined ? {} : { hoursMode: control(mode), hours: control(hours == null ? '' : hours) }) });
  const slots = () => ['rs-err-size', 'rs-err-hours', 'rs-error'].forEach(id => fakeEl(id, { hidden: true }));

  await check('raid settings: Save sends only what changed - a new size alone, hours alone, or both - as PATCH on the raid, then shows the answer and reads the sign-ups again', withState(async (S) => {
    openRaid(S, view(), OFFICER_CAN);
    slots();
    const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
    const answer = DETAIL(null, { size: 10, sizeOverride: 10, closeHours: 12, closeHoursOverride: 12, closesAt: STARTS - 12 * HOUR });
    const s = stub((m) => Promise.resolve(m === 'patch' ? answer : view()));
    // Size alone.
    G.handlers.submit['raid-settings-form'](settingsForm('10', '', ''));
    await settle();
    assert.deepEqual(s.calls.filter(c => c.m === 'patch').map(c => [c.url, c.body]), [['/api/guild/g1/raids/u1', { size: 10 }]]);
    assert.equal(S.att.raid.data, answer, 'the page now shows what the Worker answered');
    assert.equal(S.att.note, 'Raid settings saved.');
    assert(s.calls.some(c => c.m === 'get' && c.url === '/api/guild/g1/raids/u1/signups'), 'the sign-ups panel reads its list again (the deadline changed what it says)');
    // Hours alone, against the new state (size 10 is the override now).
    s.calls.length = 0;
    G.handlers.submit['raid-settings-form'](settingsForm('10', 'custom', ' 6 '));
    await settle();
    assert.deepEqual(s.calls.filter(c => c.m === 'patch').map(c => c.body), [{ signupCloseHours: 6 }]);
    // Both.
    s.calls.length = 0;
    G.handlers.submit['raid-settings-form'](settingsForm('25', 'custom', '0'));
    await settle();
    assert.deepEqual(s.calls.filter(c => c.m === 'patch').map(c => c.body), [{ size: 25, signupCloseHours: 0 }], '0 hours is a number, not a clear');
    s.restore();
    G.ui.setBusy = realBusy;
  }));

  await check('raid settings: Automatic and Team default send null (they clear the override); a past raid\'s form has no deadline and never sends one', withState(async (S) => {
    openRaid(S, view(), OFFICER_CAN, DETAIL(null, { size: 10, sizeOverride: 10, closeHours: 6, closeHoursOverride: 6 }));
    slots();
    const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
    let s = stub((m) => Promise.resolve(m === 'patch' ? DETAIL() : view()));
    G.handlers.submit['raid-settings-form'](settingsForm('', '', ''));
    await settle();
    assert.deepEqual(s.calls.filter(c => c.m === 'patch').map(c => c.body), [{ size: null, signupCloseHours: null }]);
    assert(JSON.stringify(s.calls.find(c => c.m === 'patch').body).includes('null'));
    s.restore();
    // Only the size is cleared when the hours stay.
    openRaid(S, view(), OFFICER_CAN, DETAIL(null, { size: 10, sizeOverride: 10, closeHours: 6, closeHoursOverride: 6 }));
    s = stub((m) => Promise.resolve(m === 'patch' ? DETAIL() : view()));
    G.handlers.submit['raid-settings-form'](settingsForm('', 'custom', '6'));
    await settle();
    assert.deepEqual(s.calls.filter(c => c.m === 'patch').map(c => c.body), [{ size: null }]);
    s.restore();
    // A past raid: no hoursMode control at all.
    openRaid(S, view(), OFFICER_CAN, DETAIL(null, { upcoming: false, state: 'reviewed', size: 25, sizeOverride: null }));
    s = stub((m) => Promise.resolve(m === 'patch' ? DETAIL() : view()));
    G.handlers.submit['raid-settings-form'](settingsForm('40'));
    await settle();
    assert.deepEqual(s.calls.filter(c => c.m === 'patch').map(c => c.body), [{ size: 40 }]);
    s.restore();
    G.ui.setBusy = realBusy;
  }));

  await check('raid settings: nothing changed sends nothing and says so; bad hours (blank, 73, 1.5, -1) never leave the browser and show the field error', withState(async (S) => {
    openRaid(S, view(), OFFICER_CAN);
    slots();
    const s = stub(() => Promise.resolve(DETAIL()));
    G.handlers.submit['raid-settings-form'](settingsForm('', '', ''));
    assert.equal(s.calls.length, 0);
    assert.equal(els['rs-error'].textContent, 'Nothing to save: the settings are already as shown.');
    assert.equal(els['rs-error'].hidden, false);
    for (const bad of ['', '73', '1.5', '-1', 'x', '100']) {
      slots();
      const form = settingsForm('', 'custom', bad);
      G.handlers.submit['raid-settings-form'](form);
      assert.equal(s.calls.length, 0, JSON.stringify(bad));
      assert.equal(els['rs-err-hours'].textContent, 'Enter whole hours from 0 to 72.', JSON.stringify(bad));
      assert.equal(form.elements.hours.focused, 1);
    }
    // An unknown size value is refused too (the select cannot send one, but the form is the contract).
    slots();
    G.handlers.submit['raid-settings-form'](settingsForm('15', '', ''));
    assert.equal(s.calls.length, 0);
    assert.equal(els['rs-err-size'].textContent, 'Choose Automatic or one of the sizes.');
    s.restore();
  }));

  await check('raid settings: the Worker\'s 400 lands next to its control (size / hours), other errors in the form; a lost sign-in or a message page is routed; nothing is changed on the page', withState(async (S) => {
    openRaid(S, view(), OFFICER_CAN);
    const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
    const before = S.att.raid.data;
    let s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'size is 10, 20, 25 or 40.', field: 'size' })));
    slots();
    const f1 = settingsForm('25', '', '');
    G.handlers.submit['raid-settings-form'](f1);
    await settle();
    assert.equal(els['rs-err-size'].textContent, 'size is 10, 20, 25 or 40.');
    assert.equal(els['rs-error'].hidden, true);
    assert.equal(f1.elements.size.focused, 1);
    s.restore();
    s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'signupCloseHours is a whole number of hours from 0 to 72.', field: 'signupCloseHours' })));
    slots();
    const f2 = settingsForm('', 'custom', '5');
    G.handlers.submit['raid-settings-form'](f2);
    await settle();
    assert.equal(els['rs-err-hours'].textContent, 'signupCloseHours is a whole number of hours from 0 to 72.');
    assert.equal(f2.elements.hours.focused, 1);
    s.restore();
    s = stub(() => Promise.reject(new ApiErr(429, 'rate_limited', { message: 'Too many changes.' })));
    slots();
    G.handlers.submit['raid-settings-form'](settingsForm('25', '', ''));
    await settle();
    assert(els['rs-error'].textContent.includes('Too many changes.'));
    s.restore();
    assert.equal(S.att.raid.data, before, 'the page keeps what it had');
    // Sign-in lost.
    let signedOut = 0;
    const realReq = ctx.Guild.app.requireSignin; ctx.Guild.app.requireSignin = () => { signedOut++; };
    s = stub(() => Promise.reject(new ApiErr(401, 'signed_out', { message: 'Sign in.' })));
    G.handlers.submit['raid-settings-form'](settingsForm('25', '', ''));
    await settle();
    assert.equal(signedOut, 1);
    ctx.Guild.app.requireSignin = realReq;
    s.restore();
    G.ui.setBusy = realBusy;
  }));

  // ═══ 5. The Sign-ups panel ═══════════════════════════════════════
  await check('panel: the counts lead with "Expected 18 / 20" (the raid\'s size); a view without a size has the old row', () => {
    const out = ws(panel(view()));
    const text = stripTags(out);
    assert(/Expected 18 \/ 20 Signed 17 Late 1 Tentative 1 Bench 1 Can&#39;t come 1/.test(text), text.slice(0, 400));
    assert(out.includes('<dt>Expected</dt><dd>18 / 20</dd>'));
    const noSize = stripTags(panel(view(null, { size: undefined })));
    assert(!noSize.includes('Expected') && /Signed 17 Late 1/.test(noSize));
    assert(stripTags(panel(view({ counts: Object.assign({}, COUNTS, { expected: 0, signed: 0, late: 0 }) }))).includes('Expected 0 / 20'));
    assert(stripTags(panel(view(null, { size: 10 }))).includes('Expected 18 / 10'), 'over the size reads as it is');
    assert(!panel(view({ can: { edit: false, self: false, seeList: false, seeNicknames: false }, me: null, counts: null, entries: null })).includes('Expected'), 'a viewer without the list has no counts');
  });

  await check('panel: the status pill - "Open until <deadline> (sign-ups close N hours before the start)" when a deadline is set; the old "Open until <start>" when not', () => {
    const none = ws(panel(view()));
    assert(none.includes('gs-pill gs-pill-ok gs-su-status">Open until Sat Oct 24, 8:00 PM CT</span>') && !none.includes('sign-ups close'));
    const d24 = ws(panel(view(null, { closeHours: 24, closesAt: STARTS - 24 * HOUR })));
    assert(d24.includes('>Open until Fri Oct 23, 8:00 PM CT (sign-ups close 24 hours before the start)</span>'), d24.slice(d24.indexOf('gs-pill')));
    assert(ws(panel(view(null, { closeHours: 1, closesAt: STARTS - HOUR }))).includes('(sign-ups close 1 hour before the start)'));
    // The guild's zone, not the browser's.
    const nz = ws(G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN, null, 'Pacific/Auckland'), data: DETAIL(), state: state(view(null, { closeHours: 24, closesAt: STARTS - 24 * HOUR })) }));
    assert(nz.includes('Open until Sat Oct 24, 2:00 PM UTC+13 (sign-ups close 24 hours before the start)'), 'a zone with no short name reads as an offset');
    // A date-only raid: the old pill has the day alone.
    const dateOnly = ws(G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(null, { timeKnown: false, startsAt: NOON_UTC }), state: state(view(null, { timeKnown: false, startsAt: NOON_UTC })) }));
    assert(dateOnly.includes('>Open until Sat Oct 24</span>'), dateOnly.slice(dateOnly.indexOf('gs-pill')));
    // The long pill may wrap (a phone is 390 px wide): the class carries it and the CSS lets it.
    assert(/\.gs-su-status\s*\{[^}]*white-space:\s*normal/.test(read('guild.css')));
  });

  await check('panel: closed by the deadline - its own pill and sentence ("Sign-ups closed N hours before the start. Ask an officer if you need to change yours."), the buttons off, nothing to save', () => {
    const closedRaid = { closed: 'deadline', closeHours: 24, closesAt: STARTS - 24 * HOUR };
    const v = view({ me: Object.assign({}, view().me, { canChange: false, closed: 'deadline' }) }, closedRaid);
    const out = ws(panel(v));
    assert(out.includes('gs-pill gs-pill-warn gs-su-status">Closed Fri Oct 23, 8:00 PM CT</span>'), out.slice(out.indexOf('gs-pill')));
    assert(out.includes('Sign-ups closed 24 hours before the start. Ask an officer if you need to change yours.'));
    assert(!out.includes('An officer has closed sign-ups') && !out.includes('The raid has started'));
    assert(/data-kind="signed"[^>]*disabled/.test(out) && /data-kind="absence"[^>]*disabled/.test(out) && /id="su-note"[^>]*disabled/.test(out));
    assert(!out.includes('Save details'));
    assert(ws(panel(view({ me: Object.assign({}, view().me, { canChange: false, closed: 'deadline' }) }, { closed: 'deadline', closeHours: 1, closesAt: STARTS - HOUR }))).includes('Sign-ups closed 1 hour before the start.'));
    // An officer is not bound: the panel keeps its tools and the buttons work.
    const officer = ws(panel(view({ can: { edit: true, self: true, seeList: true, seeNicknames: true }, me: Object.assign({}, view().me, { canChange: true, closed: null }), roster: [] }, { closed: 'deadline', closeHours: 24, closesAt: STARTS - 24 * HOUR }), { guildData: gd(OFFICER_CAN) }));
    assert(officer.includes('data-action="su-add"') && !/data-kind="signed"[^>]*disabled/.test(officer));
    // The other two reasons keep their words.
    assert(panel(view({ me: Object.assign({}, view().me, { canChange: false, closed: 'locked' }) }, { closed: 'locked', locked: true })).includes('An officer has closed sign-ups.'));
    assert(panel(view({ me: Object.assign({}, view().me, { canChange: false, closed: 'started' }) }, { closed: 'started', upcoming: false })).includes('The raid has started, so sign-ups can no longer be changed here.'));
  });

  await check('panel: a 409 for the deadline is handled like started / locked - the view is read again, the Worker\'s sentence shown in the panel, the buttons off', withState(async (S) => {
    const x = openRaid(S, view());
    const closed = view({ me: Object.assign({}, view().me, { canChange: false, closed: 'deadline' }) }, { closed: 'deadline', closeHours: 24, closesAt: STARTS - 24 * HOUR });
    const message = 'Sign-ups closed 24 hours before the start of this raid. Ask an officer.';
    const s = stub((m) => (m === 'put' ? Promise.reject(new ApiErr(409, 'signups_closed', { message, reason: 'deadline', closesAt: STARTS - 24 * HOUR })) : Promise.resolve(closed)));
    G.handlers.click['su-kind'](el({ 'data-kind': 'late' }));
    await settle();
    assert.deepEqual(s.calls.map(c => c.m), ['put', 'get']);
    assert.equal(x.ui.error, message);
    assert.equal(x.ui.busy, false);
    assert.equal(x.data, closed, 'the page now shows the closed state');
    assert.equal(S.pageAlert, '', 'not the page alert');
    const html = ws(G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: x }));
    assert(html.includes(message) && html.includes('Sign-ups closed 24 hours before the start. Ask an officer') && /data-kind="late"[^>]*disabled/.test(html));
    s.restore();
  }));

  // ═══ 7. Away notices ═════════════════════════════════════════════
  const TODAY = '2026-10-18'; // a Sunday
  const notice = (over) => Object.assign({ id: 'an_1', personId: 'p_e', kind: 'away', atTime: null, from: '2026-10-20', to: '2026-10-27', weekday: null, reason: null, mine: true, createdAt: 1 }, over || {});
  const N_RANGE = notice({ reason: 'Wedding' });
  const N_WEEKLY = notice({ id: 'an_2', from: '2026-10-22', to: null, weekday: 4 });
  const N_LATE = notice({ id: 'an_3', kind: 'late', atTime: '21:00', from: '2026-10-13', to: '2026-12-01', weekday: 2, reason: 'Work' });
  const N_LEAVING = notice({ id: 'an_5', kind: 'leaving', atTime: '22:00', from: '2026-10-24', to: '2026-10-24' });
  const N_PAST = notice({ id: 'an_4', from: '2026-09-01', to: '2026-09-05' });
  const MINE = (over) => ({ gid: 'g1', data: Object.assign({ today: TODAY, timeZone: 'America/Chicago', personId: 'p_e', notices: [N_PAST, N_WEEKLY, N_RANGE, N_LATE], max: 30 }, over || {}), showPast: false, note: '' });
  const minePage = (over, state, extra) => G.pages.away.mineHtml(Object.assign({ guildData: gd(MEMBER_CAN), state: Object.assign({ gid: 'g1', data: MINE(over).data, showPast: false, note: '' }, state || {}) }, extra || {}));

  await check('away route: #/g/:gid/away parses and formats back; look-alikes are not found; it hangs under Raids in the breadcrumb and the page script is wired', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/g/g1/away'), { name: 'away', gid: 'g1' });
    assert.equal(G.router.format({ name: 'away', gid: 'g1' }), '#/g/g1/away');
    assert.deepEqual(p(G.router.format({ name: 'away', gid: 'g1' })), { name: 'away', gid: 'g1' });
    for (const bad of ['#/g/g1/away/x', '#/g/g1/aways', '#/away', '#/g/g1/Away']) assert.equal(p(bad).name, 'notfound', bad);
    const crumbs = G.shell.breadcrumbItems({ route: { name: 'away', gid: 'g1' }, guildData: gd(MEMBER_CAN), teamId: 't1' });
    assert.deepEqual(plain(crumbs.map(c => c.label)).slice(-2), ['Raids', 'Away notices']);
    assert(crumbs.find(c => c.label === 'Raids').href.endsWith('#/g/g1/raids'));
    const app = read('js/guild/app.js');
    assert(/ATT_ROUTE_PAGES = \{[^}]*away: 'away'/.test(app) && /case 'lootperson': case 'away':/.test(app) && /\['away', 'standing', 'raidRoster'\]\.forEach/.test(app));
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert(guildScriptsOf(read(page)).includes('/js/guild/pages-away.js'), page);
    assert(GUILD_SCRIPTS.includes('/js/guild/pages-away.js') && GUILD_SCRIPTS.indexOf('/js/guild/pages-away.js') < GUILD_SCRIPTS.indexOf('/js/guild/app.js'));
    const menu = G.shell.accountMenuHtml({ me: { user: { displayName: 'A', username: 'a' }, identities: { discord: true } }, guildData: gd(MEMBER_CAN) });
    assert(menu.includes('href="#/g/g1/away"') && menu.includes('<span>Away notices</span>'));
    assert(!G.shell.accountMenuHtml({ me: { user: { displayName: 'A', username: 'a' }, identities: { discord: true } } }).includes('Away notices'), 'no guild current: no item');
  });

  await check('away: a notice is one plain sentence - range, every weekday (from when it starts), Late with a time, Leaving early', () => {
    const T = (n) => G.pages.away.noticeText(n, TODAY);
    assert.equal(T(N_RANGE), 'Away Oct 20 - Oct 27');
    assert.equal(T(N_WEEKLY), 'Away every Thursday from Oct 22');
    assert.equal(T(N_LATE), 'Late, arriving 21:00, every Tuesday until Dec 1');
    assert.equal(T(N_LEAVING), 'Leaving early, at 22:00, Oct 24');
    assert.equal(T(notice({ weekday: 0, from: '2026-10-11', to: null })), 'Away every Sunday', 'a weekly notice that has started does not say from');
    assert.equal(T(notice({ from: '2026-10-20', to: '2026-10-20' })), 'Away Oct 20');
    assert.equal(T(notice({ weekday: 6, from: '2026-10-24', to: '2026-11-14', kind: 'leaving', atTime: '22:30' })), 'Leaving early, at 22:30, every Saturday from Oct 24 until Nov 14');
    assert.equal(G.pages.away.isPast(N_PAST, TODAY), true);
    assert.equal(G.pages.away.isPast(N_WEEKLY, TODAY), false, 'open-ended never ends');
    assert.equal(G.pages.away.isPast(notice({ to: TODAY }), TODAY), false, 'the last day is still today');
    const parts = G.pages.away.split([N_PAST, N_WEEKLY, N_RANGE, N_LATE], TODAY);
    assert.deepEqual(parts.current.map(n => n.id), ['an_3', 'an_1', 'an_2'], 'soonest start first');
    assert.deepEqual(parts.past.map(n => n.id), ['an_4']);
  });

  await check('away page: my notices as sentences with the reason, Edit and Remove; ended ones in a collapsed Past group; Add a notice; the guild\'s time zone is named', () => {
    const out = minePage();
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Away notices</h1>') && out.includes('(America/Chicago)'));
    assert(out.includes('gs-dtable-primary">Away Oct 20 - Oct 27</th>') && out.includes('data-label="Reason">Wedding</td>'), 'the notice is the row (cards on a phone), the reason its own column');
    assert(out.includes('Away every Thursday from Oct 22') && out.includes('Late, arriving 21:00, every Tuesday until Dec 1'));
    assert(out.indexOf('Late, arriving') < out.indexOf('Away Oct 20') && out.indexOf('Away Oct 20') < out.indexOf('every Thursday'), 'by start date');
    assert(/aria-label="Edit: Away Oct 20 - Oct 27" data-action="away-edit" data-ctx="mine" data-nid="an_1" data-key="an-edit-an_1"><span>Edit<\/span><\/button>/.test(out));
    assert(/aria-label="Remove: Away Oct 20 - Oct 27" data-action="away-remove" data-ctx="mine" data-nid="an_1" data-key="an-remove-an_1"><span>Remove<\/span><\/button>/.test(out));
    assert(/class="gs-btn gs-btn-molten" data-action="away-add" data-ctx="mine" data-key="an-add"><span>Add a notice<\/span><\/button>/.test(out) && !/disabled data-action="away-add"/.test(out), 'Add a notice is the page\'s one primary, in the header');
    // The past group: collapsed, counted, opens on its button.
    assert(/data-action="away-past"[^>]*aria-expanded="false" aria-controls="an-past-list"><span>Past \(1\)<\/span>/.test(out));
    assert(/id="an-past-list" hidden>/.test(out) && out.indexOf('id="an-past-list"') < out.indexOf('Away Sep 1 - Sep 5'));
    const open = minePage(null, { showPast: true });
    assert(/aria-expanded="true"/.test(open) && /id="an-past-list">/.test(open));
    assert.equal(minePage({ notices: [N_RANGE] }).includes('an-past'), false, 'nothing past: no group');
    assertNoRawAttrs(out);
    assert(/gs-banner-success[\s\S]*Notice saved\./.test(minePage(null, { note: 'Notice saved.' })), 'the result is an inline banner');
  });

  await check('away page: empty states - no roster entry says who to ask; no notices says so; thirty is the most (Add is disabled and says why)', () => {
    const none = minePage({ personId: null, notices: [] });
    assert(none.includes('No roster entry yet') && none.includes('Ask an officer to link your account to your roster entry.') && !none.includes('away-add'));
    const empty = minePage({ notices: [] });
    assert(empty.includes('You have no away notices') && empty.includes('away-add'));
    assert(minePage({ notices: [N_PAST] }).includes('No current or upcoming notices'));
    const full = minePage({ notices: Array.from({ length: 30 }, (_, i) => notice({ id: 'an_x' + i, from: '2026-10-2' + (i % 10) })), max: 30 });
    assert(/disabled data-action="away-add"/.test(full) && full.includes('You have 30 notices, the most there can be. Remove one to add another.'));
  });

  await check('away page: hostile reasons and names are escaped on the page, the card, the section and the dialogs', () => {
    const evil = notice({ reason: HOSTILE + QUOTES });
    assertEscaped(minePage({ notices: [evil, notice({ id: 'an_9', from: '2026-09-01', to: '2026-09-02', reason: HOSTILE })] }, { showPast: true }), 'my page');
    const card = G.pages.away.teamCardHtml({ guildData: gd(OFFICER_CAN), teamId: 't1', state: { gid: 'g1', teamId: 't1', status: 'ok', data: { today: TODAY, entries: [{ noticeId: 'an_1', personId: 'p_x', name: HOSTILE + QUOTES, class: 'MAGE', kind: 'away', atTime: null, from: '2026-10-20', to: '2026-10-27', weekday: null, reason: HOSTILE + QUOTES, dates: [] }] } } });
    assertEscaped(card, 'team card');
    assertEscaped(G.pages.away.dialogHtml({ mode: 'edit', ctx: 'team', nid: 'an_1', notice: evil, today: TODAY, who: HOSTILE + QUOTES }), 'edit dialog');
    assertEscaped(G.pages.away.dialogHtml({ mode: 'add', ctx: 'team', people: [{ id: 'p_x', name: HOSTILE + QUOTES }], today: TODAY }), 'person picker');
    assertEscaped(G.pages.away.removeDialogHtml(HOSTILE + QUOTES, 'mine', 'an_1', ''), 'remove dialog');
  });

  await check('away page: loading reads GET /away/mine and keeps the Past group open across a reload; before that, the loading page', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    assert.equal(G.pages.away.main({ name: 'away', gid: 'g1' }, S.guilds.g1), G.pages.signin.loadingHtml());
    const s = stub(() => Promise.resolve(MINE().data));
    await G.pages.away.load({ name: 'away', gid: 'g1' }, S.guilds.g1);
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/away/mine']]);
    assert(G.pages.away.main({ name: 'away', gid: 'g1' }, S.guilds.g1).includes('Away Oct 20 - Oct 27'));
    G.handlers.click['away-past'](el({}));
    assert.equal(S.att.away.showPast, true);
    await G.pages.away.load({ name: 'away', gid: 'g1' }, S.guilds.g1);
    assert.equal(S.att.away.showPast, true, 'a reload does not close it');
    s.restore();
  }));

  await check('away dialog: Add starts as Away for a date range from today (min = today for a member); the time and weekday fields are hidden; labels read From / To', () => {
    const out = G.pages.away.dialogHtml({ mode: 'add', ctx: 'mine', today: TODAY, minToday: true });
    assert(out.includes('data-submit="away-form"') && out.includes('data-ctx="mine"') && out.includes('data-mode="add"') && !out.includes('data-nid') && !out.includes('data-pid'));
    assert(out.includes('Add an away notice') && out.includes('Only you and your officers see the reason.'));
    assert.deepEqual(optionsOf(out, 'an-kind'), [{ value: 'away', selected: true, label: 'Away' }, { value: 'late', selected: false, label: 'Late' }, { value: 'leaving', selected: false, label: 'Leaving early' }]);
    assert.deepEqual(optionsOf(out, 'an-repeat'), [{ value: 'range', selected: true, label: 'A date range' }, { value: 'weekly', selected: false, label: 'Every week on one day' }]);
    assert.deepEqual(optionsOf(out, 'an-weekday').map(o => o.label), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], 'the week reads Monday first');
    assert.deepEqual(optionsOf(out, 'an-weekday').filter(o => o.selected).map(o => o.value), ['0'], 'today is a Sunday');
    assert(/id="an-from" name="from" data-field="from" data-change="away-from-change" data-key="an-from" min="2026-10-18" value="2026-10-18"/.test(out));
    assert(/id="an-to" name="to" data-field="to" value="2026-10-18"/.test(out), 'To starts as From: a one-day notice needs no second date');
    assert(/id="an-time-field" hidden>/.test(out) && /id="an-weekday-field" hidden>/.test(out));
    assert(out.includes('id="an-from-label" for="an-from">From<') && out.includes('id="an-to-label" for="an-to">To<') && out.includes('id="an-time-label" for="an-time">Leaving at<'));
    assert(/id="an-reason" name="reason" data-field="reason" maxlength="120" autocomplete="off" value=""/.test(out));
    for (const f of ['kind', 'atTime', 'weekday', 'from', 'to', 'reason']) assert(out.includes('id="dlg-err-' + f + '" role="alert" hidden'), f);
    assert(out.includes('id="dlg-error" role="alert" hidden') && out.includes('data-change="away-form-change"'));
    assertNoRawAttrs(out);
    assert(!G.pages.away.dialogHtml({ mode: 'add', ctx: 'person', personId: 'p_x', today: TODAY, who: 'Thoren' }).includes(' min='), 'an officer is not held to today');
  });

  await check('away dialog: Edit starts from the notice - a weekly Late shows its time, day and end, with Starting / Until labels; a started notice keeps its start as min', () => {
    const out = G.pages.away.dialogHtml({ mode: 'edit', ctx: 'mine', nid: 'an_3', notice: N_LATE, today: TODAY, minToday: true });
    assert(out.includes('Change an away notice') && out.includes('data-mode="edit"') && out.includes('data-nid="an_3"'));
    assert.deepEqual(optionsOf(out, 'an-kind').filter(o => o.selected).map(o => o.value), ['late']);
    assert.deepEqual(optionsOf(out, 'an-repeat').filter(o => o.selected).map(o => o.value), ['weekly']);
    assert.deepEqual(optionsOf(out, 'an-weekday').filter(o => o.selected).map(o => o.value), ['2']);
    assert(/id="an-time" name="atTime" data-field="atTime" value="21:00"/.test(out) && !/id="an-time-field" hidden/.test(out) && !/id="an-weekday-field" hidden/.test(out));
    assert(/name="from" data-field="from" data-change="away-from-change" data-key="an-from" min="2026-10-13" value="2026-10-13"/.test(out) && /name="to" data-field="to" value="2026-12-01"/.test(out));
    assert(out.includes('id="an-from-label" for="an-from">Starting<') && out.includes('id="an-to-label" for="an-to">Until (optional)<') && out.includes('>Arriving at<'));
    assert(/name="reason"[^>]*value="Work"/.test(out));
    assert(/name="from" data-field="from" data-change="away-from-change" data-key="an-from" min="2026-10-18" value="2026-10-20"/.test(G.pages.away.dialogHtml({ mode: 'edit', ctx: 'mine', nid: 'an_1', notice: N_RANGE, today: TODAY, minToday: true })), 'a future start: min is today');
  });

  await check('away dialog: the kind and "When" selects show and hide the fields in place and rename their labels', withState(async () => {
    const ids = ['an-time-field', 'an-weekday-field', 'an-time-label', 'an-from-label', 'an-to-label'];
    ids.forEach(id => fakeEl(id));
    els['an-time-field'].hidden = true; els['an-weekday-field'].hidden = true;
    const form = { elements: { kind: control('late'), repeat: control('weekly') } };
    G.handlers.change['away-form-change']({ closest: () => form });
    assert.equal(els['an-time-field'].hidden, false);
    assert.equal(els['an-weekday-field'].hidden, false);
    assert.deepEqual([els['an-time-label'].textContent, els['an-from-label'].textContent, els['an-to-label'].textContent], ['Arriving at', 'Starting', 'Until (optional)']);
    form.elements.kind.value = 'leaving'; form.elements.repeat.value = 'range';
    G.handlers.change['away-form-change']({ closest: () => form });
    assert.deepEqual([els['an-time-label'].textContent, els['an-from-label'].textContent, els['an-to-label'].textContent, els['an-weekday-field'].hidden], ['Leaving at', 'From', 'To', true]);
    form.elements.kind.value = 'away';
    G.handlers.change['away-form-change']({ closest: () => form });
    assert.equal(els['an-time-field'].hidden, true);
  }));

  await check('away request body: a range sends from and to and no weekday; a weekly notice sends the weekday as a number and to only when given; Late and Leaving send the time; a blank reason sends nothing', () => {
    const B = G.pages.away.bodyFrom;
    const v = (o) => Object.assign({ kind: 'away', repeat: 'range', weekday: '4', from: '2026-10-20', to: '2026-10-27', atTime: '', reason: '', person: '' }, o || {});
    assert.deepEqual(plain(B(v())), { kind: 'away', from: '2026-10-20', to: '2026-10-27' });
    assert.deepEqual(plain(B(v({ reason: '  Wedding ' }))), { kind: 'away', from: '2026-10-20', to: '2026-10-27', reason: 'Wedding' });
    const weekly = B(v({ repeat: 'weekly', to: '' }));
    assert.deepEqual(plain(weekly), { kind: 'away', from: '2026-10-20', weekday: 4 });
    assert.equal(typeof weekly.weekday, 'number');
    assert(!('to' in weekly) && !('atTime' in weekly) && !('reason' in weekly) && !('personId' in weekly));
    assert.deepEqual(plain(B(v({ repeat: 'weekly', weekday: '0', to: '2026-12-01', kind: 'late', atTime: '21:00', reason: 'Work' }))), { kind: 'late', from: '2026-10-20', weekday: 0, to: '2026-12-01', atTime: '21:00', reason: 'Work' }, 'Sunday is 0, not left out');
    assert.deepEqual(plain(B(v({ kind: 'leaving', atTime: '22:00', atTimeUnused: 1, weekday: '2' }))), { kind: 'leaving', from: '2026-10-20', to: '2026-10-27', atTime: '22:00' }, 'a range ignores the weekday control');
    assert.equal(B(v(), 'p_x').personId, 'p_x');
    assert(!('atTime' in B(v({ kind: 'away', atTime: '21:00' }))), 'Away has no time');
  });

  await check('away validation: what the Worker would refuse is caught first and named at its field - no first day, no end for a range, end before start, no time for Late / Leaving, a long reason, no person', () => {
    const P = G.pages.away.problemOf;
    const v = (o) => Object.assign({ kind: 'away', repeat: 'range', weekday: '4', from: '2026-10-20', to: '2026-10-27', atTime: '', reason: '', person: 'p_x' }, o || {});
    assert.equal(P(v(), true), null);
    assert.deepEqual(plain(P(v({ from: '' }))), { field: 'from', text: 'Pick the first day.' });
    assert.deepEqual(plain(P(v({ from: '', repeat: 'weekly' }))), { field: 'from', text: 'Pick the day it starts.' });
    assert.equal(P(v({ to: '' })).field, 'to');
    assert.equal(P(v({ to: '' })).text, 'Add a To date, or choose Every week on one day.');
    assert.equal(P(v({ repeat: 'weekly', to: '' })), null, 'a weekly notice may be open-ended');
    assert.deepEqual(plain(P(v({ to: '2026-10-19' }))), { field: 'to', text: 'The end cannot be before the start.' });
    assert.equal(P(v({ repeat: 'weekly', to: '2026-10-01' })).field, 'to');
    assert.deepEqual(plain(P(v({ kind: 'late', atTime: '' }))), { field: 'atTime', text: 'Say what time you arrive.' });
    assert.deepEqual(plain(P(v({ kind: 'leaving', atTime: '25:00' }))), { field: 'atTime', text: 'Say what time you leave.' });
    assert.equal(P(v({ kind: 'late', atTime: '21:00' })), null);
    assert.deepEqual(plain(P(v({ reason: 'x'.repeat(121) }))), { field: 'reason', text: 'A reason is at most 120 characters.' });
    assert.equal(P(v({ reason: 'x'.repeat(120) })), null);
    assert.deepEqual(plain(P(v({ person: '' }), true)), { field: 'personId', text: 'Choose a person.' });
    assert.equal(P(v({ person: '' }), false), null);
  });

  // A dialog form the handlers can read: controls by name, the error slots by id, the controls by data-field.
  const dlgForm = (vals, attrs) => {
    const controls = {};
    for (const [k, val] of Object.entries(vals)) controls[k] = control(val);
    return {
      getAttribute: k => (attrs && k in attrs ? attrs[k] : null), elements: controls,
      querySelector: sel => { const m = /^\[data-field="([^"]+)"\]$/.exec(sel); if (m) return controls[m[1] === 'personId' ? 'person' : m[1] === 'atTime' ? 'atTime' : m[1]] || null; const id = /^#(.+)$/.exec(sel); return id ? els[id[1]] || null : null; },
      querySelectorAll: () => [],
    };
  };
  const slotIds = ['kind', 'atTime', 'weekday', 'from', 'to', 'reason', 'personId', 'repeat'].map(f => 'dlg-err-' + f).concat(['dlg-error']);
  const FORM = (o) => Object.assign({ kind: 'away', repeat: 'range', weekday: '4', from: '2026-10-20', to: '2026-10-27', atTime: '', reason: '', person: '' }, o || {});

  await check('away form (mine): Add posts the body, replaces my list with the answer and says so; Edit puts the full body to the notice and never sends a person', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    S.att.away = { gid: 'g1', data: MINE().data, showPast: false, note: '' };
    slotIds.forEach(id => fakeEl(id, { hidden: true }));
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf;
    G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => {};
    const added = notice({ id: 'an_new', from: '2026-10-30', to: '2026-11-02', reason: 'Trip' });
    let s = stub(() => Promise.resolve({ notice: added, notices: [added, N_RANGE] }));
    G.handlers.submit['away-form'](dlgForm(FORM({ from: '2026-10-30', to: '2026-11-02', reason: ' Trip ' }), { 'data-ctx': 'mine', 'data-mode': 'add' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/away', { kind: 'away', from: '2026-10-30', to: '2026-11-02', reason: 'Trip' }]]);
    assert.deepEqual(S.att.away.data.notices.map(n => n.id), ['an_new', 'an_1']);
    assert.equal(S.att.away.note, 'Notice saved.');
    s.restore();
    s = stub(() => Promise.resolve({ notice: N_LATE, notices: [N_LATE] }));
    G.handlers.submit['away-form'](dlgForm(FORM({ kind: 'late', repeat: 'weekly', weekday: '2', from: '2026-10-13', to: '', atTime: '21:30' }), { 'data-ctx': 'mine', 'data-mode': 'edit', 'data-nid': 'an_3' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/away/an_3', { kind: 'late', from: '2026-10-13', weekday: 2, atTime: '21:30' }]]);
    s.restore();
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
  }));

  await check('away form: a problem found here never leaves the browser - it shows at its field, marks it invalid and moves focus there', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    slotIds.forEach(id => fakeEl(id, { hidden: true }));
    const s = stub(() => Promise.resolve({}));
    const form = dlgForm(FORM({ to: '' }), { 'data-ctx': 'mine', 'data-mode': 'add' });
    G.handlers.submit['away-form'](form);
    assert.equal(s.calls.length, 0);
    assert.equal(els['dlg-err-to'].textContent, 'Add a To date, or choose Every week on one day.');
    assert.equal(els['dlg-err-to'].hidden, false);
    assert.equal(form.elements.to.attrs['aria-invalid'], 'true');
    assert.equal(form.elements.to.focused, 1);
    // The next try clears it.
    form.elements.to.value = '2026-10-27';
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf; G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => {};
    S.att.away = { gid: 'g1', data: MINE().data, showPast: false, note: '' };
    G.handlers.submit['away-form'](form);
    await settle();
    assert.equal(els['dlg-err-to'].textContent, '');
    assert.equal(s.calls.length, 1);
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
    s.restore();
  }));

  await check('away form: the Worker\'s 400 lands at the field it names (from, to, weekday, atTime, reason); a full list (409 too_many_notices) and other errors in the dialog', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    S.att.away = { gid: 'g1', data: MINE().data, showPast: false, note: '' };
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf; G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => {};
    for (const [field, message] of [['from', 'A notice cannot start before today.'], ['to', 'A date range is at most 366 days.'], ['atTime', 'Say what time you arrive.'], ['reason', 'A reason is at most 120 characters.'], ['weekday', 'weekday is 0 (Sunday) to 6 (Saturday).']]) {
      slotIds.forEach(id => fakeEl(id, { hidden: true }));
      const s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message, field })));
      const form = dlgForm(FORM({ kind: 'late', atTime: '21:00' }), { 'data-ctx': 'mine', 'data-mode': 'add' });
      G.handlers.submit['away-form'](form);
      await settle();
      assert.equal(els['dlg-err-' + field].textContent, message, field);
      assert.equal(els['dlg-error'].hidden, true, field);
      assert.equal(form.elements[field].attrs['aria-invalid'], 'true', field);
      assert.equal(form.elements[field].focused, 1, field);
      s.restore();
    }
    slotIds.forEach(id => fakeEl(id, { hidden: true }));
    const full = stub(() => Promise.reject(new ApiErr(409, 'too_many_notices', { message: 'You have 30 notices, the most there can be. Remove one first.', max: 30 })));
    G.handlers.submit['away-form'](dlgForm(FORM(), { 'data-ctx': 'mine', 'data-mode': 'add' }));
    await settle();
    assert.equal(els['dlg-error'].textContent, 'You have 30 notices, the most there can be. Remove one first.');
    full.restore();
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
  }));

  await check('away remove: the dialog names the notice and asks first; Remove deletes it and shows the list the Worker answered with', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    S.att.away = { gid: 'g1', data: MINE().data, showPast: false, note: '' };
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html, o) => { opened.push({ html, o }); return null; };
    G.handlers.click['away-remove'](el({ 'data-ctx': 'mine', 'data-nid': 'an_1' }));
    G.handlers.click['away-remove'](el({ 'data-ctx': 'mine', 'data-nid': 'an_nope' }));
    G.ui.openDialog = realOpen;
    assert.equal(opened.length, 1, 'an unknown notice opens nothing');
    assert(opened[0].html.includes('Remove this notice?') && opened[0].html.includes('Away Oct 20 - Oct 27') && opened[0].html.includes('data-submit="away-remove-form"') && opened[0].html.includes('data-nid="an_1"'));
    assert.equal(opened[0].o.describedBy, 'dlg-text');
    const realRun = G.ui.runDialog; G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    const s = stub(() => Promise.resolve({ deleted: true, notices: [N_WEEKLY] }));
    G.handlers.submit['away-remove-form'](el({ 'data-ctx': 'mine', 'data-nid': 'an_1' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/away/an_1']]);
    assert.deepEqual(S.att.away.data.notices.map(n => n.id), ['an_2']);
    assert.equal(S.att.away.note, 'Notice removed.');
    s.restore(); G.ui.runDialog = realRun;
  }));

  await check('away Edit and Add buttons: they open the dialog for that notice / that person', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    S.att.away = { gid: 'g1', data: MINE().data, showPast: false, note: '' };
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html, o) => { opened.push(html); return null; };
    fakeEl('an-kind');
    G.handlers.click['away-edit'](el({ 'data-ctx': 'mine', 'data-nid': 'an_3' }));
    G.handlers.click['away-edit'](el({ 'data-ctx': 'mine', 'data-nid': 'an_nope' }));
    G.handlers.click['away-add'](el({ 'data-ctx': 'mine' }));
    G.ui.openDialog = realOpen;
    assert.equal(opened.length, 2);
    assert(opened[0].includes('Change an away notice') && opened[0].includes('data-nid="an_3"') && opened[0].includes('value="21:00"'));
    assert(opened[1].includes('Add an away notice') && opened[1].includes('min="2026-10-18"'));
    assert.equal(els['an-kind'].focused, 2);
  }));

  // ── the officers' card on the Raids page ──
  const ENTRY = (over) => Object.assign({ noticeId: 'an_1', personId: 'p_x', name: 'Thoren', class: 'PALADIN', kind: 'away', atTime: null, from: '2026-10-20', to: '2026-10-27', weekday: null, reason: 'Wedding', dates: [] }, over || {});
  const TEAMDATA = (entries) => ({ team: { id: 't1', name: 'Team KJ' }, today: TODAY, until: '2026-11-15', entries: entries || [ENTRY(), ENTRY({ noticeId: 'an_2', personId: 'p_y', name: 'Kaelith', class: 'ROGUE', kind: 'late', atTime: '21:00', from: '2026-10-22', to: null, weekday: 4, reason: null, dates: ['2026-10-22', '2026-10-29', '2026-11-05'] })] });
  const teamCard = (state, can) => G.pages.away.teamCardHtml({ guildData: gd(can || OFFICER_CAN), teamId: 't1', state });

  await check('Raids page (officers): "Away, next 4 weeks" lists name in class colour, what, the dates of a weekly one and the reason, with Edit / Remove and Add; nothing for members or while loading', () => {
    const out = teamCard({ gid: 'g1', teamId: 't1', status: 'ok', data: TEAMDATA() });
    assert(out.includes('<h2 class="gs-h2" id="an-team-h">Away, next 4 weeks</h2>') && out.includes('data-action="away-add" data-ctx="team" data-key="an-team-add"><span>Add a notice<'));
    assert(/<a class="gs-char-link gs-class-paladin" href="#\/g\/g1\/roster\/p\/p_x">Thoren<\/a>/.test(out) && /gs-class-rogue" href="#\/g\/g1\/roster\/p\/p_y">Kaelith</.test(out));
    assert(out.includes('Away Oct 20 - Oct 27') && out.includes('Reason: Wedding'));
    assert(out.includes('Late, arriving 21:00, every Thursday') && out.includes('Oct 22, Oct 29, Nov 5'), 'the dates of a weekly notice');
    assert(!out.includes('Oct 21, Oct 22'), 'a range is not spelled out day by day');
    assert(/aria-label="Edit: Away Oct 20 - Oct 27 for Thoren" data-action="away-edit" data-ctx="team" data-nid="an_1" data-key="an-edit-an_1">/.test(out));
    assert(/data-action="away-remove" data-ctx="team" data-nid="an_2"/.test(out));
    assert(teamCard({ gid: 'g1', teamId: 't1', status: 'ok', data: TEAMDATA([]) }).includes('No one has an away notice for the next 4 weeks.'));
    assert.equal(teamCard({ gid: 'g1', teamId: 't1', status: 'loading', data: null }), '');
    assert.equal(teamCard(null), '');
    assert.equal(teamCard({ gid: 'g1', teamId: 't2', status: 'ok', data: TEAMDATA() }), '', 'another team\'s data');
    assert.equal(teamCard({ gid: 'g1', teamId: 't1', status: 'ok', data: TEAMDATA() }, MEMBER_CAN), '', 'members have no card');
    const err = teamCard({ gid: 'g1', teamId: 't1', status: 'error', message: 'Could not reach Raidsmith.' });
    assert(err.includes('Could not reach Raidsmith.') && err.includes('data-action="away-team-retry"') && !err.includes('away-add'));
    assertNoRawAttrs(out);
  });

  await check('Raids page: "My away notices" links to the page for everyone; the card is drawn under the list for officers', () => {
    for (const can of [MEMBER_CAN, OFFICER_CAN]) {
      const out = ws(G.pages.raids.raidsHtml({ guildData: gd(can), teamId: 't1', data: LIST({ can: { edit: can === OFFICER_CAN, signup: true } }), tab: 'upcoming' }));
      assert(/<a class="gs-menu-item" role="menuitem" tabindex="-1" href="#\/g\/g1\/away">My away notices<\/a>/.test(out), 'a menu item of the More menu');
    }
    const withCard = ws(G.pages.raids.raidsHtml({ guildData: gd(OFFICER_CAN), teamId: 't1', data: LIST({ can: { edit: true, signup: false } }), tab: 'upcoming', awayHtml: teamCard({ gid: 'g1', teamId: 't1', status: 'ok', data: TEAMDATA() }) }));
    assert(withCard.indexOf('Away, next 4 weeks') > withCard.indexOf('Upcoming raids'));
  });

  await check('Raids page: the card loads itself once per list after the page is drawn (an officer), never for a member; Add reads the team\'s roster for the person picker (not the inactive)', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const route = { name: 'section', gid: 'g1', section: 'raids' };
    const list = S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ can: { edit: true, signup: false } }), more: false, tab: 'upcoming' };
    const s = stub((m, url) => Promise.resolve(url.includes('/away?team=') ? TEAMDATA() : { people: [
      { id: 'p_b', main: { name: 'Zed' }, status: 'raider' }, { id: 'p_a', main: { name: 'Anna' }, status: 'trial' }, { id: 'p_i', main: { name: 'Gone' }, status: 'inactive' }, { id: 'p_c', shown: { name: 'Cleo' }, status: 'raider' }] }));
    G.pages.away.afterRender(route);
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/away?team=t1']]);
    assert.equal(S.att.awayTeam.status, 'ok');
    assert.equal(S.att.awayTeam.data.entries.length, 2);
    G.pages.away.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 1, 'drawn again: no second read');
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ can: { edit: true, signup: false } }), more: false, tab: 'upcoming' };
    G.pages.away.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 2, 'a fresh list reads again');
    // Add: the roster, then the dialog with the picker.
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html) => { opened.push(html); return null; };
    s.calls.length = 0;
    G.handlers.click['away-add'](el({ 'data-ctx': 'team' }));
    await settle();
    G.ui.openDialog = realOpen;
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/roster?team=t1']);
    assert.deepEqual(optionsOf(opened[0], 'an-person').map(o => o.label), ['Choose a person', 'Anna', 'Cleo', 'Zed']);
    assert(opened[0].includes('data-ctx="team"') && !opened[0].includes(' min='));
    // A member's list never loads it.
    S.att.awayTeam = null;
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ can: { edit: false, signup: true } }), more: false, tab: 'upcoming' };
    s.calls.length = 0;
    G.pages.away.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 0);
    s.restore();
  }));

  await check('Raids page card: Add for a person posts with their id and reads the card again; Edit puts without a person; a failed read is a card with Try again', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ can: { edit: true, signup: false } }) };
    S.att.awayTeam = { gid: 'g1', teamId: 't1', status: 'ok', data: TEAMDATA(), message: '', forList: S.att.raids };
    slotIds.forEach(id => fakeEl(id, { hidden: true }));
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf; G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => {};
    let s = stub((m, url) => Promise.resolve(m === 'get' ? TEAMDATA([ENTRY()]) : { notice: notice(), notices: [] }));
    G.handlers.submit['away-form'](dlgForm(FORM({ person: 'p_x' }), { 'data-ctx': 'team', 'data-mode': 'add' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/away', { kind: 'away', from: '2026-10-20', to: '2026-10-27', personId: 'p_x' }], ['get', '/api/guild/g1/away?team=t1', undefined]]);
    assert.equal(S.att.awayTeam.data.entries.length, 1, 'the card shows the new list');
    s.calls.length = 0;
    G.handlers.submit['away-form'](dlgForm(FORM({ person: '' }), { 'data-ctx': 'team', 'data-mode': 'add' }));
    assert.equal(s.calls.length, 0, 'no person chosen');
    assert.equal(els['dlg-err-personId'].textContent, 'Choose a person.');
    G.handlers.submit['away-form'](dlgForm(FORM({ kind: 'leaving', atTime: '22:00', person: 'p_x' }), { 'data-ctx': 'team', 'data-mode': 'edit', 'data-nid': 'an_1' }));
    await settle();
    assert.deepEqual(s.calls[0] && [s.calls[0].m, s.calls[0].url, s.calls[0].body], ['put', '/api/guild/g1/away/an_1', { kind: 'leaving', from: '2026-10-20', to: '2026-10-27', atTime: '22:00' }]);
    s.restore();
    s = stub(() => Promise.reject(new ApiErr(0, 'network', { message: 'Could not reach Raidsmith.' })));
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ can: { edit: true, signup: false } }) };
    G.pages.away.afterRender({ name: 'section', gid: 'g1', section: 'raids' });
    await settle();
    assert.deepEqual([S.att.awayTeam.status, S.att.awayTeam.message], ['error', 'Could not reach Raidsmith.']);
    s.restore();
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
  }));

  // ── the officers' section on the person page ──
  const RECORD = (can) => ({ person: { id: 'p_x', isMe: false, status: 'raider' }, characters: [{ id: 'c_1', name: 'Thoren', class: 'PALADIN', isMain: true, team: { id: 't1', name: 'Team KJ' } }], can: { edit: true } });
  const personCard = (state, can, record) => G.pages.away.personCardHtml({ guildData: gd(can || OFFICER_CAN), record: record || RECORD(), state });

  await check('person page (officers): an "Away notices" section with every notice (ended last), Edit / Remove and Add for that person; hidden for members, for a person on no team of theirs, and while loading or denied', () => {
    const st = (over) => Object.assign({ gid: 'g1', pid: 'p_x', status: 'ok', data: { personId: 'p_x', today: TODAY, notices: [N_PAST, N_RANGE, N_WEEKLY] }, message: '' }, over || {});
    const out = personCard(st());
    assert(out.includes('<h2 class="gs-h2" id="away-h">Away notices</h2>') && /data-action="away-add" data-ctx="person" data-pid="p_x" data-key="an-person-add"><span>Add a notice</.test(out));
    assert(out.indexOf('Away Oct 20 - Oct 27') < out.indexOf('Away Sep 1 - Sep 5'), 'ended last');
    assert(/data-action="away-edit" data-ctx="person" data-nid="an_1"[^>]*data-pid="p_x"/.test(out) && /data-action="away-remove" data-ctx="person" data-nid="an_2"[^>]*data-pid="p_x"/.test(out));
    assert(personCard(st({ data: { personId: 'p_x', today: TODAY, notices: [] } })).includes('No away notices.'));
    assert.equal(personCard(st(), MEMBER_CAN), '', 'a member has no raids.edit');
    assert.equal(personCard(st(), { 'raids.edit': ['t9'] }), '', 'raids.edit on another team only');
    assert(personCard(st(), { 'raids.edit': ['t1'] }) !== '', 'a lead of the person\'s team');
    assert.equal(personCard(st({ status: 'loading' })), '');
    assert.equal(personCard(st({ status: 'denied' })), '');
    assert.equal(personCard(st({ pid: 'p_other' })), '');
    assert.equal(personCard(null), '');
    assert(personCard(st({ status: 'error', message: 'Down.' })).includes('data-action="away-person-retry"'));
    assertNoRawAttrs(out);
    assert.equal(G.pages.away.canEditPerson(gd(OFFICER_CAN), { characters: [] }), false);
  });

  await check('person page: the section loads itself once per record; Add posts with the person\'s id and replaces the list with the answer; a 403 hides it', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const rec = S.person = { gid: 'g1', pid: 'p_x', record: RECORD() };
    const route = { name: 'person', gid: 'g1', pid: 'p_x' };
    let s = stub(() => Promise.resolve({ personId: 'p_x', today: TODAY, notices: [N_RANGE] }));
    G.pages.away.afterRender(route);
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/away?person=p_x']]);
    G.pages.away.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 1);
    slotIds.forEach(id => fakeEl(id, { hidden: true }));
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf; G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => {};
    s.restore();
    const second = notice({ id: 'an_n2', from: '2026-11-01', to: '2026-11-03' });
    s = stub(() => Promise.resolve({ notice: second, notices: [N_RANGE, second] }));
    G.handlers.submit['away-form'](dlgForm(FORM({ from: '2026-11-01', to: '2026-11-03' }), { 'data-ctx': 'person', 'data-mode': 'add', 'data-pid': 'p_x' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/away', { kind: 'away', from: '2026-11-01', to: '2026-11-03', personId: 'p_x' }]]);
    assert.deepEqual(S.att.awayPerson.data.notices.map(n => n.id), ['an_1', 'an_n2']);
    s.restore();
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
    // Another person, refused.
    S.person = { gid: 'g1', pid: 'p_y', record: RECORD() };
    const denied = stub(() => Promise.reject(new ApiErr(403, 'forbidden', { message: 'No.' })));
    G.pages.away.afterRender({ name: 'person', gid: 'g1', pid: 'p_y' });
    await settle();
    assert.equal(S.att.awayPerson.status, 'denied');
    assert.equal(personCard(S.att.awayPerson), '');
    denied.restore();
    // A member's person page never asks.
    S.guilds.g1 = gd(MEMBER_CAN);
    S.person = { gid: 'g1', pid: 'p_z', record: RECORD() };
    const none = stub(() => Promise.resolve({}));
    G.pages.away.afterRender({ name: 'person', gid: 'g1', pid: 'p_z' });
    await settle();
    assert.equal(none.calls.length, 0);
    none.restore();
    assert(read('js/guild/pages-person.js').includes('opts.away') && /away: P\.away\.personSectionOf/.test(read('js/guild/app.js')));
  }));

  // ── the Sign-ups panel: Standby and away notices ──
  const AWAY_ENTRY = entry({ key: 'a:p_aw', personId: 'p_aw', source: 'away', kind: 'absence', name: 'Garrosh', classId: 'WARRIOR', className: 'Warrior', spec: null, role: null, characterId: null, note: null });
  const STANDBY_ENTRY = entry({ key: 'p:p_sb', personId: 'p_sb', kind: 'standby', name: 'Dorrin', classId: 'PRIEST', className: 'Priest', spec: 'Holy', role: 'healer', characterId: 'c_do' });
  const LATE_NOTICED = entry({ key: 'p:p_ln', personId: 'p_ln', name: 'Kaelith', classId: 'ROGUE', className: 'Rogue', spec: 'Combat', role: 'melee', notice: { kind: 'late', atTime: '21:00' } });
  const PANEL_COUNTS = Object.assign({}, COUNTS, { standby: 1, absence: 2, expected: 19 });

  await check('panel: a fifth member button, Standby, with the one-line hint; the officer\'s status list has Standby', () => {
    const out = panel(view());
    assert(/data-action="su-kind" data-kind="standby" data-key="su-kind-standby" aria-pressed="false" aria-describedby="su-standby-hint">Standby<\/button>/.test(out));
    assert(out.includes('<p class="gs-fine" id="su-standby-hint">Standby: Happy to sit out if needed.</p>'));
    assert.deepEqual([...out.matchAll(/data-action="su-kind" data-kind="(\w+)"/g)].map(m => m[1]), ['signed', 'late', 'standby', 'tentative', 'absence']);
    const mine = view({ me: Object.assign({}, view().me, { signup: entry({ kind: 'standby', isMe: true }) }) });
    assert(/data-kind="standby"[^>]*aria-pressed="true"/.test(panel(mine)) && panel(mine).includes('You are down as <strong>standby</strong>'));
    assert(/<option value="standby"/.test(G.pages.raidSignups.editDialogHtml({ view: OFFICER_VIEW(), personId: 'p_t' })), 'the officer dialog');
    assert.equal(G.pages.attendance.KIND_LABELS.standby, 'Standby');
    assert(/data-kind="standby"[^>]*disabled/.test(panel(view({ me: Object.assign({}, view().me, { canChange: false, closed: 'locked' }) }, { closed: 'locked', locked: true }))));
  });
  function OFFICER_VIEW(over) {
    return view(Object.assign({ can: { edit: true, self: false, seeList: true, seeNicknames: true }, me: null, roster: [{ personId: 'p_t', name: 'Thoren', status: 'raider', characters: [{ id: 'c_th', name: 'Thoren', class: 'PALADIN', mainSpec: 'Protection', offSpec: null, isMain: true, teamId: 't1', specs: ['Protection', 'Holy'] }] }, { personId: 'p_aw', name: 'Garrosh', status: 'raider', characters: [{ id: 'c_ga', name: 'Garrosh', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, isMain: true, teamId: 't1', specs: ['Arms', 'Fury'] }] }] }, over || {}));
  }

  await check('panel: Standby is counted and has its own group (after the roles, before Tentative); a person away by notice is in Absent as "Away (notice)" with no Edit or Remove, even for an officer', () => {
    const v = OFFICER_VIEW({ counts: PANEL_COUNTS, entries: [entry(), STANDBY_ENTRY, AWAY_ENTRY, entry({ key: 'p:p_a', personId: 'p_a', name: 'Veyla', kind: 'absence', role: null })] });
    const out = ws(panel(v, { guildData: gd(OFFICER_CAN) }));
    const text = stripTags(out);
    assert(/Expected 19 \/ 20 Signed 17 Late 1 Standby 1 Tentative 1 Bench 1 Can&#39;t come 2/.test(text), text.slice(0, 300));
    assert(out.includes('<h3 class="gs-su-group-h" id="su-g-standby">Standby <span class="gs-su-count">1</span></h3>'));
    assert(out.indexOf('id="su-g-tank"') < out.indexOf('id="su-g-standby"') && out.indexOf('id="su-g-standby"') < out.indexOf('id="su-g-absence"'));
    const absent = out.slice(out.indexOf('id="su-g-absence"'));
    assert(absent.includes('Garrosh') && /gs-schip-warning[^>]*>.*?<\/svg>Away \(notice\)<\/span>/.test(absent));
    assert(!/data-action="su-(edit|remove)" data-pid="p_aw"/.test(out), 'nothing to edit or remove on an away entry');
    assert(/data-action="su-edit" data-pid="p_a"/.test(out), 'a real Absent sign-up still has its tools');
    // The Add dialog says the person is away and starts from a fresh sign-up.
    const dlg = G.pages.raidSignups.editDialogHtml({ view: v, personId: null });
    assert(dlg.includes('Garrosh - Away (notice)'), dlg.slice(0, 400));
    const forAway = G.pages.raidSignups.editDialogHtml({ view: v, personId: 'p_aw' });
    assert(/<option value="signed" selected>/.test(forAway), 'starts as Signed up, not Absent');
    assertNoRawAttrs(out);
  });

  await check('panel: Late / Leaving notices - "Late 21:00" on a person\'s row, "Leaves 22:00" in a Notices group for people with no sign-up yet; escaped', () => {
    const v = view({ entries: [LATE_NOTICED, entry()], notices: [{ personId: 'p_ln', name: 'Kaelith', kind: 'late', atTime: '21:00' }, { personId: 'p_nn', name: 'Nodisc', kind: 'leaving', atTime: '22:00' }] });
    const out = ws(panel(v));
    assert(/gs-schip-warning[^>]*>.*?<\/svg>Late 21:00<\/span>/.test(out));
    const notices = out.slice(out.indexOf('id="su-g-notices"'));
    assert(notices.includes('Nodisc') && notices.includes('Leaves 22:00') && !notices.includes('Kaelith'), 'Kaelith already shows hers on the row');
    assert(out.includes('<h3 class="gs-su-group-h" id="su-g-notices">Notices <span class="gs-su-count">1</span>'));
    assert(!panel(view({ entries: [entry()], notices: null })).includes('su-g-notices') && !panel(view({ entries: [entry()], notices: [] })).includes('su-g-notices'));
    assert(panel(view({ entries: [], notices: [{ personId: 'p_nn', name: 'Nodisc', kind: 'leaving', atTime: '22:00' }] })).includes('No sign-ups yet.') && panel(view({ entries: [], notices: [{ personId: 'p_nn', name: 'Nodisc', kind: 'leaving', atTime: '22:00' }] })).includes('Leaves 22:00'));
    assertEscaped(panel(view({ entries: [entry({ notice: { kind: 'late', atTime: HOSTILE } })], notices: [{ personId: 'p_nn', name: HOSTILE + QUOTES, kind: 'leaving', atTime: HOSTILE }] })), 'notices');
  });

  await check('panel: "You are away (notice). Choosing a status here overrides it." - no button pressed, nothing to save or remove; the viewer\'s own Late / Leaving notice is named; a status button still sends', withState(async (S) => {
    const away = view({ me: Object.assign({}, view().me, { signup: Object.assign({}, AWAY_ENTRY, { isMe: true, name: 'Eliora' }), notice: null }) });
    const out = panel(away);
    assert(out.includes('You are away (notice). Choosing a status here overrides it.'));
    assert(!/aria-pressed="true"/.test(out) && !out.includes('Save details') && !out.includes('su-withdraw'));
    assert(!/data-kind="\w+"[^>]*disabled/.test(out), 'the buttons work');
    const noticed = panel(view({ me: Object.assign({}, view().me, { notice: { kind: 'leaving', atTime: '22:00' } }) }));
    assert(noticed.includes('Your notice for this raid: Leaves 22:00.') && noticed.includes('You are down as <strong>signed up</strong>'));
    assert(panel(view({ me: Object.assign({}, view().me, { signup: null, notice: { kind: 'late', atTime: '21:00' } }) })).includes('Your notice for this raid: Late 21:00.'));
    const x = openRaid(S, away);
    const answer = view({ me: Object.assign({}, view().me, { signup: entry({ kind: 'standby', isMe: true }) }) });
    const s = stub(() => Promise.resolve(answer));
    G.handlers.click['su-kind'](el({ 'data-kind': 'standby' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/raids/u1/signup', { kind: 'standby', characterId: 'c_eli', spec: 'Holy', note: null }]]);
    assert.equal(x.data, answer);
    s.restore();
  }));

  await check('Raids list: the count names Standby ("18 / 20 signed up, 2 standby"); the row chip says Standby or Away (notice), and Sign up stays offered to a person who is away; a sign-up answer folds the standby count in', () => {
    const T = G.pages.raids.signupsText;
    assert.equal(T({ signed: 14, late: 1, standby: 2, bench: 1, tentative: 0, absence: 3 }, 20), '17 / 20 signed up, 2 standby, 1 bench, 3 can\'t come', 'standby is expected');
    assert.equal(T({ signed: 5, late: 0, standby: 2, bench: 0, tentative: 0, absence: 0 }), '5 signed, 2 standby');
    assert.equal(T({ signed: 0, late: 0, standby: 1, bench: 0, tentative: 0, absence: 0 }, 10), '1 / 10 signed up, 1 standby', 'only a standby is a sign-up');
    const sb = listPage(LIST({ upcoming: [UP({ mine: { kind: 'standby', source: 'raidsmith', characterName: 'Eliora' } })] }));
    assert(sb.includes('Standby - Eliora') && /data-action="raids-signup"/.test(sb));
    const away = listPage(LIST({ upcoming: [UP({ mine: { kind: 'absence', source: 'away', characterName: null } })] }));
    assert(/gs-schip-warning[^>]*>.*?<\/svg>Away \(notice\)<\/span>/.test(away) && /data-action="raids-signup"/.test(away), 'a real sign-up can override it');
    assert(!away.includes('Absence'));
    const row = { id: 'u1', signups: {}, mine: null };
    G.pages.raids.applySignupView({ data: { upcoming: [row] } }, 'u1', view({ counts: Object.assign({}, COUNTS, { standby: 2 }) }));
    assert.equal(row.signups.standby, 2);
  });

  // ═══ 8. Standing sign-ups and the published roster ═══════════════
  const dec = (s) => String(s).replace(/&#39;/g, '\'');
  const ST_CHARS = [{ id: 'c_eli', name: 'Eliora', class: 'PRIEST', mainSpec: 'Holy', isMain: true, specs: ['Holy', 'Shadow'] }, { id: 'c_mir', name: 'Mirabel', class: 'HUNTER', mainSpec: 'Marksmanship', isMain: false, specs: ['Marksmanship'] }];
  const ST_TEAM = (over) => Object.assign({
    teamId: 't1', teamName: 'Team KJ',
    slots: [{ weekday: 4, startTime: '20:00', zone: 'Hyjal Summit', title: null }, { weekday: 2, startTime: '20:30', zone: null, title: 'Prog' }],
    characters: ST_CHARS, mine: [{ weekday: 4, kind: 'late', characterId: 'c_mir' }],
  }, over || {});
  const STAND = (over) => Object.assign({ personId: 'p_e', teams: [ST_TEAM()] }, over || {});
  const stState = (data, over) => Object.assign({ gid: 'g1', teamId: 't1', status: 'ok', data, draft: G.pages.standing.draftFrom(data.teams[0]), busy: false, error: '', note: '', message: '', forList: null }, over || {});
  const stCard = (state, over) => G.pages.standing.cardHtml(Object.assign({ guildData: gd(MEMBER_CAN), teamId: 't1', canSignUp: true, state }, over || {}));

  await check('standing: times read 12-hour from the schedule\'s own wall clock; a slot is "Every Thursday 8:00 PM - Hyjal Summit" (zone, then title)', () => {
    const T = G.pages.standing.timeLabel;
    assert.deepEqual(['00:15', '09:05', '12:00', '13:30', '20:00', '23:59'].map(T), ['12:15 AM', '9:05 AM', '12:00 PM', '1:30 PM', '8:00 PM', '11:59 PM']);
    const S = G.pages.standing.slotText;
    assert.equal(S({ weekday: 4, startTime: '20:00', zone: 'Hyjal Summit', title: null }), 'Every Thursday 8:00 PM - Hyjal Summit');
    assert.equal(S({ weekday: 2, startTime: '20:30', zone: null, title: 'Prog' }), 'Every Tuesday 8:30 PM - Prog');
    assert.equal(S({ weekday: 0, startTime: '19:00', zone: 'Barrow Deeps', title: 'Clear' }), 'Every Sunday 7:00 PM - Barrow Deeps - Clear');
    assert.equal(S({ weekday: 1, startTime: '18:00', zone: null, title: null }), 'Every Monday 6:00 PM');
  });

  await check('standing card: one row per schedule slot with "I\'m in", a Signed up / Late select and (with several characters) a character select; the one-line explanation; one Save', () => {
    const out = ws(stCard(stState(STAND())));
    assert(out.includes('<h2 class="gs-h2" id="st-h">Standing sign-ups</h2>'));
    assert(out.includes('<p class="gs-fine" id="st-explain">You are signed up automatically for new raids on these days. An Away notice wins. Changing a sign-up yourself keeps it as you set it.</p>'));
    assert(out.includes('>Every Thursday 8:00 PM - Hyjal Summit<') && out.includes('>Every Tuesday 8:30 PM - Prog<'));
    assert(/<input type="checkbox" id="st-in-4" data-change="st-toggle" data-wd="4" data-key="st-in-4" checked><label for="st-in-4">I'm in<\/label>/.test(out));
    assert(/<input type="checkbox" id="st-in-2" data-change="st-toggle" data-wd="2" data-key="st-in-2"><label/.test(out), 'Tuesday is not ticked');
    assert.deepEqual(optionsOf(out, 'st-kind-4'), [{ value: 'signed', selected: false, label: 'Signed up' }, { value: 'late', selected: true, label: 'Late' }]);
    assert.deepEqual(optionsOf(out, 'st-char-4').map(o => [o.value, o.selected]), [['', false], ['c_eli', false], ['c_mir', true]]);
    assert.equal(optionsOf(out, 'st-char-4')[0].label, 'My usual character');
    assert(/id="st-kind-2"[^>]*disabled/.test(out) && /id="st-char-2"[^>]*disabled/.test(out), 'an unticked day has its selects off');
    assert(!/id="st-kind-4"[^>]*disabled/.test(out));
    assert(out.includes('<label class="gs-sr" for="st-kind-4">Status for Every Thursday 8:00 PM - Hyjal Summit</label>'));
    assert(out.includes('role="group" aria-labelledby="st-slot-4"') && out.includes('data-submit="standing-form"') && out.includes('aria-describedby="st-explain"'));
    assert(/data-key="st-save">Save standing sign-ups<\/button>/.test(out) && out.split('type="submit"').length - 1 === 1, 'one Save');
    assert(out.includes('id="st-error" role="alert" hidden'));
    // One character: nothing to choose.
    assert(!stCard(stState(STAND({ teams: [ST_TEAM({ characters: [ST_CHARS[0]] })] }))).includes('st-char-'));
    assertNoRawAttrs(out);
  });

  await check('standing card: nothing for a viewer who cannot sign up, without a person, while loading or when refused; an empty schedule says so; a failed read has Try again; hostile text is escaped', () => {
    assert.equal(stCard(stState(STAND()), { canSignUp: false }), '');
    assert.equal(stCard(stState(STAND({ personId: null }))), '');
    assert.equal(stCard(stState(STAND()), { teamId: 't2' }), '', 'another team on screen');
    assert.equal(stCard(stState(STAND(), { status: 'loading' })), '');
    assert.equal(stCard(stState(STAND(), { status: 'denied' })), '');
    assert.equal(stCard(null), '');
    const none = stCard(stState(STAND({ teams: [] }), { draft: [] }));
    assert(none.includes('This team has no raid schedule yet.') && !none.includes('type="submit"'));
    assert(stCard(stState(STAND({ teams: [ST_TEAM({ slots: [] })] }))).includes('This team has no raid schedule yet.'));
    const err = stCard(stState(STAND(), { status: 'error', message: 'Could not reach Raidsmith.' }));
    assert(err.includes('Could not reach Raidsmith.') && err.includes('data-action="st-retry"'));
    const evil = stCard(stState(STAND({ teams: [ST_TEAM({ slots: [{ weekday: 4, startTime: '20:00', zone: HOSTILE + QUOTES, title: HOSTILE }], characters: [{ id: 'c_x', name: HOSTILE + QUOTES, mainSpec: HOSTILE }, ST_CHARS[0]], mine: [] })] })));
    assertEscaped(evil, 'standing card');
    assertEscaped(stCard(stState(STAND(), { note: HOSTILE, error: HOSTILE + QUOTES })), 'standing note and error');
  });

  await check('standing: the body is only the ticked days - weekday as a number, kind, the character only when one was chosen; nothing ticked is an empty list', () => {
    const H = G.pages.standing;
    const draft = H.draftFrom(ST_TEAM());
    assert.deepEqual(plain(draft), [{ weekday: 4, checked: true, kind: 'late', characterId: 'c_mir' }, { weekday: 2, checked: false, kind: 'signed', characterId: '' }]);
    assert.deepEqual(plain(H.bodyFrom(draft)), { slots: [{ weekday: 4, kind: 'late', characterId: 'c_mir' }] });
    draft[1].checked = true;
    draft[0].characterId = '';
    const body = H.bodyFrom(draft);
    assert.deepEqual(plain(body), { slots: [{ weekday: 4, kind: 'late' }, { weekday: 2, kind: 'signed' }] });
    assert(!('characterId' in body.slots[0]) && typeof body.slots[0].weekday === 'number');
    draft.forEach(r => { r.checked = false; });
    assert.deepEqual(plain(H.bodyFrom(draft)), { slots: [] });
    assert.deepEqual(plain(H.draftFrom(ST_TEAM({ mine: [{ weekday: 2, kind: 'signed', characterId: null }] }))), [{ weekday: 4, checked: false, kind: 'signed', characterId: '' }, { weekday: 2, checked: true, kind: 'signed', characterId: '' }], 'a null character is the usual one');
  });

  await check('standing: the controls change the draft (ticking redraws so the selects switch on); Save sends the ticked days, shows the Worker\'s answer, says so and reads the Raids list again', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const list = S.att.raids = { gid: 'g1', teamId: 't1', data: LIST(), more: false, tab: 'upcoming' };
    const sc = S.att.standing = stState(STAND(), { forList: list });
    G.handlers.change['st-toggle'](el({ 'data-wd': '2' }, { checked: true }));
    G.handlers.change['st-kind'](el({ 'data-wd': '2' }, { value: 'late' }));
    G.handlers.change['st-char'](el({ 'data-wd': '2' }, { value: 'c_eli' }));
    assert.deepEqual(plain(sc.draft[1]), { weekday: 2, checked: true, kind: 'late', characterId: 'c_eli' });
    assert(!/id="st-kind-2"[^>]*disabled/.test(stCard(sc)), 'redrawn: Tuesday is on');
    G.handlers.change['st-toggle'](el({ 'data-wd': '4' }, { checked: false }));
    assert.equal(sc.draft[0].checked, false);
    G.handlers.change['st-toggle'](el({ 'data-wd': '4' }, { checked: true }));
    const saved = ST_TEAM({ mine: [{ weekday: 4, kind: 'late', characterId: 'c_mir' }, { weekday: 2, kind: 'late', characterId: 'c_eli' }] });
    const s = stub((m, url) => Promise.resolve(m === 'put' ? saved : LIST({ upcoming: [UP({ mine: { kind: 'late', source: 'raidsmith', characterName: 'Eliora', standing: true } })] })));
    G.handlers.submit['standing-form']();
    assert.equal(sc.busy, true);
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/teams/t1/standing', { slots: [{ weekday: 4, kind: 'late', characterId: 'c_mir' }, { weekday: 2, kind: 'late', characterId: 'c_eli' }] }], ['get', '/api/guild/g1/raids?team=t1', undefined]]);
    assert.equal(sc.busy, false);
    assert.equal(sc.note, 'Standing sign-ups saved.');
    assert.equal(sc.data.teams.length, 1);
    assert.equal(sc.data.teams[0], saved);
    assert.equal(S.att.raids.data.upcoming[0].mine.standing, true, 'the list was read again');
    assert(stCard(sc).includes('role="status"><span>Standing sign-ups saved.</span>'));
    s.restore();
  }));

  await check('standing: the Worker\'s 400 names the day, 409 team_archived shows its sentence, a lost sign-in is routed; nothing else changes', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const sc = S.att.standing = stState(STAND());
    sc.draft[1].checked = true;
    let s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'Pick Signed up or Late.', field: 'slots', index: 1, slotField: 'kind' })));
    G.handlers.submit['standing-form']();
    await settle();
    assert.equal(sc.error, 'Tuesday: Pick Signed up or Late.');
    assert.equal(sc.busy, false);
    assert(stCard(sc).includes('id="st-error" role="alert">Tuesday: Pick Signed up or Late.</p>'));
    s.restore();
    s = stub(() => Promise.reject(new ApiErr(409, 'team_archived', { message: 'That team is archived.' })));
    G.handlers.submit['standing-form']();
    await settle();
    assert.equal(sc.error, 'That team is archived.');
    s.restore();
    let out = 0;
    const realReq = ctx.Guild.app.requireSignin; ctx.Guild.app.requireSignin = () => { out++; };
    s = stub(() => Promise.reject(new ApiErr(401, 'signed_out', { message: 'Sign in.' })));
    G.handlers.submit['standing-form']();
    await settle();
    assert.equal(out, 1);
    ctx.Guild.app.requireSignin = realReq;
    s.restore();
  }));

  await check('standing: the card loads itself once per list after the Raids page is drawn - for a member who can sign up only; a refused read hides it', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const route = { name: 'section', gid: 'g1', section: 'raids' };
    const list = S.att.raids = { gid: 'g1', teamId: 't1', data: LIST(), more: false, tab: 'upcoming' };
    let s = stub(() => Promise.resolve(STAND()));
    G.pages.standing.afterRender(route);
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/standing']]);
    assert.equal(S.att.standing.status, 'ok');
    assert.deepEqual(plain(S.att.standing.draft.map(r => r.checked)), [true, false]);
    G.pages.standing.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 1, 'drawn again: not read again');
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST(), more: false, tab: 'upcoming' };
    G.pages.standing.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 2, 'a fresh list reads again');
    s.restore();
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ can: { edit: true, signup: false } }), more: false, tab: 'upcoming' };
    s = stub(() => Promise.resolve(STAND()));
    G.pages.standing.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 0, 'no signups.self: never asked');
    s.restore();
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST(), more: false, tab: 'upcoming' };
    s = stub(() => Promise.reject(new ApiErr(403, 'forbidden', { message: 'No.' })));
    G.pages.standing.afterRender(route);
    await settle();
    assert.equal(S.att.standing.status, 'denied');
    assert.equal(stCard(S.att.standing), '');
    s.restore();
    // And the Raids page puts the card on the page, before the officers' away card.
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST(), more: false, tab: 'upcoming' };
    S.att.standing = stState(STAND());
    assert(ws(G.pages.raids.main(route, S.guilds.g1)).includes('Standing sign-ups'));
  }));

  await check('Raids list: a sign-up that comes from a standing sign-up carries a small "standing" tag; the one-click answer keeps it', () => {
    const out = listPage(LIST({ upcoming: [UP({ mine: { kind: 'signed', source: 'raidsmith', characterName: 'Eliora', standing: true } }), UP({ id: 'u2', mine: { kind: 'signed', source: 'raidsmith', characterName: 'Eliora' } })] }));
    assert.equal(out.split('<span class="gs-chip gs-chip-src">standing</span>').length - 1, 1, 'u1 only');
    const row = { id: 'u1', signups: {}, mine: null };
    G.pages.raids.applySignupView({ data: { upcoming: [row] } }, 'u1', view({ me: Object.assign({}, view().me, { signup: entry({ standing: true, isMe: true }) }) }));
    assert.equal(row.mine.standing, true);
    G.pages.raids.applySignupView({ data: { upcoming: [row] } }, 'u1', view());
    assert(!('standing' in row.mine), 'a plain sign-up has no tag');
  });

  await check('panel: a standing sign-up says where it comes from and its button reads "Skip this week"; any other keeps "Remove my sign-up"; the list marks the entry', withState(async (S) => {
    const standingMe = entry({ key: 'p:p_e', personId: 'p_e', name: 'Eliora', classId: 'PRIEST', isMe: true, characterId: 'c_eli', standing: true });
    const v = view({ me: Object.assign({}, view().me, { signup: standingMe }), entries: [standingMe, entry()] });
    const out = panel(v);
    assert(/data-action="su-withdraw" data-key="su-withdraw">Skip this week<\/button>/.test(out) && !out.includes('Remove my sign-up'));
    assert(out.includes('This sign-up comes from your standing sign-up. Skip this week sets you to Can\'t come for this raid only.'));
    assert(out.includes('<span class="gs-chip gs-chip-src">standing</span>'));
    const plainOne = panel(view());
    assert(plainOne.includes('>Remove my sign-up</button>') && !plainOne.includes('Skip this week') && !plainOne.includes('standing'));
    // Pressing it is the same call; the answer (the person's own Absence) is shown as Absent with the usual button.
    const x = openRaid(S, v);
    const absent = view({ me: Object.assign({}, view().me, { signup: entry({ kind: 'absence', isMe: true, key: 'p:p_e', personId: 'p_e', name: 'Eliora', classId: 'PRIEST' }) }) });
    const s = stub(() => Promise.resolve(absent));
    G.handlers.click['su-withdraw'](el({}));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/raids/u1/signup']]);
    assert.equal(x.data, absent);
    const after = panel(absent);
    assert(/data-kind="absence"[^>]*aria-pressed="true"/.test(after) && after.includes('You are down as <strong>can&#39;t come</strong>') && !after.includes('Skip this week'));
    s.restore();
  }));

  // ── the published roster ──
  const RENT = (over) => Object.assign({ name: 'Thoren', personId: 'p_t', class: 'PALADIN', spec: 'Protection', group: 1, status: 'confirmed', respondedAt: 1 }, over || {});
  const ROSTER = (over) => Object.assign({
    published: true, publishedAt: STARTS - 3 * HOUR, publishedBy: 'Alice',
    entries: [RENT(), RENT({ name: 'Eliora', personId: 'p_e', class: 'PRIEST', spec: 'Holy', group: 2, status: 'pending' }), RENT({ name: 'Garrosh', personId: 'p_g', class: 'WARRIOR', spec: 'Arms', group: 2, status: 'declined' }), RENT({ name: 'Dorrin', personId: 'p_d', class: 'PRIEST', spec: null, group: 0, status: 'pending' })],
    counts: { pending: 2, confirmed: 1, declined: 1, total: 4 }, planChanged: false,
  }, over || {});
  const roState = (data, over) => Object.assign({ gid: 'g1', rid: 'u1', status: 'ok', data, busy: false, error: '', message: '', forRaid: null }, over || {});
  const PLANNED = (over, rover) => DETAIL(Object.assign({ sources: { event: null, reports: [], plan: { label: 'Plan', players: 25, unmatched: [] } } }, over || {}), rover);
  const roCard = (data, state, can) => G.pages.raidRoster.cardHtml({ guildData: gd(can || OFFICER_CAN), data, state });

  await check('Roster card (officers): not published with a plan - "Publish line-up" and what it does; without a plan, or for a member, nothing', () => {
    const out = roCard(PLANNED(), roState({ published: false }));
    assert(out.includes('<h2 class="gs-h2" id="ro-h">Line-up</h2>') && /data-action="roster-publish" data-op="publish" data-key="ro-publish">Publish line-up<\/button>/.test(out));
    assert(dec(out).includes('Members will see their group and can confirm or say they can\'t come.'));
    assert.equal(roCard(DETAIL(), roState({ published: false })), '', 'no plan yet');
    assert.equal(roCard(PLANNED({ can: { edit: false } }), roState({ published: false }), MEMBER_CAN), '', 'a member never sees the officers\' card');
    assert.equal(roCard(PLANNED(), null), '');
    assert.equal(roCard(PLANNED(), roState(null, { status: 'loading' })), '');
    assert.equal(roCard(PLANNED(), roState(null, { status: 'denied' })), '');
    const err = roCard(PLANNED(), roState(null, { status: 'error', message: 'Could not reach Raidsmith.' }));
    assert(err.includes('Could not reach Raidsmith.') && err.includes('data-action="ro-retry"'));
    assertNoRawAttrs(out);
  });

  await check('Roster card (officers): published - when and by whom (guild time zone), "1 confirmed, 2 waiting, 1 can\'t come", Group 1, Group 2, Bench with status chips; waiting names highlighted, can\'t-make-it in the warning style', () => {
    const out = ws(roCard(PLANNED(), roState(ROSTER())));
    const text = dec(stripTags(out));
    assert(text.includes('Published Sat Oct 24, 5:00 PM CT by Alice.'), text.slice(0, 300));
    assert(out.includes('<p class="gs-ro-counts" id="ro-counts">1 confirmed, 2 waiting, 1 can&#39;t come</p>'));
    assert(out.indexOf('id="ro-g-1"') < out.indexOf('id="ro-g-2"') && out.indexOf('id="ro-g-2"') < out.indexOf('id="ro-g-0"'), 'Bench last');
    assert(out.includes('<h3 class="gs-su-group-h" id="ro-g-1">Group 1 <span class="gs-su-count">1</span>') && out.includes('<h3 class="gs-su-group-h" id="ro-g-2">Group 2 <span class="gs-su-count">2</span>') && out.includes('id="ro-g-0">Bench <span class="gs-su-count">1</span>'));
    assert(/<li class="gs-su-item gs-ro-item is-confirmed"><span class="gs-su-who"><span class="gs-char-name gs-class-paladin">Thoren<\/span><\/span><span class="gs-su-spec">Protection<\/span><span class="gs-pill gs-pill-ok">Confirmed<\/span>/.test(out));
    assert(/gs-ro-item is-pending"><span class="gs-su-who"><span class="gs-char-name gs-class-priest">Eliora[\s\S]*?gs-pill gs-pill-info">Waiting</.test(out), 'waiting is highlighted');
    assert(/gs-ro-item is-declined">[\s\S]*?Garrosh[\s\S]*?gs-pill gs-pill-warn">Can(&#39;|')t come</.test(out), 'declined is a warning');
    assert(/data-op="republish" data-key="ro-republish">Re-publish line-up</.test(out) && /data-op="unpublish" data-key="ro-unpublish">Unpublish</.test(out));
    assert(!out.includes('The plan changed since you published.'));
    const changed = ws(roCard(PLANNED(), roState(ROSTER({ planChanged: true }))));
    assert(changed.includes('<div class="gs-notice" role="status"><span>The plan changed since you published.</span>') && /data-op="republish" data-key="ro-changed">Re-publish</.test(changed));
    assert(ws(roCard(PLANNED(), roState(ROSTER({ publishedBy: null, publishedAt: null })))).includes('Published.'));
    assert(ws(roCard(PLANNED(), roState(ROSTER({ entries: [], counts: { pending: 0, confirmed: 0, declined: 0, total: 0 } })))).includes('No one is in the line-up.'));
    assertNoRawAttrs(out);
    assertEscaped(roCard(PLANNED(), roState(ROSTER({ entries: [RENT({ name: HOSTILE + QUOTES, spec: HOSTILE, class: 'MAGE' })], publishedBy: HOSTILE + QUOTES }))), 'roster card');
  });

  await check('Roster card: after the start only the list (no Publish, Re-publish or Unpublish), and nothing if it was never published', () => {
    const started = PLANNED(null, { upcoming: false, state: 'reviewed' });
    const out = roCard(started, roState(ROSTER({ planChanged: true })));
    assert(out.includes('id="ro-g-1"') && out.includes('1 confirmed, 2 waiting') && !out.includes('roster-publish') && !out.includes('Re-publish') && !out.includes('The plan changed'));
    assert.equal(roCard(started, roState({ published: false })), '');
    assert.equal(roCard(started, roState(null, { status: 'error', message: 'x' })), '');
  });

  await check('Roster dialogs: Publish says what members will see; Re-publish says what is kept; Unpublish is a danger button; the buttons open them', withState(async (S) => {
    const C = G.pages.raidRoster.confirmDialogHtml;
    const pub = C('publish');
    assert(pub.includes('data-submit="roster-confirm-form" data-op="publish"') && pub.includes('Publish the line-up?') && dec(pub).includes('Members will see their group and can confirm or say they can\'t come.') && pub.includes('gs-btn-molten">Publish line-up<'));
    assert(C('republish').includes('Members keep the answer they gave for a group that did not change.') && C('republish').includes('>Re-publish line-up<'));
    assert(C('unpublish').includes('Unpublish the line-up?') && C('unpublish').includes('gs-btn-danger">Unpublish line-up<'));
    assertNoRawAttrs(pub);
    openRaid(S, view(), OFFICER_CAN, PLANNED());
    S.att.raidRoster = roState(ROSTER());
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html, o) => { opened.push({ html, o }); return null; };
    G.handlers.click['roster-publish'](el({ 'data-op': 'unpublish' }));
    G.handlers.click['roster-publish'](el({ 'data-op': 'republish' }));
    G.handlers.click['roster-publish'](el({ 'data-op': 'publish' }));
    G.handlers.click['roster-publish'](el({ 'data-op': 'bogus' }));
    G.ui.openDialog = realOpen;
    assert.deepEqual(opened.map(o => /data-op="(\w+)"/.exec(o.html)[1]), ['unpublish', 'republish', 'publish', 'publish'], 'an unknown op is a plain publish');
    assert.equal(opened[0].o.describedBy, 'dlg-text');
  }));

  await check('Roster: publish and re-publish POST the roster and show the officer view; Unpublish DELETEs and the card goes back to Publish; the Worker\'s 409 (no plan, raid started) stays in the dialog', withState(async (S) => {
    openRaid(S, view(), OFFICER_CAN, PLANNED());
    const state0 = S.att.raidRoster = roState({ published: false });
    const realRun = G.ui.runDialog; G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    const fm = (op) => ({ getAttribute: k => (k === 'data-op' ? op : null) });
    let s = stub(() => Promise.resolve(ROSTER()));
    G.handlers.submit['roster-confirm-form'](fm('publish'));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/raids/u1/roster', {}]]);
    assert.equal(state0.data.published, true);
    assert.equal(state0.data.counts.confirmed, 1);
    s.calls.length = 0;
    G.handlers.submit['roster-confirm-form'](fm('republish'));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['post', '/api/guild/g1/raids/u1/roster']]);
    s.restore();
    s = stub(() => Promise.resolve({ published: false }));
    G.handlers.submit['roster-confirm-form'](fm('unpublish'));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/raids/u1/roster']]);
    assert.equal(state0.data.published, false);
    assert(roCard(PLANNED(), state0).includes('Publish line-up'));
    s.restore();
    G.ui.runDialog = realRun;
    // A refusal shows in the dialog.
    els = {};
    fakeEl('dlg-error', { hidden: true });
    const realBusy = G.ui.setBusy, realClose = G.ui.closeDialogOf; G.ui.setBusy = () => {}; G.ui.closeDialogOf = () => {};
    s = stub(() => Promise.reject(new ApiErr(409, 'no_plan', { message: 'Link a plan first.' })));
    const form = { getAttribute: k => (k === 'data-op' ? 'publish' : null), querySelector: () => null, querySelectorAll: () => [] };
    G.handlers.submit['roster-confirm-form'](form);
    await settle();
    assert.equal(els['dlg-error'].textContent, 'Link a plan first.');
    s.restore();
    G.ui.setBusy = realBusy; G.ui.closeDialogOf = realClose;
  }));

  await check('Roster: the data loads itself once per raid detail - officers always, members before the start only; a changed raid reads it again; a refused read hides the cards', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const route = { name: 'raid', gid: 'g1', rid: 'u1' };
    const x = S.att.raid = { gid: 'g1', rid: 'u1', data: PLANNED(), filter: null };
    let s = stub(() => Promise.resolve(ROSTER()));
    G.pages.raidRoster.afterRender(route);
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/raids/u1/roster']]);
    assert.equal(S.att.raidRoster.status, 'ok');
    G.pages.raidRoster.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 1);
    G.pages.raidRoster.invalidate();
    G.pages.raidRoster.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 2, 'invalidated (a new plan): read again');
    assert(S.att.raidRoster.data, 'the old copy stays until the new one comes');
    // Past raid: officers still read it (the list), members do not.
    S.att.raid = { gid: 'g1', rid: 'u1', data: PLANNED(null, { upcoming: false }), filter: null };
    G.pages.raidRoster.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 3);
    S.guilds.g1 = gd(MEMBER_CAN);
    S.att.raid = { gid: 'g1', rid: 'u1', data: PLANNED({ can: { edit: false } }, { upcoming: false }), filter: null };
    G.pages.raidRoster.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 3, 'a member after the start: nothing to ask');
    S.att.raid = { gid: 'g1', rid: 'u1', data: PLANNED({ can: { edit: false } }), filter: null };
    G.pages.raidRoster.afterRender(route);
    await settle();
    assert.equal(s.calls.length, 4, 'a member before the start asks');
    s.restore();
    S.att.raid = { gid: 'g1', rid: 'u1', data: PLANNED({ can: { edit: false } }), filter: null };
    s = stub(() => Promise.reject(new ApiErr(403, 'forbidden', { message: 'No.' })));
    G.pages.raidRoster.afterRender(route);
    await settle();
    assert.equal(S.att.raidRoster.status, 'denied');
    assert.equal(G.pages.raidRoster.stateFor('g1', 'other'), null);
    s.restore();
    // The page draws both cards in place.
    S.guilds.g1 = gd(OFFICER_CAN);
    S.att.raid = { gid: 'g1', rid: 'u1', data: PLANNED(), filter: null };
    S.att.raidRoster = roState(ROSTER());
    const page = ws(G.pages.raid.main(route, S.guilds.g1));
    assert(page.includes('id="ro-h">Line-up</h2>'));
  }));

  // ── a member's seat ──
  const SEAT = (over) => ({ published: true, publishedAt: STARTS - 3 * HOUR, mine: Object.assign({ group: 3, name: 'Gorrim', class: 'PALADIN', spec: 'Holy', status: 'pending' }, over || {}) });
  const seatCard = (data, detail, can) => ws(G.pages.raidRoster.seatHtml({ guildData: gd(can || MEMBER_CAN), data: detail || DETAIL({ can: { edit: false } }), state: roState(data) }));

  await check('Your group: "You\'re in Group 3 as Holy Paladin (Gorrim)" with the status and Confirm / Can\'t come; the bench reads "You\'re on the bench"; confirmed and declined change the buttons and the sentence', () => {
    const out = seatCard(SEAT());
    assert(out.includes('<h2 class="gs-h2" id="seat-h">Your group</h2>') && out.includes('<span class="gs-pill gs-pill-info">Waiting</span>'));
    assert.equal(dec(stripTags(out)).includes('You\'re in Group 3 as Holy Paladin (Gorrim)'), true, stripTags(out));
    assert(/data-action="seat-confirm" data-key="seat-confirm">Confirm<\/button>/.test(out) && /data-action="seat-decline" data-key="seat-decline">Can't come<\/button>/.test(out));
    assert(out.includes('id="seat-error" role="alert" hidden'));
    const bench = seatCard(SEAT({ group: 0 }));
    assert(dec(stripTags(bench)).includes('You\'re on the bench') && dec(stripTags(bench)).includes('As Holy Paladin (Gorrim)') && !bench.includes('Group 0'));
    const ok = seatCard(SEAT({ status: 'confirmed' }));
    assert(ok.includes('gs-pill-ok">Confirmed') && !ok.includes('data-action="seat-confirm"') && ok.includes('data-action="seat-decline"'));
    const no = seatCard(SEAT({ status: 'declined' }));
    assert(dec(stripTags(no)).includes('You told the officers you can\'t come.') && no.includes('gs-pill-warn') && /data-action="seat-confirm"[^>]*>Confirm after all</.test(no) && !no.includes('data-action="seat-decline"'));
    assert(dec(stripTags(seatCard(SEAT({ spec: null })))).includes('You\'re in Group 3 as Paladin (Gorrim)'));
    assert(dec(stripTags(seatCard(SEAT({ spec: null, class: null, name: null })))).includes('You\'re in Group 3') && !seatCard(SEAT({ spec: null, class: null, name: null })).includes(' as '));
    assert(seatCard(SEAT(), null).includes('Your group'));
    const busy = G.pages.raidRoster.seatHtml({ guildData: gd(MEMBER_CAN), data: DETAIL({ can: { edit: false } }), state: roState(SEAT(), { busy: true }) });
    assert(/data-action="seat-confirm"[^>]*disabled/.test(busy) && /data-action="seat-decline"[^>]*disabled/.test(busy));
    assert(G.pages.raidRoster.seatHtml({ guildData: gd(MEMBER_CAN), data: DETAIL({ can: { edit: false } }), state: roState(SEAT(), { error: HOSTILE + QUOTES }) }).includes('role="alert">&lt;img'));
    assertEscaped(seatCard(SEAT({ name: HOSTILE + QUOTES, spec: HOSTILE })), 'seat card');
    assertNoRawAttrs(out);
  });

  await check('Your group: nothing when the roster is not published, the viewer has no seat (an officer\'s reply), the raid has started or the data is not there', () => {
    assert.equal(seatCard({ published: false, mine: null }), '');
    assert.equal(seatCard({ published: true, publishedAt: 1, mine: null }), '');
    assert.equal(seatCard(Object.assign(SEAT(), { published: false })), '');
    assert.equal(seatCard(SEAT(), DETAIL({ can: { edit: false } }, { upcoming: false })), '');
    assert.equal(G.pages.raidRoster.seatHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: null }), '');
    assert.equal(G.pages.raidRoster.seatHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: roState(null, { status: 'error' }) }), '');
    const officer = ws(G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN), data: PLANNED(), signups: null, roster: roState(ROSTER()) }));
    assert(!officer.includes('Your group') && officer.includes('id="ro-h"'), 'an officer sees the Roster card, not a seat');
    const member = ws(G.pages.raid.raidHtml({ guildData: gd(MEMBER_CAN), data: DETAIL({ can: { edit: false } }), signups: null, roster: roState(SEAT()) }));
    assert(member.includes('Your group') && !member.includes('id="ro-h"') && member.indexOf('Your group') < member.indexOf('Opens when the raid starts'), 'the seat is on top, the officers\' card is not there');
  });

  await check('Your group: Confirm POSTs and shows the answer, then reads the Sign-ups panel again; a failure is shown in the card; Can\'t come asks first, then POSTs decline and the card says so', withState(async (S) => {
    openRaid(S, view(), MEMBER_CAN, DETAIL({ can: { edit: false } }));
    const sc = S.att.raidRoster = roState(SEAT());
    let s = stub((m, url) => Promise.resolve(m === 'post' ? SEAT({ status: 'confirmed' }) : view()));
    G.handlers.click['seat-confirm'](el({}));
    assert.equal(sc.busy, true);
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/raids/u1/roster/confirm', {}], ['get', '/api/guild/g1/raids/u1/signups', undefined]]);
    assert.equal(sc.busy, false);
    assert.equal(sc.data.mine.status, 'confirmed');
    s.restore();
    // A failure.
    s = stub(() => Promise.reject(new ApiErr(409, 'raid_started', { message: 'The raid has started.' })));
    G.handlers.click['seat-confirm'](el({}));
    await settle();
    assert.equal(sc.error, 'The raid has started.');
    assert.equal(sc.busy, false);
    assert(G.pages.raidRoster.seatHtml({ guildData: gd(MEMBER_CAN), data: DETAIL({ can: { edit: false } }), state: sc }).includes('id="seat-error" role="alert">The raid has started.</p>'));
    s.restore();
    // Can't come asks first.
    sc.error = '';
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html, o) => { opened.push({ html, o }); return null; };
    s = stub(() => Promise.resolve({}));
    G.handlers.click['seat-decline'](el({}));
    G.ui.openDialog = realOpen;
    assert.equal(s.calls.length, 0, 'nothing sent yet');
    assert(opened[0].html.includes("Tell the officers you can't come?") && opened[0].html.includes('Your sign-up for this raid becomes Can&#39;t come.') && opened[0].html.includes('data-submit="roster-decline-form" data-from="page" data-rid="u1"') && opened[0].html.includes('gs-btn-danger'));
    s.restore();
    const realRun = G.ui.runDialog; G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    s = stub((m) => Promise.resolve(m === 'post' ? SEAT({ status: 'declined' }) : view()));
    G.handlers.submit['roster-decline-form'](el({ 'data-from': 'page', 'data-rid': 'u1' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['post', '/api/guild/g1/raids/u1/roster/decline'], ['get', '/api/guild/g1/raids/u1/signups']]);
    assert.equal(sc.data.mine.status, 'declined');
    const card = ws(G.pages.raidRoster.seatHtml({ guildData: gd(MEMBER_CAN), data: DETAIL({ can: { edit: false } }), state: sc }));
    assert(dec(stripTags(card)).includes('You told the officers you can\'t come.') && card.includes('Confirm after all'));
    // Confirm after all: the same call as Confirm.
    s.calls.length = 0;
    G.handlers.click['seat-confirm'](el({}));
    await settle();
    assert.equal(s.calls[0].url, '/api/guild/g1/raids/u1/roster/confirm');
    s.restore(); G.ui.runDialog = realRun;
  }));

  // ── the Raids list ──
  const mineRoster = (roster, over) => Object.assign({ kind: 'signed', source: 'raidsmith', characterName: 'Eliora', roster }, over || {});

  await check('Raids list: a seat shows as "Group 3 - confirm?" / "Group 3 - confirmed" / "Bench - confirm?" with Confirm and Can\'t come right there; a seat with no sign-up still shows and can sign up', () => {
    const out = listPage(LIST({ upcoming: [UP({ mine: mineRoster({ group: 3, status: 'pending' }) })] }));
    assert(out.includes('<span class="gs-chip gs-chip-signup">Group 3 - confirm?</span>'));
    assert(/data-action="raids-roster" data-do="confirm" data-rid="u1" data-key="rc-u1">Confirm<\/button>/.test(out) && /data-action="raids-roster" data-do="decline" data-rid="u1" data-key="rd-u1">Can't come<\/button>/.test(out));
    assert.equal(out.split('data-do="confirm"').length - 1, 1, 'one row, which is the phone card too');
    const ok = listPage(LIST({ upcoming: [UP({ mine: mineRoster({ group: 3, status: 'confirmed' }) })] }));
    assert(ok.includes('Group 3 - confirmed') && !ok.includes('data-do="confirm"') && ok.includes('data-do="decline"'));
    const bench = listPage(LIST({ upcoming: [UP({ mine: mineRoster({ group: 0, status: 'pending' }) })] }));
    assert(bench.includes('Bench - confirm?') && !bench.includes('Group 0'));
    const no = listPage(LIST({ upcoming: [UP({ mine: mineRoster({ group: 3, status: 'declined' }) })] }));
    assert(dec(no).includes('Group 3 - can\'t come') && no.includes('gs-chip-flag') && />Confirm after all</.test(no) && !no.includes('data-do="decline"'));
    const bare = listPage(LIST({ upcoming: [UP({ mine: { kind: null, source: null, characterName: null, roster: { group: 2, status: 'pending' } } })] }));
    assert(bare.includes('Group 2 - confirm?') && !bare.includes('null') && /data-action="raids-signup"/.test(bare), 'no sign-up chip, Sign up stays');
    const closed = listPage(LIST({ upcoming: [UP({ signupsOpen: false, mine: { kind: null, source: null, characterName: null, roster: { group: 2, status: 'pending' } } })] }));
    assert(closed.includes('Group 2 - confirm?') && !closed.includes('Sign-ups closed'), 'a seat is not "closed"');
    assert(!listPage(LIST()).includes('raids-roster'));
    assertNoRawAttrs(out);
  });

  await check('Raids list: Confirm POSTs and reads the list again; Can\'t come asks first (then POSTs decline and reads the list); a started raid or a taken-down roster re-reads the list and says why', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const x = S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ upcoming: [UP({ mine: mineRoster({ group: 3, status: 'pending' }) })] }), more: false, tab: 'upcoming' };
    const confirmed = LIST({ upcoming: [UP({ mine: mineRoster({ group: 3, status: 'confirmed' }) })] });
    let s = stub((m) => Promise.resolve(m === 'post' ? SEAT({ status: 'confirmed' }) : confirmed));
    const b = el({ 'data-rid': 'u1', 'data-do': 'confirm' });
    G.handlers.click['raids-roster'](b);
    assert.equal(b.disabled, true);
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/raids/u1/roster/confirm', {}], ['get', '/api/guild/g1/raids?team=t1', undefined]]);
    assert.equal(x.data.upcoming[0].mine.roster.status, 'confirmed');
    s.restore();
    // Decline: the question, then the call.
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html) => { opened.push(html); return null; };
    s = stub(() => Promise.resolve({}));
    G.handlers.click['raids-roster'](el({ 'data-rid': 'u1', 'data-do': 'decline' }));
    G.ui.openDialog = realOpen;
    assert.equal(s.calls.length, 0);
    assert(opened[0].includes('data-from="list" data-rid="u1"'));
    s.restore();
    const realRun = G.ui.runDialog; G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    const declined = LIST({ upcoming: [UP({ mine: mineRoster({ group: 3, status: 'declined' }) })] });
    s = stub((m) => Promise.resolve(m === 'post' ? SEAT({ status: 'declined' }) : declined));
    G.handlers.submit['roster-decline-form'](el({ 'data-from': 'list', 'data-rid': 'u1' }));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['post', '/api/guild/g1/raids/u1/roster/decline'], ['get', '/api/guild/g1/raids?team=t1']]);
    assert.equal(x.data.upcoming[0].mine.roster.status, 'declined');
    s.restore(); G.ui.runDialog = realRun;
    // The raid started meanwhile.
    const started = LIST({ upcoming: [] });
    s = stub((m) => (m === 'post' ? Promise.reject(new ApiErr(409, 'raid_started', { message: 'The raid has started.' })) : Promise.resolve(started)));
    const b2 = el({ 'data-rid': 'u1', 'data-do': 'confirm' });
    G.handlers.click['raids-roster'](b2);
    await settle();
    assert.equal(b2.disabled, false);
    assert.equal(S.pageAlert, 'The raid has started.');
    assert.equal(S.att.raids.data.upcoming.length, 0, 'the list as it is now');
    s.restore();
  }));

  // ── Needs attention ──
  await check('Needs attention: "Sat Oct 24: 2 line-up players can\'t come" links the raid; one person reads "1 line-up player"; an unknown future kind is skipped without breaking the list', () => {
    const A = G.pages.attention;
    const item = (over) => Object.assign({ id: 'rd:u1', kind: 'roster_declined', severity: 'action', teamId: 't1', teamName: 'Team KJ', raidId: 'u1', date: '2026-10-24', zone: 'Hyjal Summit', title: null, startsAt: STARTS, count: 2, link: { name: 'raid', rid: 'u1' } }, over || {});
    assert.equal(A.itemText(item()), 'Sat Oct 24: 2 line-up players can\'t come');
    assert.equal(A.itemText(item({ count: 1 })), 'Sat Oct 24: 1 line-up player can\'t come');
    assert.equal(A.itemHref('g1', item()), '#/g/g1/raids/r/u1');
    assert(A.KINDS.some(k => k.id === 'roster_declined' && k.severity === 'action' && k.action === 'Open raid'));
    const data = { today: '2026-10-18', total: 3, items: [item(), { id: 'x:1', kind: 'from_the_future', severity: 'action', teamId: 't1', teamName: 'Team KJ', date: '2026-10-24', link: { name: 'raid', rid: 'u1' } }, item({ id: 'rd:u2', raidId: 'u2', count: 1, date: '2026-10-31', link: { name: 'raid', rid: 'u2' } })], more: { roster_declined: 2 } };
    const out = ws(A.attentionHtml({ guildData: gd(OFFICER_CAN), data }));
    assert(dec(out).includes('Sat Oct 24: 2 line-up players can\'t come') && dec(out).includes('Sat Oct 31: 1 line-up player can\'t come'));
    assert(out.includes('href="#/g/g1/raids/r/u1"') && out.includes('<span>Open raid</span>'));
    assert(!out.includes('from_the_future') && !out.includes('from the future'), 'the unknown kind is skipped');
    assert(out.includes('and 2 more'), 'the hidden ones link on');
    assertNoRawAttrs(out);
    assertEscaped(A.attentionHtml({ guildData: gd(OFFICER_CAN), data: { items: [item({ date: HOSTILE, teamName: HOSTILE + QUOTES, zone: HOSTILE })], more: {}, total: 1 } }), 'attention item');
  });

  await check('scripts: the standing and roster pieces are in the guild script list and the three pages, after the raid page they sit on', () => {
    for (const name of ['pages-standing', 'pages-raid-roster']) {
      const src = '/js/guild/' + name + '.js';
      assert(GUILD_SCRIPTS.includes(src), name);
      for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert(guildScriptsOf(read(page)).includes(src), name + ' in ' + page);
      assert(GUILD_SCRIPTS.indexOf(src) < GUILD_SCRIPTS.indexOf('/js/guild/app.js'));
    }
    assert(GUILD_SCRIPTS.indexOf('/js/guild/pages-raid-roster.js') > GUILD_SCRIPTS.indexOf('/js/guild/pages-raid.js'));
  });

  // ═══ 6. The code itself ══════════════════════════════════════════
  await check('safety: ASCII in code and copy, no inline styles or handlers, no browser-zone date formatting in the changed pages (ui.js keeps its own older helpers), the sign-ups panel and schedule go through G.api.signups', () => {
    const files = ['pages-settings-teams.js', 'pages-settings-schedule.js', 'pages-raids.js', 'pages-raid.js', 'pages-raid-signups.js', 'pages-away.js', 'pages-standing.js', 'pages-raid-roster.js', 'ui.js'];
    for (const f of files) {
      const src = read('js/guild/' + f);
      assert(!/[^\x00-\x7f]/.test(src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')), f + ' is ASCII outside the comment lines');
      assert(!/\sstyle=|\son(click|change|input|submit)=/i.test(src), f + ' has inline style or handlers');
      if (f !== 'ui.js') assert(!/\.toLocale(Date|Time)?String\(/.test(src.replace(/\.toLocale(Date|Time)String\([^)]*timeZone[^)]*\)/g, '').replace(/\.toLocaleString\([^)]*timeZone[^)]*\)/g, '')), f + ': a date is written without the guild\'s time zone');
    }
    for (const f of ['pages-raid-signups.js', 'pages-settings-schedule.js']) assert(!/G\.api\.(get|post|put|patch|del)\(/.test(read('js/guild/' + f)), f);
    const raids = read('js/guild/pages-raids.js');
    assert(/timeText\(ms, timeZone\)/.test(raids) && /timeZone: timeZone \|\| undefined/.test(raids));
    // No new page script: the lists in the pages and the test harness are unchanged by this lane.
    for (const f of GUILD_SCRIPTS) assert(fs.existsSync(path.join(ROOT, f.replace(/^\//, ''))), f);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
