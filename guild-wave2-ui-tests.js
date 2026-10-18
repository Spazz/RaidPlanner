/**
 * Raidsmith guild UI, PM wave 2 (raid sizes, the sign-up deadline, date-only raids) - tests for Team settings (the team's raid size and the
 * Add team select), Settings > Raid schedule (the "Close sign-ups ... hours before the start" field), the Raids list (zone and size, "18 / 20 signed
 * up", "time not set", the deadline beside Sign up, the Raid size select of New raid), the raid page (the title, "Time not set", the officers'
 * Raid settings card) and the Sign-ups panel ("Expected", the Open until / Closed pill, the deadline sentence and the 409 it answers with).
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
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

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
    assert.equal(S.att.settingsSchedule.note, 'Schedule saved.');
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
    assert(out.includes('<td>Hyjal Summit - 20</td>'), 'the table cell');
    assert(out.includes('<td>20-player</td>'), 'no zone');
    assert(out.includes('<td><span class="gs-ev-title">Prog night</span> &middot; Onyxia&#39;s Lair - 40</td>') || out.includes('<td><span class="gs-ev-title">Prog night</span> &middot; Onyxia\'s Lair - 40</td>'), 'a title first');
    assert(out.includes('<td>Hyjal Summit</td>'), 'no size: as before');
    assert(out.includes('<div class="gs-card-line">Hyjal Summit - 20</div>'), 'the phone card');
    assert.equal(G.pages.raids.zoneSizeText('Hyjal Summit', 20), 'Hyjal Summit - 20');
    assert.equal(G.pages.raids.zoneSizeText(null, 10), '10-player');
    assert.equal(G.pages.raids.zoneSizeText('', undefined), '');
    assertNoRawAttrs(out);
    assertEscaped(listPage(LIST({ upcoming: [UP({ zone: HOSTILE + QUOTES, title: HOSTILE + QUOTES })] })), 'event cell');
  });

  await check('Raids list: a date-only raid says "time not set" (muted) and never a made-up 12:00; a timed raid keeps its time', () => {
    const dateOnly = listPage(LIST({ upcoming: [UP({ timeKnown: false, startsAt: NOON_UTC })] }));
    assert(/<a href="#\/g\/g1\/raids\/r\/u1">Sat Oct 24<\/a> <span class="gs-muted gs-time-unset">time not set<\/span>/.test(dateOnly), 'the table cell');
    assert(/<a class="gs-raid-link" href="#\/g\/g1\/raids\/r\/u1">Sat Oct 24<\/a> <span class="gs-muted gs-time-unset">time not set<\/span>/.test(dateOnly), 'the phone card');
    assert(!/12:00|7:00 AM|\bAM\b|\bPM\b/.test(stripTags(dateOnly)), 'no time at all: ' + stripTags(dateOnly));
    const timed = listPage(LIST());
    assert(timed.includes('>Sat Oct 24, 8:00 PM</a>') && !timed.includes('time not set'));
    const unknown = listPage(LIST({ upcoming: [UP({ timeKnown: undefined })] }));
    assert(unknown.includes('Sat Oct 24, 8:00 PM') && !unknown.includes('time not set'), 'an older reply is read as timed');
    const W = G.pages.raids.whenText;
    assert.equal(ws(W({ raidOn: '2026-10-24', startsAt: STARTS, timeKnown: true }, gd(MEMBER_CAN))), 'Sat Oct 24, 8:00 PM');
    assert.equal(W({ raidOn: '2026-10-24', startsAt: NOON_UTC, timeKnown: false }, gd(MEMBER_CAN)), 'Sat Oct 24');
    assert.equal(G.pages.raids.timeNotSetHtml({ timeKnown: true }), '');
  });

  await check('Raids list: the count is "expected / size signed up" with the old breakdown after it; late counts as signed up; no size keeps the old words', () => {
    const T = G.pages.raids.signupsText;
    assert.equal(T({ signed: 17, late: 1, bench: 2, tentative: 1, absence: 1 }, 20), '18 / 20 signed up, 2 bench, 1 tentative, 1 absent');
    assert.equal(T({ signed: 3, late: 0, bench: 0, tentative: 0, absence: 0 }, 10), '3 / 10 signed up');
    assert.equal(T({ signed: 0, late: 0, bench: 0, tentative: 2, absence: 0 }, 25), '0 / 25 signed up, 2 tentative');
    assert.equal(T({ signed: 0, late: 0, bench: 0, tentative: 0, absence: 0 }, 20), 'No sign-ups yet');
    assert.equal(T({ signed: 21, late: 2, bench: 2, tentative: 0, absence: 1 }), '23 signed, 2 bench, 1 absent', 'no size: as before');
    assert.equal(T(null, 20), '-');
    assert.equal(T({ signed: 4, late: 1, bench: 0, tentative: 0, absence: 0, expected: 7 }, 20), '7 / 20 signed up', 'a Worker that sends expected is believed');
    const out = listPage(LIST());
    assert(out.includes('<td>18 / 20 signed up, 2 bench, 1 tentative, 1 absent</td>') && out.includes('<span class="gs-fine">18 / 20 signed up, 2 bench, 1 tentative, 1 absent</span>'));
    assert(!listPage(LIST({ can: { edit: false, signup: false }, upcoming: [UP({ signups: null })] })).includes('signed up'), 'a viewer who may not see counts gets none');
  });

  await check('Raids list: the deadline beside Sign up - "Sign-ups close Fri 8:00 PM" in the guild\'s time zone while open and a deadline is set; "Sign-ups closed" and no button when closed', () => {
    const open = listPage(LIST({ upcoming: [UP({ closeHours: 24, closesAt: STARTS - 24 * HOUR })] }));
    assert(open.includes('<span class="gs-fine">Sign-ups close Fri 8:00 PM</span>'), open.slice(open.indexOf('Your sign-up')));
    assert.equal(open.split('Sign-ups close Fri 8:00 PM').length - 1, 2, 'table row and card');
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
    assert(out.includes('<td>Barrow Deeps - 10</td>') && out.includes('<td>25-player</td>') && out.includes('<td>Barrow Deeps</td>'));
    assert(out.includes('Barrow Deeps - 10 &middot; 2 kills, 1 wipe') && out.includes('25-player &middot; '), 'the cards');
    assert(out.includes('<span class="gs-muted">-</span>') === false, 'every row has a zone or a size here');
    assert(listPage(LIST({ upcoming: [], raids: [PAST({ zone: null, size: undefined })] }), MEMBER_CAN, { tab: 'past' }).includes('<td><span class="gs-muted">-</span></td>'));
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
    assert(/<h1 class="gs-h1" tabindex="-1">Sat Oct 24 - Hyjal Summit - 20<\/h1>/.test(timed));
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
    assert(team.includes('>Team default (24 hours)<') && team.includes('until 24 hours before the start (Fri Oct 23, 8:00 PM)'), 'the team\'s deadline, written in Chicago time');
    assert(team.includes('(Fri Oct 23, 8:00 PM), the team'));
    const one = raidPage(DETAIL(null, { closeHours: 1, closesAt: STARTS - HOUR }));
    assert(one.includes('>Team default (1 hour)<') && one.includes('until 1 hour before the start'));
    const own = raidPage(DETAIL(null, { closeHours: 6, closeHoursOverride: 6, closesAt: STARTS - 6 * HOUR }));
    assert.deepEqual(optionsOf(own, 'rs-hours-mode').filter(o => o.selected).map(o => o.value), ['custom']);
    assert(/id="rs-hours-field">/.test(own) && /id="rs-hours"[^>]*value="6"/.test(own), 'the box shows with the raid\'s own hours');
    assert(own.includes('until 6 hours before the start (Sat Oct 24, 2:00 PM), set for this raid.'));
    assert(own.includes('>Set for this raid<'));
    // An own value of 0 is still an override.
    const zero = raidPage(DETAIL(null, { closeHours: 0, closeHoursOverride: 0 }));
    assert(/id="rs-hours"[^>]*value="0"/.test(zero) && zero.includes('until the raid starts, set for this raid.'));
    // The same moment in another zone.
    const nz = ws(G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN, null, 'Pacific/Auckland'), data: DETAIL(null, { closeHours: 24, closesAt: STARTS - 24 * HOUR }), signups: null }));
    assert(nz.includes('(Sat Oct 24, 2:00 PM)'));
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
    assert(/Expected 18 \/ 20 Signed 17 Late 1 Tentative 1 Bench 1 Absent 1/.test(text), text.slice(0, 400));
    assert(out.includes('<dt>Expected</dt><dd>18 / 20</dd>'));
    const noSize = stripTags(panel(view(null, { size: undefined })));
    assert(!noSize.includes('Expected') && /Signed 17 Late 1/.test(noSize));
    assert(stripTags(panel(view({ counts: Object.assign({}, COUNTS, { expected: 0, signed: 0, late: 0 }) }))).includes('Expected 0 / 20'));
    assert(stripTags(panel(view(null, { size: 10 }))).includes('Expected 18 / 10'), 'over the size reads as it is');
    assert(!panel(view({ can: { edit: false, self: false, seeList: false, seeNicknames: false }, me: null, counts: null, entries: null })).includes('Expected'), 'a viewer without the list has no counts');
  });

  await check('panel: the status pill - "Open until <deadline> (sign-ups close N hours before the start)" when a deadline is set; the old "Open until <start>" when not', () => {
    const none = ws(panel(view()));
    assert(none.includes('gs-pill gs-pill-ok gs-su-status">Open until Sat Oct 24, 8:00 PM</span>') && !none.includes('sign-ups close'));
    const d24 = ws(panel(view(null, { closeHours: 24, closesAt: STARTS - 24 * HOUR })));
    assert(d24.includes('>Open until Fri Oct 23, 8:00 PM (sign-ups close 24 hours before the start)</span>'), d24.slice(d24.indexOf('gs-pill')));
    assert(ws(panel(view(null, { closeHours: 1, closesAt: STARTS - HOUR }))).includes('(sign-ups close 1 hour before the start)'));
    // The guild's zone, not the browser's.
    const nz = ws(G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN, null, 'Pacific/Auckland'), data: DETAIL(), state: state(view(null, { closeHours: 24, closesAt: STARTS - 24 * HOUR })) }));
    assert(nz.includes('Open until Sat Oct 24, 2:00 PM (sign-ups close 24 hours before the start)'));
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
    assert(out.includes('gs-pill gs-pill-warn gs-su-status">Closed Fri Oct 23, 8:00 PM</span>'), out.slice(out.indexOf('gs-pill')));
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

  // ═══ 6. The code itself ══════════════════════════════════════════
  await check('safety: ASCII in code and copy, no inline styles or handlers, no browser-zone date formatting in the changed pages (ui.js keeps its own older helpers), the sign-ups panel and schedule go through G.api.signups', () => {
    const files = ['pages-settings-teams.js', 'pages-settings-schedule.js', 'pages-raids.js', 'pages-raid.js', 'pages-raid-signups.js', 'ui.js'];
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
    assert(read('.gitignore').includes('!guild-wave2-ui-tests.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
