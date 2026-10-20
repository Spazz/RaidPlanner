/**
 * Raidsmith guild UI, Phase 6 (native sign-ups + raid schedule) - tests for the Sign-ups panel of a raid, the Raids list's sign-up
 * chip, one-click Sign up and Create upcoming raids (with the automatic fill), Settings > Raid schedule, the router and the shell.
 * Run: node guild-signups-ui-tests.js
 *
 * Same approach as guild-loot-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render functions return HTML
 * strings and the handlers run against a stubbed G.api. The mock data follows "API (as built)" in tasks/guild-phase6-signups-spec.md;
 * guild-signups-contract-tests.js runs the same pages against the real Worker.
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
ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tick = () => new Promise(r => setTimeout(r, 5));

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
const OFFICER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'roster.edit': 'guild', 'signups.self': ['t1'] };
const LEAD_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': ['t1'], 'attendance.view': ['t1'], 'signups.self': [] };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'signups.self': ['t1'] };
function gd(can, over) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [T1, T2].map(t => ({ id: t.id, name: t.name, size: 25, archived: false, players: 3, leads: [] })),
    me: { roles: [], can },
    attendanceFlags: {},
  }, over || {});
}

const STARTS = Date.UTC(2026, 9, 25, 1, 0); // Sat Oct 24 2026, 20:00 in Chicago
const DETAIL = (over) => Object.assign({
  raid: { id: 'u1', team: { id: 't1', name: 'Team KJ' }, teamId: 't1', raidOn: '2026-10-24', startsAt: STARTS, upcoming: true, title: 'Prog night', zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 },
  can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
  sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [],
}, over || {});

const CHAR_PRIEST = { id: 'c_eli', name: 'Eliora', class: 'PRIEST', mainSpec: 'Holy', offSpec: 'Discipline', isMain: true, teamId: 't1', specs: ['Holy', 'Discipline', 'Shadow'] };
const CHAR_HUNTER = { id: 'c_mir', name: 'Mirabel', class: 'HUNTER', mainSpec: 'Marksmanship', offSpec: null, isMain: false, teamId: 't1', specs: ['Marksmanship', 'Beast Mastery', 'Survival'] };
function entry(over) {
  return Object.assign({
    key: 'p:p_x', personId: 'p_x', source: 'raidsmith', kind: 'signed', name: 'Thoren', classId: 'PALADIN', className: 'Paladin', spec: 'Protection', role: 'tank',
    characterId: 'c_th', note: null, updatedAt: 1, matched: true, isMe: false, nickname: null,
  }, over || {});
}
const ENTRIES = [
  entry({ key: 'p:p_t', personId: 'p_t', name: 'Thoren' }),
  entry({ key: 'p:p_e', personId: 'p_e', name: 'Eliora', classId: 'PRIEST', className: 'Priest', spec: 'Holy', role: 'healer', characterId: 'c_eli', isMe: true }),
  entry({ key: 'p:p_k', personId: 'p_k', name: 'Kaelith', classId: 'ROGUE', className: 'Rogue', spec: 'Combat', role: 'melee', kind: 'late', note: 'Back by 8:15' }),
  entry({ key: 'p:p_m', personId: 'p_m', name: 'Mirabel', classId: 'HUNTER', className: 'Hunter', spec: 'Beast Mastery', role: 'ranged', source: 'raid_helper', characterId: null }),
  entry({ key: 'p:p_v', personId: 'p_v', name: 'Veyla', classId: 'MAGE', className: 'Mage', spec: null, role: 'ranged', kind: 'tentative' }),
  entry({ key: 'p:p_b', personId: 'p_b', name: 'Dorrin', classId: 'PRIEST', className: 'Priest', spec: null, role: null, kind: 'bench' }),
  entry({ key: 'p:p_a', personId: 'p_a', name: 'Garrosh', classId: 'WARRIOR', className: 'Warrior', spec: 'Arms', role: 'melee', kind: 'absence' }),
  entry({ key: 'x:raid_helper:9', personId: null, source: 'raid_helper', kind: 'signed', name: null, classId: 'ROGUE', className: 'Rogue', spec: 'Subtlety', role: 'melee', characterId: null, matched: false }),
];
const COUNTS = { signed: 4, late: 1, tentative: 1, bench: 1, absence: 1, expected: 5, byRole: { tank: 1, healer: 1, melee: 2, ranged: 1, none: 0 }, byClass: { PALADIN: 1, PRIEST: 1, ROGUE: 2, HUNTER: 1 } };
function view(over) {
  return Object.assign({
    raid: { id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: true, locked: false, closed: null },
    can: { edit: false, self: true, seeList: true, seeNicknames: false },
    me: { personId: 'p_e', signup: ENTRIES[1], characters: [CHAR_PRIEST, CHAR_HUNTER], defaultCharacterId: 'c_eli', canChange: true, closed: null },
    counts: COUNTS,
    entries: ENTRIES,
    roster: null,
  }, over || {});
}
const OFFICER_VIEW = (over) => view(Object.assign({
  can: { edit: true, self: false, seeList: true, seeNicknames: true }, me: null,
  roster: [
    { personId: 'p_t', name: 'Thoren', status: 'raider', characters: [{ id: 'c_th', name: 'Thoren', class: 'PALADIN', mainSpec: 'Protection', offSpec: 'Holy', isMain: true, teamId: 't1', specs: ['Protection', 'Holy', 'Retribution'] }, { id: 'c_th2', name: 'Thorenmage', class: 'MAGE', mainSpec: 'Fire', offSpec: null, isMain: false, teamId: 't2', specs: ['Fire', 'Arcane', 'Frost'] }] },
    { personId: 'p_n', name: 'Nodisc', status: 'raider', characters: [{ id: 'c_nd', name: 'Nodisc', class: 'ROGUE', mainSpec: 'Combat', offSpec: null, isMain: true, teamId: 't1', specs: ['Combat', 'Assassination', 'Subtlety'] }] },
  ],
}, over || {}));
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
    const savedTeamFor = ctx.Guild.app.teamFor;
    try { await fn(S); } finally { Object.assign(S, saved); ctx.Guild.app.teamFor = savedTeamFor; }
  };
}
// The open raid page: the attendance state bag holds the detail and the panel's state.
function openRaid(S, v, canVariant) {
  S.guilds.g1 = gd(canVariant || MEMBER_CAN); S.currentGid = 'g1';
  S.att.raid = { gid: 'g1', rid: 'u1', data: DETAIL(), filter: null };
  S.att.raidSignups = state(v);
  return S.att.raidSignups;
}
class ApiErr extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.body = extra || {}; Object.assign(this, extra || {}); }
}

(async () => {
  // ── router and shell ─────────────────────────────────────────────
  await check('router: Settings > Raid schedule parses and formats back; bad input is notfound', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/g/g1/settings/schedule'), { name: 'settings', gid: 'g1', tab: 'schedule' });
    assert.deepEqual(p(G.router.format({ name: 'settings', gid: 'g1', tab: 'schedule' })), { name: 'settings', gid: 'g1', tab: 'schedule' });
    assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab: 'schedule' }), '#/g/g1/settings/schedule');
    for (const bad of ['#/g/g1/settings/schedules', '#/g/g1/settings/schedule/x', '#/g/g1/schedule', '#/g/g1/settings/Schedule']) assert.equal(p(bad).name, 'notfound', bad);
    assert(G.router.TABS.includes('schedule'));
  });

  await check('shell: the Raid schedule tab is for raids.edit (guild or a team), after Teams; the Guild settings nav item does not change', () => {
    const tabs = can => plain(G.shell.settingsTabs(can).map(t => t.tab));
    assert.deepEqual(tabs({ 'raids.edit': 'guild' }), ['schedule']);
    assert.deepEqual(tabs({ 'raids.edit': ['t1'] }), ['schedule']);
    assert.deepEqual(tabs({ 'raids.edit': [] }), []);
    assert.deepEqual(tabs({ 'raids.view': 'guild' }), []);
    assert.deepEqual(tabs({ 'guild.teams': 'guild', 'guild.access': 'guild', 'raids.edit': 'guild', 'attendance.policy': 'guild' }), ['general', 'teams', 'schedule', 'people', 'guests', 'dataaccess', 'attendance', 'notifications', 'applications', 'battlenet']);
    assert.equal(G.shell.settingsTabs({ 'raids.edit': 'guild' })[0].label, 'Raid schedule');
    assert.equal(G.shell.canSeeSettings({ 'raids.edit': ['t1'] }), false, 'a Team Lead alone does not get the Guild settings item: the Raids page links to the tab');
    const frame = G.shell.settingsFrameHtml({ guildData: gd(OFFICER_CAN) }, 'schedule', '<p>x</p>');
    assert(/aria-current="page">Raid schedule</.test(frame) && frame.includes('href="#/g/g1/settings/schedule"'));
  });

  // ── the panel ────────────────────────────────────────────────────
  await check('panel: nothing while its data is not loaded; a failed load is a card with Try again', () => {
    assert.equal(G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: null }), '');
    const err = G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: { status: 'error', message: 'Could not reach Raidsmith.' } });
    assert(err.includes('Could not reach Raidsmith.') && err.includes('data-action="su-retry"') && err.includes('role="alert"'));
  });

  await check('panel (member): header says when it closes; four big status buttons with the current one pressed; character, spec and note; no officer tools', () => {
    const out = panel(view());
    assert(out.includes('id="su-h">Sign-ups<') && /Open until Sat, Oct 24, 8:00 PM|Open until Sat Oct 24, 8:00 PM/.test(out), out.slice(0, 600));
    for (const [kind, label] of [['signed', 'Sign up'], ['late', 'Late'], ['tentative', 'Tentative'], ['absence', 'Can&#39;t come']]) {
      assert(new RegExp('data-action="su-kind" data-kind="' + kind + '"[^>]*aria-pressed="' + (kind === 'signed' ? 'true' : 'false') + '"[^>]*>' + label.replace('&#39;', "(?:'|&#39;)") + '<').test(out), kind);
    }
    assert(!/su-kind[^>]*disabled/.test(out), 'open: the buttons work');
    assert(out.includes('id="su-char"') && out.includes('Eliora (Priest)') && out.includes('Mirabel (Hunter)'));
    assert(/<option value="Holy" selected>/.test(out) && out.includes('>Discipline<') && out.includes('>Shadow<') && out.includes('No spec'));
    assert(out.includes('id="su-note"') && out.includes('maxlength="120"'));
    assert(out.includes('data-action="su-withdraw"') && out.includes('Save details'));
    assert(!out.includes('data-action="su-lock"') && !out.includes('data-action="su-add"') && !out.includes('data-action="su-edit"'));
    assert(out.includes('You are down as <strong>signed up</strong> with Eliora (Holy)'));
    assertNoRawAttrs(out);
  });

  await check('panel (member): counts, the class strip, and the list by role then by status with class colours; Late and Raid-Helper rows marked; notes shown', () => {
    const out = panel(view());
    const text = stripTags(out);
    assert(/Signed 4 Late 1 Tentative 1 Bench 1 Can&#39;t come 1/.test(text), text.slice(0, 500));
    assert(/Paladin 1/.test(text) && /Priest 1/.test(text) && /Rogue 2/.test(text) && /Hunter 1/.test(text) && !/Mage 1/.test(stripTags(out.slice(out.indexOf('gs-su-classes'), out.indexOf('</ul>', out.indexOf('gs-su-classes'))))));
    const order = ['Tanks', 'Healers', 'Melee', 'Ranged', 'Tentative', 'Bench', 'Can&#39;t come'].map(t => out.indexOf('>' + t + ' <span'));
    assert(order.every(i => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'groups in role order, then status: ' + order);
    assert(!out.includes('No role yet'), 'an empty group is left out');
    assert(out.includes('class="gs-char-name gs-class-paladin">Thoren<') && out.includes('gs-class-priest">Eliora<'));
    assert(/Back by 8:15/.test(out) && out.includes('class="gs-su-note"'));
    assert(/gs-schip-warning[^>]*>.*?<\/svg>Late<\/span>/.test(out), 'Late is marked in its role group');
    assert(out.includes('<span class="gs-chip gs-chip-src">Raid-Helper</span>'));
    assert(out.includes('Unmatched sign-up') && out.includes('Rogue - Subtlety'), 'a row nobody may name still says what was signed up');
    assert(out.includes('<span class="gs-chip gs-chip-main">You</span>') && out.includes('class="gs-su-item is-me"'));
    assert(out.includes('<h3 class="gs-su-group-h" id="su-g-melee">Melee <span class="gs-su-count">2</span>'), 'Kaelith (late) and the unmatched Rogue are melee');
  });

  await check('panel: closed by an officer or started - buttons disabled with the reason; officers keep their tools; a past raid shows the panel only to officers or when there are sign-ups', () => {
    const locked = view({ raid: { id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: true, locked: true, closed: 'locked' }, me: Object.assign({}, view().me, { canChange: false, closed: 'locked' }) });
    const out = panel(locked);
    assert(out.includes('Closed by an officer') && out.includes('An officer has closed sign-ups.'));
    assert(/data-kind="signed"[^>]*disabled/.test(out) && /data-kind="absence"[^>]*disabled/.test(out) && /id="su-note"[^>]*disabled/.test(out));
    assert(!out.includes('Save details'), 'nothing to save while it is closed');
    const started = view({ raid: { id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: false, locked: false, closed: 'started' }, me: Object.assign({}, view().me, { canChange: false, closed: 'started' }) });
    const past = DETAIL({ raid: Object.assign({}, DETAIL().raid, { upcoming: false }) });
    const pastOut = panel(started, { data: past });
    assert(pastOut.includes('The raid has started'), 'the pill says so');
    assert(!pastOut.includes('data-action="su-kind"') && !pastOut.includes('so sign-ups can no longer be changed here.') && !pastOut.includes('id="su-me"'), 'after the start there is no status form, not even a disabled one');
    assert.equal(panel(Object.assign({}, started, { entries: [] }), { data: past }), '', 'a past raid nobody signed up for: no panel for a member');
    const officerPast = panel(Object.assign({}, OFFICER_VIEW(), { entries: ENTRIES }), { data: past, guildData: gd(OFFICER_CAN) });
    assert(!officerPast.includes('data-action="su-add"') && !officerPast.includes('data-action="su-lock"'), 'after the start: no Add a sign-up and no Close sign-ups');
    assert(officerPast.includes('data-action="su-edit"'), 'the officer still sees the sign-ups and can correct a row');
    assert(panel(Object.assign({}, OFFICER_VIEW(), { entries: [] }), { data: past, guildData: gd(OFFICER_CAN) }).includes('No sign-ups yet.'), 'officers see the empty panel');
  });

  await check('panel (officer): Add a sign-up and Close sign-ups, Edit on every person row, Remove only on Raidsmith rows; the unmatched row has no tools; nicknames shown', () => {
    const v = OFFICER_VIEW({ entries: ENTRIES.map(e => (e.name === 'Mirabel' ? Object.assign({}, e, { nickname: 'Mira-nick' }) : e)) });
    const out = panel(v, { guildData: gd(OFFICER_CAN) });
    assert(out.includes('data-action="su-add"') && out.includes('data-action="su-lock" data-lock="1"') && out.includes('>Close sign-ups<'));
    assert(!out.includes('id="su-me-h"'), 'an officer who is not on the roster has no sign-up of their own');
    assert.equal(out.split('data-action="su-edit"').length - 1, 7, 'every row with a person');
    assert.equal(out.split('data-action="su-remove"').length - 1, 6, 'the Raidsmith rows only (Mirabel is a Raid-Helper row)');
    assert(/data-action="su-edit" data-pid="p_m"/.test(out) && !/data-action="su-remove" data-pid="p_m"/.test(out));
    assert(out.includes('Mira-nick'));
    const closed = panel(OFFICER_VIEW({ raid: { id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: true, locked: true, closed: 'locked' } }), { guildData: gd(OFFICER_CAN) });
    assert(closed.includes('data-lock="0"') && closed.includes('>Reopen sign-ups<'));
    assertNoRawAttrs(out);
  });

  await check('panel: a member of another team sees the sentence, not the list; the Raid-Helper sign-up of the viewer says what pressing a button does', () => {
    const hidden = panel(view({ can: { edit: false, self: false, seeList: false, seeNicknames: false }, me: null, counts: null, entries: null }));
    assert(hidden.includes('Sign-ups are visible to the team&#39;s members.') || hidden.includes("Sign-ups are visible to the team's members."));
    assert(!hidden.includes('gs-su-item') && !hidden.includes('gs-summary'));
    const rh = view({ me: Object.assign({}, view().me, { signup: ENTRIES[3] }) });
    assert(panel(rh).includes('on Raid-Helper. Choosing a status here saves a sign-up in Raidsmith that replaces it.'));
    const none = view({ me: Object.assign({}, view().me, { signup: null }) });
    const noneOut = panel(none);
    assert(noneOut.includes('You have not signed up yet.') && !noneOut.includes('Save details') && !noneOut.includes('data-action="su-withdraw"'));
    assert(/data-kind="signed"[^>]*aria-pressed="false"/.test(noneOut) && noneOut.includes('gs-btn gs-su-kind gs-btn-molten'), 'Sign up stands out until it is chosen');
    assert(panel(view({ entries: [] , counts: Object.assign({}, COUNTS, { expected: 0 }) })).includes('No sign-ups yet.'));
  });

  await check('panel: hostile text (names, notes, specs, nicknames) is escaped everywhere', () => {
    const evil = (e) => Object.assign({}, e, { name: HOSTILE + QUOTES, spec: HOSTILE, note: HOSTILE + QUOTES, nickname: HOSTILE + QUOTES });
    const v = OFFICER_VIEW({ entries: ENTRIES.map(evil), roster: [{ personId: 'p_t', name: HOSTILE + QUOTES, status: 'raider', characters: [Object.assign({}, CHAR_PRIEST, { name: HOSTILE + QUOTES })] }] });
    assertEscaped(panel(v, { guildData: gd(OFFICER_CAN) }), 'officer panel');
    const me = view({ entries: ENTRIES.map(evil), me: Object.assign({}, view().me, { signup: evil(ENTRIES[1]), characters: [Object.assign({}, CHAR_PRIEST, { name: HOSTILE + QUOTES }), CHAR_HUNTER] }) });
    const ui = Object.assign(G.pages.raidSignups.freshUi(me), {}); ui.form.note = HOSTILE + QUOTES;
    assertEscaped(G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: Object.assign(state(me), { ui }) }), 'member panel');
    assertEscaped(G.pages.raidSignups.editDialogHtml({ view: v, personId: 'p_t' }), 'edit dialog');
    assertEscaped(G.pages.raidSignups.removeDialogHtml('p_t', HOSTILE + QUOTES), 'remove dialog');
  });

  await check('form: starts from the current sign-up (a Raid-Helper one is matched to the character it was named by), else the default character and its main spec', () => {
    const F = G.pages.raidSignups.formFrom;
    assert.deepEqual(plain(F(view())), { characterId: 'c_eli', spec: 'Holy', note: '' });
    const withNative = view({ me: Object.assign({}, view().me, { signup: entry({ characterId: 'c_mir', name: 'Mirabel', spec: 'Survival', note: 'hi' }) }) });
    assert.deepEqual(plain(F(withNative)), { characterId: 'c_mir', spec: 'Survival', note: 'hi' });
    const rh = view({ me: Object.assign({}, view().me, { signup: entry({ source: 'raid_helper', characterId: null, name: 'Mirabel', spec: 'Beast Mastery' }) }) });
    assert.deepEqual(plain(F(rh)), { characterId: 'c_mir', spec: 'Beast Mastery', note: '' });
    const none = view({ me: Object.assign({}, view().me, { signup: null, defaultCharacterId: 'c_mir' }) });
    assert.deepEqual(plain(F(none)), { characterId: 'c_mir', spec: 'Marksmanship', note: '' });
    const odd = view({ me: Object.assign({}, view().me, { signup: entry({ characterId: 'c_eli', name: 'Eliora', spec: 'Fury' }) }) });
    assert.equal(F(odd).spec, 'Holy', 'a spec the character cannot have falls back to its main spec');
    assert.equal(F(view({ me: null })), null);
  });

  await check('my sign-up: a status button sends the form as it stands; the answer replaces the panel; Save details keeps the status; Remove my sign-up', withState(async (S) => {
    const x = openRaid(S, view());
    const answer = view({ me: Object.assign({}, view().me, { signup: ENTRIES[1] }) });
    const s = stub(() => Promise.resolve(answer));
    G.handlers.click['su-kind'](el({ 'data-kind': 'late' }));
    await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/raids/u1/signup', { kind: 'late', characterId: 'c_eli', spec: 'Holy', note: null }]]);
    assert.equal(x.data, answer);
    assert.equal(x.ui.busy, false);
    // The character changes: its main spec is chosen and the specs are the new class's.
    G.handlers.change['su-char'](el({}, { value: 'c_mir' }));
    assert.deepEqual(plain(x.ui.form), { characterId: 'c_mir', spec: 'Marksmanship', note: '' });
    G.handlers.change['su-spec'](el({}, { value: 'Survival' }));
    G.handlers.input['su-note'](el({}, { value: 'on my hunter' }));
    let html = G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: x });
    assert(/<option value="c_mir" selected>/.test(html) && /<option value="Survival" selected>/.test(html) && html.includes('value="on my hunter"') && html.includes('>Beast Mastery<') && !html.includes('>Shadow<'));
    s.calls.length = 0;
    G.handlers.submit['su-details-form']();
    await tick();
    assert.deepEqual(s.calls.map(c => c.body), [{ kind: 'signed', characterId: 'c_mir', spec: 'Survival', note: 'on my hunter' }], 'the current status (signed) with the new details');
    s.calls.length = 0;
    G.handlers.click['su-withdraw']();
    await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/raids/u1/signup']]);
    s.restore();
  }));

  await check('my sign-up: an error stays in the panel; a closed window or a vanished sign-up reads the view again', withState(async (S) => {
    const x = openRaid(S, view());
    const closedView = view({ raid: { id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: true, locked: true, closed: 'locked' }, me: Object.assign({}, view().me, { canChange: false, closed: 'locked' }) });
    let n = 0;
    const s = stub((m) => (m === 'put' ? Promise.reject(new ApiErr(409, 'signups_closed', { message: 'An officer has closed sign-ups for this raid. Ask an officer.', reason: 'locked' })) : (n++, Promise.resolve(closedView))));
    G.handlers.click['su-kind'](el({ 'data-kind': 'late' }));
    await tick(); await tick();
    assert.equal(x.ui.error, 'An officer has closed sign-ups for this raid. Ask an officer.');
    assert.equal(n, 1);
    assert.equal(x.data, closedView, 'the page now shows the closed state');
    assert.equal(S.pageAlert, '', 'not the page alert');
    assert(G.pages.raidSignups.panelHtml({ guildData: gd(MEMBER_CAN), data: DETAIL(), state: x }).includes('An officer has closed sign-ups for this raid. Ask an officer.'));
    s.restore();
    const x2 = openRaid(S, view());
    const bad = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'A note is at most 120 characters.', field: 'note' })));
    G.handlers.click['su-kind'](el({ 'data-kind': 'signed' }));
    await tick();
    assert.equal(x2.ui.error, 'A note is at most 120 characters.');
    assert.equal(x2.ui.busy, false);
    bad.restore();
  }));

  await check('officer: Close / Reopen, the edit dialog sends the form for that person, the remove dialog asks first; a past raid reads the detail again', withState(async (S) => {
    const v = OFFICER_VIEW();
    const x = openRaid(S, v, OFFICER_CAN);
    const answer = OFFICER_VIEW({ raid: { id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: true, locked: true, closed: 'locked' } });
    const s = stub(() => Promise.resolve(answer));
    G.handlers.click['su-lock'](el({ 'data-lock': '1' }));
    await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/raids/u1/signups/lock', {}]]);
    assert.equal(x.data, answer);
    s.calls.length = 0;
    G.handlers.click['su-lock'](el({ 'data-lock': '0' }));
    await tick();
    assert.equal(s.calls[0].url, '/api/guild/g1/raids/u1/signups/unlock');
    // The dialogs.
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html) => { opened.push(html); return null; };
    G.handlers.click['su-edit'](el({ 'data-pid': 'p_t' }));
    G.handlers.click['su-add'](el({}));
    G.handlers.click['su-remove'](el({ 'data-pid': 'p_t' }));
    G.handlers.click['su-edit'](el({ 'data-pid': 'p_nobody' }));
    G.ui.openDialog = realOpen;
    assert.equal(opened.length, 3, 'an unknown person opens nothing');
    assert(opened[0].includes('Change a sign-up') && opened[0].includes('type="hidden" name="person" value="p_t"') && opened[0].includes('Thorenmage (Mage)'));
    assert(/<option value="late"/.test(opened[0]) && /<option value="bench"/.test(opened[0]));
    assert(opened[1].includes('Add a sign-up') && opened[1].includes('id="su-d-person"') && opened[1].includes('data-change="su-dlg-person"'));
    assert(opened[2].includes('Remove this sign-up?') && opened[2].includes('data-submit="su-remove-form"') && opened[2].includes('data-pid="p_t"'));
    // Submitting the edit dialog.
    s.calls.length = 0;
    const realRun = G.ui.runDialog; G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    const realSet = G.ui.setText; G.ui.setText = () => {};
    const form = { elements: { person: { value: 'p_t' }, kind: { value: 'bench' }, character: { value: 'c_th2' }, spec: { value: 'Arcane' }, note: { value: '  standby ' } } };
    G.handlers.submit['su-edit-form'](form);
    await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/raids/u1/signups/p_t', { kind: 'bench', characterId: 'c_th2', spec: 'Arcane', note: 'standby' }]]);
    s.calls.length = 0;
    G.handlers.submit['su-edit-form']({ elements: { person: { value: 'p_n' }, kind: { value: 'signed' }, character: { value: '' }, spec: { value: '' }, note: { value: '' } } });
    await tick();
    assert.deepEqual(s.calls[0].body, { kind: 'signed', spec: null, note: null }, 'no character chosen = the Worker\'s default; no spec, no note');
    s.calls.length = 0;
    G.handlers.submit['su-remove-form'](el({ 'data-pid': 'p_t' }, { getAttribute: k => (k === 'data-pid' ? 'p_t' : null) }));
    await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/guild/g1/raids/u1/signups/p_t']]);
    G.ui.runDialog = realRun; G.ui.setText = realSet;
    s.restore();
    // A past raid: its results moved, so the page's detail is read again.
    S.att.raid.data = DETAIL({ raid: Object.assign({}, DETAIL().raid, { upcoming: false }) });
    let reloaded = 0;
    const realReload = G.pages.raid.reload; G.pages.raid.reload = () => { reloaded++; };
    const s2 = stub(() => Promise.resolve(answer));
    G.handlers.click['su-lock'](el({ 'data-lock': '1' }));
    await tick();
    assert.equal(reloaded, 1);
    G.pages.raid.reload = realReload;
    s2.restore();
  }));

  await check('dialog helpers: the character and spec lists follow the person and the character', withState(async (S) => {
    openRaid(S, OFFICER_VIEW(), OFFICER_CAN);
    const person = { value: 'p_n' };
    const form = { elements: { person, kind: { value: '' }, character: { innerHTML: '' }, spec: { innerHTML: '' }, note: { value: 'x' } }, closest() { return this; } };
    form.closest = () => form;
    G.handlers.change['su-dlg-person']({ value: 'p_n', closest: () => form });
    assert.equal(form.elements.kind.value, 'signed');
    assert(form.elements.character.innerHTML.includes('Nodisc (Rogue)') && !form.elements.character.innerHTML.includes('Thoren'));
    assert(/<option value="Combat" selected>/.test(form.elements.spec.innerHTML) && form.elements.spec.innerHTML.includes('Subtlety'));
    assert.equal(form.elements.note.value, '');
    form.elements.person.value = 'p_t';
    form.elements.character.value = 'c_th2';
    G.handlers.change['su-dlg-char']({ value: 'c_th2', closest: () => form });
    assert(/<option value="Fire" selected>/.test(form.elements.spec.innerHTML) && form.elements.spec.innerHTML.includes('Frost') && !form.elements.spec.innerHTML.includes('Protection'));
    // Editing someone with a sign-up starts from it.
    const html = G.pages.raidSignups.editDialogHtml({ view: OFFICER_VIEW(), personId: 'p_t' });
    assert(/<option value="signed" selected>/.test(html) && /<option value="c_th" selected>/.test(html) && /<option value="Protection" selected>/.test(html));
  }));

  await check('loading: the panel reads GET /signups with the detail; a lost sign-in is thrown to the route, any other failure is a card', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const s = stub(() => Promise.resolve(view()));
    await G.pages.raidSignups.loadFor(S.guilds.g1, DETAIL());
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/raids/u1/signups']]);
    assert.equal(S.att.raidSignups.status, 'ok');
    assert.deepEqual(plain(S.att.raidSignups.ui.form), { characterId: 'c_eli', spec: 'Holy', note: '' });
    S.att.raidSignups.ui.error = 'old';
    await G.pages.raidSignups.loadFor(S.guilds.g1, DETAIL());
    assert.equal(S.att.raidSignups.ui.error, '', 'a reload clears the old error');
    s.restore();
    const down = stub(() => Promise.reject(new ApiErr(0, 'network', { message: 'Could not reach Raidsmith.' })));
    await G.pages.raidSignups.loadFor(S.guilds.g1, DETAIL());
    assert.deepEqual([S.att.raidSignups.status, S.att.raidSignups.message], ['error', 'Could not reach Raidsmith.']);
    down.restore();
    const out = stub(() => Promise.reject(new ApiErr(401, 'signed_out', { message: 'Sign in.' })));
    await assert.rejects(() => G.pages.raidSignups.loadFor(S.guilds.g1, DETAIL()), e => e.status === 401);
    out.restore();
  }));

  // ── the Raids list ───────────────────────────────────────────────
  const UP = (over) => Object.assign({
    id: 'u1', raidOn: '2026-10-24', startsAt: STARTS, upcoming: true, zone: 'Black Temple', title: 'Prog night', eventSourced: false, eventId: null, otherServer: false,
    signups: { signed: 4, late: 1, bench: 1, tentative: 1, absence: 1 }, locked: false, signupsOpen: true, mine: null, planned: false, planLive: null,
  }, over || {});
  const LIST = (over) => Object.assign({
    team: { id: 't1', name: 'Team KJ', archived: false }, today: '2026-10-17', can: { edit: false, signup: true }, schedule: null, hasMore: false,
    upcoming: [UP(), UP({ id: 'u2', raidOn: '2026-10-27', mine: { kind: 'signed', source: 'raidsmith', characterName: 'Eliora' } })], raids: [],
  }, over || {});
  const listPage = (data, can, over) => G.pages.raids.raidsHtml(Object.assign({ guildData: gd(can || MEMBER_CAN), teamId: 't1', data, tab: 'upcoming' }, over || {}));

  await check('Raids list: the status item of a card for those who can sign up - a Sign up button, a chip with the kind, Sign-ups closed', () => {
    const out = listPage(LIST({ upcoming: [
      UP(),
      UP({ id: 'u2', mine: { kind: 'signed', source: 'raidsmith', characterName: 'Eliora' } }),
      UP({ id: 'u3', mine: { kind: 'absence', source: 'raidsmith', characterName: 'Eliora' } }),
      UP({ id: 'u4', signupsOpen: false, locked: true }),
      UP({ id: 'u5', signupsOpen: false, locked: true, mine: { kind: 'late', source: 'raid_helper', characterName: null } }),
    ] }));
    const btn = id => new RegExp('data-action="raids-signup" data-rid="' + id + '"');
    assert(btn('u1').test(out) && !btn('u2').test(out) && !btn('u3').test(out) && !btn('u4').test(out) && !btn('u5').test(out));
    assert.equal(out.split('data-action="raids-signup"').length - 1, 1, 'u1 only: a sign-up of any kind shows its word instead');
    assert(out.includes('<span class="gs-hd-chip is-green">Signed up</span>') && out.includes('<span class="gs-hd-chip is-grey">Can&#39;t come</span>'), 'a not-coming sign-up is Can\'t come everywhere');
    assert(out.includes('Sign-ups closed') && out.includes('<span class="gs-hd-chip is-grey">Late</span>'));
    assert.equal(out.split('Sign-ups closed').length - 1, 1, 'u4 only');
    const noChar = listPage(LIST({ can: { edit: false, signup: false } }));
    assert(!noChar.includes('raids-signup') && !noChar.includes('Sign-ups closed') && !noChar.includes('gs-rc-status'), 'a viewer with no character gets no status item');
    assertNoRawAttrs(out);
  });

  await check('Raids list: Raid schedule link and Create upcoming raids for editors (the button only with slots); the result sentence', () => {
    const none = listPage(LIST({ can: { edit: true, signup: false }, schedule: { slots: 0, weeks: 2, auto: false } }), OFFICER_CAN);
    assert(none.includes('href="#/g/g1/settings/schedule"') && none.includes('>Raid schedule<') && !none.includes('raids-fill'));
    const some = listPage(LIST({ can: { edit: true, signup: false }, schedule: { slots: 2, weeks: 2, auto: false } }), OFFICER_CAN);
    assert(some.includes('data-action="raids-fill"') && some.includes('>Create upcoming raids<'));
    const member = listPage(LIST());
    assert(!member.includes('raids-fill') && !member.includes('Raid schedule'));
    assert(listPage(LIST({ upcoming: [] }), OFFICER_CAN, { note: 'Created 2 upcoming raids: Oct 20, Oct 22.' }).includes('role="status"><span>Created 2 upcoming raids: Oct 20, Oct 22.'));
    const F = G.pages.raids.fillText;
    assert.equal(F({ created: [{ raidOn: '2026-10-20' }, { raidOn: '2026-10-22' }], skipped: [{ reason: 'exists' }, { reason: 'past' }], weeks: 2 }), 'Created 2 upcoming raids: Oct 20, Oct 22. 1 date already had a raid.');
    assert.equal(F({ created: [{ raidOn: '2026-10-20' }], skipped: [{ reason: 'exists' }, { reason: 'exists' }], weeks: 2 }), 'Created 1 upcoming raid: Oct 20. 2 dates already had a raid.');
    assert.equal(F({ created: [], skipped: [{ reason: 'exists' }], weeks: 1 }), 'Nothing new to create: the next 1 week already have their raids.'.replace('1 week already', '1 week already'));
    assert(F({ created: [], skipped: [{ reason: 'no_such_time' }], weeks: 2 }).endsWith('1 slot was skipped because that time does not exist on a day the clocks change.'));
    const PAST = { id: 'r9', raidOn: '2026-10-10', startsAt: 1, upcoming: false, zone: null, bosses: { kills: 0, pulls: 0 }, sources: { event: false, reports: 0, plan: false }, counts: null, openFlags: 0, state: 'awaiting_log', stale: false };
    assert(listPage(LIST({ upcoming: [], raids: [PAST] }), OFFICER_CAN).includes('Create upcoming raids from the weekly schedule'));
    assert(listPage(LIST({ upcoming: [] }), OFFICER_CAN).includes('set a weekly schedule'), 'the empty page points at the schedule');
  });

  await check('Raids list: one-click Sign up sends only the kind, folds the answer into the row, and a closed window reads the list again', withState(async (S) => {
    S.guilds.g1 = gd(MEMBER_CAN); S.currentGid = 'g1';
    const x = S.att.raids = { gid: 'g1', teamId: 't1', data: LIST(), more: false, tab: 'upcoming' };
    const answer = view({ counts: Object.assign({}, COUNTS, { signed: 5 }), me: Object.assign({}, view().me, { signup: entry({ name: 'Eliora', source: 'raidsmith', kind: 'signed' }) }) });
    const s = stub(() => Promise.resolve(answer));
    const button = el({ 'data-rid': 'u1' });
    G.handlers.click['raids-signup'](button);
    assert.equal(button.disabled, true);
    await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/raids/u1/signup', { kind: 'signed' }]]);
    const row = x.data.upcoming[0];
    assert.deepEqual(plain(row.mine), { kind: 'signed', source: 'raidsmith', characterName: 'Eliora' });
    assert.equal(row.signups.signed, 5);
    s.restore();
    // The window closed meanwhile.
    const closed = LIST({ upcoming: [UP({ signupsOpen: false, locked: true })] });
    const s2 = stub((m) => (m === 'put' ? Promise.reject(new ApiErr(409, 'signups_closed', { message: 'An officer has closed sign-ups for this raid. Ask an officer.', reason: 'locked' })) : Promise.resolve(closed)));
    const b2 = el({ 'data-rid': 'u1' });
    G.handlers.click['raids-signup'](b2);
    await tick(); await tick();
    assert.equal(b2.disabled, false);
    assert.equal(S.att.raids.data.upcoming[0].signupsOpen, false);
    assert.equal(S.pageAlert, 'An officer has closed sign-ups for this raid. Ask an officer.');
    s2.restore();
  }));

  await check('Raids list: Create upcoming raids runs the fill, shows what happened and reads the list again; the schedule can fill by itself once a day', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST({ can: { edit: true, signup: false }, schedule: { slots: 2, weeks: 2, auto: false } }), more: false, tab: 'past' };
    const filled = { created: [{ raidId: 'r_a', raidOn: '2026-10-20', startsAt: 1, zone: null, title: null }], skipped: [], weeks: 2, today: '2026-10-17' };
    const s = stub((m, url) => Promise.resolve(m === 'post' ? filled : LIST({ upcoming: [UP({ id: 'r_a', raidOn: '2026-10-20' })] })));
    G.handlers.click['raids-fill'](el({}));
    await tick(); await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/teams/t1/schedule/raids', {}], ['get', '/api/guild/g1/raids?team=t1', undefined]]);
    assert.equal(S.att.raids.note, 'Created 1 upcoming raid: Oct 20.');
    assert.equal(S.att.raids.tab, 'upcoming');
    assert.equal(S.att.raids.data.upcoming[0].id, 'r_a');
    s.restore();
    // Automatic: the list loads, the schedule says auto, one POST, one more GET; the same day again does not fill twice.
    ctx.Guild.app.teamFor = () => 't1';
    const auto = LIST({ can: { edit: true, signup: false }, schedule: { slots: 2, weeks: 2, auto: true } });
    const s2 = stub((m, url) => Promise.resolve(m === 'post' ? filled : (s2.calls.filter(c => c.m === 'get').length > 1 ? LIST({ upcoming: [UP({ id: 'r_a' })], schedule: auto.schedule }) : auto)));
    S.att.raids = null;
    await G.pages.raids.load({ name: 'section', section: 'raids' }, S.guilds.g1);
    assert.deepEqual(s2.calls.map(c => c.m + ' ' + c.url), ['get /api/guild/g1/raids?team=t1', 'post /api/guild/g1/teams/t1/schedule/raids', 'get /api/guild/g1/raids?team=t1']);
    assert.equal(S.att.raids.note, 'Created 1 upcoming raid: Oct 20.');
    s2.calls.length = 0;
    await G.pages.raids.load({ name: 'section', section: 'raids' }, S.guilds.g1);
    assert.deepEqual(s2.calls.map(c => c.m), ['get'], 'once a day per browser session');
    s2.restore();
    // Not auto, no slots, or not an editor: never.
    for (const sched of [null, { slots: 2, weeks: 2, auto: false }, { slots: 0, weeks: 2, auto: true }]) {
      S.att.autoFilled = {};
      const s3 = stub(() => Promise.resolve(LIST({ schedule: sched })));
      await G.pages.raids.load({ name: 'section', section: 'raids' }, S.guilds.g1);
      assert.deepEqual(s3.calls.map(c => c.m), ['get'], JSON.stringify(sched));
      s3.restore();
    }
    // A failing fill leaves the page as it loaded.
    S.att.autoFilled = {};
    const s4 = stub((m) => (m === 'post' ? Promise.reject(new ApiErr(429, 'rate_limited', { message: 'slow down' })) : Promise.resolve(auto)));
    await G.pages.raids.load({ name: 'section', section: 'raids' }, S.guilds.g1);
    assert.equal(S.att.raids.note, '');
    assert.equal(S.att.raids.data.upcoming.length, 2);
    s4.restore();
  }));

  // ── Settings > Raid schedule ─────────────────────────────────────
  const SCHED = (over) => Object.assign({
    team: { id: 't1', name: 'Team KJ', archived: false },
    slots: [{ id: 'ts_b', weekday: 4, startTime: '20:30', zone: null, title: null }, { id: 'ts_a', weekday: 2, startTime: '20:00', zone: 'Karazhan', title: 'Prog' }],
    weeks: 3, auto: true, can: { edit: true }, timeZone: 'America/New_York', zones: ['Karazhan', 'Gruul\'s Lair', 'Black Temple'],
  }, over || {});
  const schedState = (data, over) => Object.assign({ gid: 'g1', teamId: 't1', data, draft: G.pages.settingsSchedule.draftFrom(data), error: '', note: '', busy: false }, over || {});
  const schedPage = (s, can) => G.pages.settingsSchedule.scheduleHtml({ guildData: gd(can || OFFICER_CAN), s });

  await check('schedule page: slot rows Monday first with day, time, zone and title; weeks and auto; Save and Create upcoming raids now; the team picker only with several teams', () => {
    const out = schedPage(schedState(SCHED()));
    assert(out.indexOf('id="sched-day-0"') > 0 && out.indexOf('<option value="2" selected>Tuesday') > 0 && out.indexOf('<option value="4" selected>Thursday') > out.indexOf('<option value="2" selected>Tuesday'), 'Tuesday before Thursday');
    assert(/id="sched-time-0"[^>]*value="20:00"/.test(out) && /id="sched-time-1"[^>]*value="20:30"/.test(out));
    assert(/<option value="Karazhan" selected>/.test(out) && out.includes('No zone') && out.includes('Black Temple'));
    assert(/id="sched-title-0"[^>]*maxlength="100"[^>]*value="Prog"/.test(out));
    assert(/<option value="3" selected>3 weeks/.test(out) && out.includes('1 week<') && out.includes('8 weeks<'));
    assert(/id="sched-auto"[^>]*checked/.test(out) && out.includes('when an officer opens Raids'));
    assert(out.includes('data-action="sched-fill"') && !/data-action="sched-fill"[^>]*disabled/.test(out) && out.includes('data-submit="sched-form"') && out.includes('Save schedule'));
    assert(out.includes('America/New_York') && out.includes('aria-label="Remove slot 1 (Tuesday)"'));
    assert(out.includes('id="sched-team"'), 'an officer of two teams picks one');
    assert(!schedPage(schedState(SCHED()), LEAD_CAN).includes('id="sched-team"'), 'a lead of one team has nothing to pick');
    const empty = schedPage(schedState(SCHED({ slots: [], auto: false })));
    assert(empty.includes('No weekly slots yet.') && /data-action="sched-fill"[^>]*disabled/.test(empty) && !/id="sched-auto"[^>]*checked/.test(empty));
    assert(/data-action="sched-add"[^>]*disabled/.test(schedPage(schedState(SCHED({ slots: Array.from({ length: 7 }, (_, i) => ({ id: 'ts' + i, weekday: i, startTime: '18:00', zone: null, title: null })) })))), 'seven slots are the most');
    assertNoRawAttrs(out);
    assertEscaped(schedPage(schedState(SCHED({ slots: [{ id: 'ts_a', weekday: 2, startTime: '20:00', zone: null, title: HOSTILE + QUOTES }], timeZone: HOSTILE }))), 'schedule page');
  });

  await check('schedule page: add / remove / edit work on a draft; a new slot takes Tuesday, else the first free day; the body is what the Worker takes; problems are found before sending', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const sc = S.att.settingsSchedule = schedState(SCHED());
    const H = G.pages.settingsSchedule;
    assert.equal(H.nextFreeWeekday([{ weekday: 1 }]), 2);
    assert.equal(H.nextFreeWeekday([{ weekday: 2 }, { weekday: 1 }]), 3);
    assert.equal(H.nextFreeWeekday(Array.from({ length: 7 }, (_, i) => ({ weekday: i }))), null);
    G.handlers.click['sched-add'](el({}));
    assert.deepEqual(plain(sc.draft.slots.map(x => [x.weekday, x.startTime])), [[1, '20:00'], [2, '20:00'], [4, '20:30']], 'Tuesday is taken, so Monday; sorted Monday first');
    G.handlers.click['sched-remove'](el({ 'data-idx': '0' }));
    assert.equal(sc.draft.slots.length, 2);
    G.handlers.input['sched-field'](el({ 'data-idx': '0', 'data-field': 'title' }, { value: ' Raid night ' }));
    G.handlers.change['sched-field'](el({ 'data-idx': '1', 'data-field': 'weekday' }, { value: '6' }));
    G.handlers.change['sched-field'](el({ 'data-idx': '1', 'data-field': 'zone' }, { value: 'Karazhan' }));
    G.handlers.change['sched-weeks'](el({}, { value: '5' }));
    G.handlers.change['sched-auto'](el({}, { checked: false }));
    assert.deepEqual(plain(H.bodyOf(sc.draft)), {
      slots: [{ weekday: 2, startTime: '20:00', zone: 'Karazhan', title: 'Raid night' }, { weekday: 6, startTime: '20:30', zone: 'Karazhan', title: null }],
      weeks: 5, auto: false,
    });
    assert.equal(H.problemOf({ slots: [{ weekday: 2, startTime: '20:00' }, { weekday: 2, startTime: '21:00' }] }), 'Slot 2: a team has one raid per day, so each day can be used once (Tuesday comes twice).');
    assert.equal(H.problemOf({ slots: [{ weekday: 2, startTime: '' }] }), 'Slot 1: enter a start time like 20:00.');
    assert.equal(H.problemOf({ slots: [{ weekday: 2, startTime: '20:00' }, { weekday: 0, startTime: '07:00' }] }), '');
  }));

  await check('schedule page: Save sends the draft, adopts the answer with a note; a server error names the slot; a duplicate day never leaves the browser; Create upcoming raids now', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const sc = S.att.settingsSchedule = schedState(SCHED());
    const saved = SCHED({ weeks: 4 });
    let s = stub(() => Promise.resolve(saved));
    G.handlers.submit['sched-form']();
    await tick();
    assert.equal(s.calls.length, 1);
    assert.deepEqual([s.calls[0].m, s.calls[0].url], ['put', '/api/guild/g1/teams/t1/schedule']);
    assert.deepEqual(s.calls[0].body, { slots: [{ weekday: 2, startTime: '20:00', zone: 'Karazhan', title: 'Prog' }, { weekday: 4, startTime: '20:30', zone: null, title: null }], weeks: 3, auto: true });
    assert.equal(S.att.settingsSchedule.note, '', 'the page head says Saved at; there is no banner');
    assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'schedule');
    assert.equal(S.att.settingsSchedule.draft.weeks, 4);
    s.restore();
    // A duplicate weekday is caught here.
    S.att.settingsSchedule.draft.slots[1].weekday = 2;
    s = stub(() => Promise.resolve(saved));
    G.handlers.submit['sched-form']();
    assert.equal(s.calls.length, 0);
    assert(/Slot 2: a team has one raid per day/.test(S.att.settingsSchedule.error));
    s.restore();
    // The Worker's own 400.
    S.att.settingsSchedule = schedState(SCHED());
    s = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'Pick a zone from the list.', field: 'slots', index: 1, slotField: 'zone' })));
    G.handlers.submit['sched-form']();
    await tick();
    assert.equal(S.att.settingsSchedule.error, 'Slot 2: Pick a zone from the list.');
    assert.equal(S.att.settingsSchedule.busy, false);
    s.restore();
    // Create upcoming raids now.
    s = stub(() => Promise.resolve({ created: [{ raidId: 'r_a', raidOn: '2026-10-20' }, { raidId: 'r_b', raidOn: '2026-10-22' }], skipped: [], weeks: 3 }));
    S.att.raids = { gid: 'g1', teamId: 't1', data: LIST() };
    G.handlers.click['sched-fill'](el({}));
    await tick();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/teams/t1/schedule/raids', {}]]);
    assert.equal(S.att.settingsSchedule.note, 'Created 2 upcoming raids: Oct 20, Oct 22.');
    assert.equal(S.att.raids, null, 'the Raids list is read again when it opens');
    s.restore();
  }));

  await check('schedule page: loading picks the team the viewer may edit (the previous one, the shell\'s pick, else the first); nobody who may edit gets a 403', withState(async (S) => {
    const lead = gd(LEAD_CAN);
    S.guilds.g1 = lead; S.currentGid = 'g1';
    ctx.Guild.app.teamFor = () => 't2';
    const s = stub(() => Promise.resolve(SCHED()));
    await G.pages.settingsSchedule.load({ name: 'settings', tab: 'schedule' }, lead);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/teams/t1/schedule'], 'the lead of t1 gets t1 even though the shell picked t2');
    assert.equal(S.att.settingsSchedule.teamId, 't1');
    ctx.Guild.app.teamFor = () => 't2';
    s.calls.length = 0;
    const officer = gd(OFFICER_CAN);
    S.guilds.g1 = officer;
    S.att.settingsSchedule = null;
    await G.pages.settingsSchedule.load({ name: 'settings', tab: 'schedule' }, officer);
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/teams/t2/schedule']);
    // Changing the team reads that team's schedule.
    s.calls.length = 0;
    G.handlers.change['sched-team'](el({}, { value: 't1' }));
    await tick();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/teams/t1/schedule']);
    assert.equal(S.att.settingsSchedule.teamId, 't1');
    await assert.rejects(() => G.pages.settingsSchedule.load({ name: 'settings', tab: 'schedule' }, gd(MEMBER_CAN)), e => e.status === 403);
    s.restore();
    assert(G.pages.settingsSchedule.main({ name: 'settings', tab: 'schedule' }, gd(OFFICER_CAN), { guildData: gd(OFFICER_CAN) }).includes('Raid schedule'));
  }));

  // ── the code itself ──────────────────────────────────────────────
  await check('safety: no raw paths in the pages (every call goes through G.api.signups), ASCII only, no inline styles or handlers in the source', () => {
    for (const f of ['pages-raid-signups.js', 'pages-settings-schedule.js']) {
      const src = read('js/guild/' + f);
      assert(!/G\.api\.(get|post|put|patch|del)\(/.test(src), f + ' goes through G.api.signups');
      // The section-heading comments use the house box-drawing dashes; code and copy are ASCII.
      assert(!/[^\x00-\x7f]/.test(src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')), f + ' is ASCII');
      assert(!/\sstyle=|\son(click|change|input|submit)=/i.test(src), f + ' has inline style or handlers');
    }
    const raids = read('js/guild/pages-raids.js');
    assert(!/[^\x00-\x7f]/.test(raids.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')), 'pages-raids.js is ASCII');
    const api = read('js/guild/api.js');
    const block = api.slice(api.indexOf('// Every sign-up and raid-schedule call'));
    const paths = [...block.matchAll(/Path\(gid, (?:rid, |tid, )?'([^']*)'/g)].map(m => m[1]);
    assert(paths.length >= 2);
    for (const p of ['/signups', '/signup', '/signups/', '/signups/lock', '/signups/unlock']) assert(block.includes("'" + p + "'") || block.includes(p), p);
    assert(block.includes("'/teams/'") && block.includes("'/schedule'"));
  });

  await check('scripts: both new pages are in the guild script list, in index.html, faq.html and whats-new.html, after the pages they build on', () => {
    for (const name of ['pages-raid-signups', 'pages-settings-schedule']) {
      const src = '/js/guild/' + name + '.js';
      assert(GUILD_SCRIPTS.includes(src), name);
      for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert(guildScriptsOf(read(page)).includes(src), name + ' in ' + page);
    }
    assert(GUILD_SCRIPTS.indexOf('/js/guild/pages-raid-signups.js') > GUILD_SCRIPTS.indexOf('/js/guild/pages-raid.js'));
    assert(GUILD_SCRIPTS.indexOf('/js/guild/pages-settings-schedule.js') < GUILD_SCRIPTS.indexOf('/js/guild/app.js'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
