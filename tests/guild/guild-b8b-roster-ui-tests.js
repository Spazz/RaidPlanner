/**
 * Raidsmith guild UI, lane roster of B8b - the Roster's tick mode (Manage team), Add to team, Remove from team and the person record's Remove from team
 * Run: node tests/guild/guild-b8b-roster-ui-tests.js
 *
 * Same approach as guild-b3ui-teams-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM, the render functions return HTML strings and the handlers run against a stubbed
 * G.api. guild-b8b-roster-contract-tests.js runs the same pages against the real Worker.
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
const { GUILD_SCRIPTS } = require('../guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const els = {};
let twins = [];
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: sel => (/data-cid/.test(sel) ? twins : []) };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setTimeout(r, 2));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const stripTags = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&middot;/g, String.fromCharCode(183)).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const count = (text, re) => (text.match(re) || []).length;
const DOT = String.fromCharCode(183);

function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

// ── fixtures ─────────────────────────────────────────────────────
const TEAMS = [{ id: 't1', name: 'Team KJ', size: 25, archived: false, players: 25, trialDays: 14, leads: [] }, { id: 't2', name: 'Sunday Alts', size: 25, archived: false, players: 3, trialDays: 7, leads: [] }];
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'guild.teams': 'guild' };
const LEAD_CAN = { 'roster.view': 'guild', 'roster.edit': ['t1'] };
const MEMBER_CAN = { 'roster.view': 'guild' };
const ROLES = { WARRIOR: { Protection: 'tank' }, PRIEST: { Holy: 'healer' }, MAGE: { Fire: 'dps' }, HUNTER: { Survival: 'dps' }, PALADIN: { Holy: 'healer' } };
function gd(can, teams) {
  return {
    guild: { id: 'g1', name: 'Vindicated', realm: 'Dreamscythe', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', createdAt: 1 },
    teams: (teams || TEAMS).map(t => Object.assign({}, t)), me: { roles: [], can }, rosterOptions: { classes: [], specs: {}, roles: ROLES }, rosterFlags: { t1: 0 }, teamRequestFlags: {}, applicationFlags: {},
  };
}
function row(id, name, cls, spec, over) {
  const o = over || {};
  return {
    id: 'p_' + id, status: o.status || 'raider', joinedOn: '2026-06-01', trialStart: null, trialEnd: null, trialFlag: null, version: 1, raidRole: o.raidRole === undefined ? 'melee' : o.raidRole,
    shown: { id: 'c_' + id, name, class: cls, mainSpec: spec, offSpec: null, role: 'dps', isMain: o.alt ? false : true, coreRank: o.coreRank || o.status || 'raider', inGameRank: o.ig === undefined ? 'Core Raider' : o.ig,
      trialStart: null, trialEnd: null, trialFlag: o.flag || null },
    main: { id: 'c_' + id + 'm', name: o.mainName || name, class: cls, team: { id: 't1', name: 'Team KJ' } }, names: [name], altCount: o.alts || 0, signIn: 'not_yet', isMe: !!o.isMe,
  };
}
const PEOPLE = [row(1, 'Fenwick', 'WARRIOR', 'Protection', { raidRole: 'tank' }), row(2, 'Lumenfall', 'PRIEST', 'Holy', { raidRole: 'healer' }), row(3, 'Marrowind', 'MAGE', 'Fire', { alt: true, mainName: 'Emberlyn', status: 'trial', ig: 'Raider', raidRole: 'ranged' })];
const OFF = [
  { id: 'c_o1', name: 'Aldwyn', class: 'PALADIN', mainSpec: 'Holy', isMain: true, kind: 'social', coreRank: 'social', inGameRank: 'Member', leftOn: null, leftReason: null, person: { id: 'p_o1', name: 'Aldwyn' } },
  { id: 'c_o2', name: 'Fallowick', class: 'HUNTER', mainSpec: 'Survival', isMain: true, kind: 'former', coreRank: 'social', inGameRank: null, leftOn: '2026-10-02', leftReason: 'left', person: { id: 'p_o2', name: 'Fallowick' } },
  { id: 'c_o3', name: 'Pyrewick', class: 'MAGE', mainSpec: 'Fire', isMain: true, kind: 'former', coreRank: 'social', inGameRank: null, leftOn: '2026-10-02', leftReason: 'kicked', person: { id: 'p_o3', name: 'Pyrewick' } },
];
const TICK = (cid, pid, name, cls, spec) => ({ cid, pid, name, class: cls, mainSpec: spec, teamId: 't1' });
function rosterData(over) { return Object.assign({ team: { id: 't1', name: 'Team KJ', archived: false, trialDays: 14 }, today: '2026-10-28', can: { edit: true }, rankSegments: ['raider', 'trial'], people: PEOPLE.map(plain) }, over || {}); }
const page = (g, data, manage, extra) => G.pages.roster.rosterHtml(Object.assign({ guildData: g, data, view: { status: 'everyone', query: '' }, manage: manage || null, requests: [] }, extra || {}));

function stub(handler) {
  const calls = [];
  const real = G.api;
  G.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { G.api = real; } };
}
const ApiErr = (status, code, message) => new G.api.ApiError(status, { error: code, message });
function withState(fn) {
  return async () => {
    const S = G.app.state;
    const saved = { currentGid: S.currentGid, guilds: S.guilds, roster: S.roster, rosterManage: S.rosterManage, rosterNotice: S.rosterNotice, person: S.person };
    const savedApp = { render: G.app.render, requireSignin: G.app.requireSignin, refreshRoster: G.app.refreshRoster, setPerson: G.app.setPerson, applyFlags: G.app.applyFlags };
    const savedUi = { openDialog: G.ui.openDialog, replaceDialogBody: G.ui.replaceDialogBody, closeDialogOf: G.ui.closeDialogOf, setBusy: G.ui.setBusy, setText: G.ui.setText };
    const log = { rendered: 0, dialogs: [], replaced: [], closed: 0, refreshed: [], flags: [], texts: {} };
    G.app.render = () => { log.rendered++; };
    G.app.refreshRoster = (gid, team) => { log.refreshed.push(gid + ':' + team); return Promise.resolve(); };
    G.app.applyFlags = (gid, res) => { log.flags.push(res && res.rosterFlags); };
    G.app.requireSignin = () => { throw new Error('sent to sign-in'); };
    G.ui.openDialog = html => { log.dialogs.push(html); return null; };
    G.ui.replaceDialogBody = (dlg, html) => { log.replaced.push(html); return dlg; };
    G.ui.closeDialogOf = () => { log.closed++; };
    G.ui.setBusy = () => {};
    G.ui.setText = (id, text) => { log.texts[id] = text; };
    S.currentGid = 'g1'; S.guilds = { g1: gd(OFFICER_CAN) }; S.roster = { gid: 'g1', teamId: 't1', data: rosterData() }; S.rosterManage = null; S.rosterNotice = ''; S.person = null;
    Object.keys(els).forEach(k => delete els[k]);
    twins = [];
    try { await fn(S, log); } finally { Object.assign(S, saved); Object.assign(G.app, savedApp); Object.assign(G.ui, savedUi); }
  };
}
const dlgForm = (extra) => Object.assign({ querySelector: () => null, querySelectorAll: () => [], closest: () => ({}), elements: {} }, extra || {});

(async () => {
  // ═══ Manage team: the tick mode of the Roster ═════════════════════
  await check('Manage team: rows are labels with a checkbox (no links), the head has no primary, the hint, the Off the roster group and the bar with the count', () => {
    const manage = { gid: 'g1', teamId: 't1', ticked: { c_1: TICK('c_1', 'p_1', 'Fenwick', 'WARRIOR', 'Protection'), c_o1: TICK('c_o1', 'p_o1', 'Aldwyn', 'PALADIN', 'Holy') }, off: { status: 'ready', list: OFF } };
    const out = page(gd(OFFICER_CAN), rosterData(), manage);
    assert(!/<a class="gs-rs-row/.test(out), 'no row is a link while managing');
    assert(count(out, /<label class="gs-rs-row gs-rs-pickable/g) >= 3 + 3, 'every row (desktop and phone copies) and the three Off the roster rows are labels');
    assert(/<label class="gs-rs-row gs-rs-pickable is-ticked"[^>]*><span class="gs-us-chkbox"><input type="checkbox" class="gs-us-chk" data-change="roster-tick" data-cid="c_1" aria-label="Select Fenwick" checked>/.test(out), 'a ticked row is tinted and checked');
    assert(/data-cid="c_2" aria-label="Select Lumenfall">/.test(out), 'an unticked row has no checked attribute');
    assert.equal(count(out, /gs-btn-molten/g), 0, 'the head primary is hidden while editing');
    assert(out.includes('id="roster-more"') && !out.includes('>Manage team<') && !out.includes('>Add person<') && out.includes('Import from a CSV file'), 'More keeps the imports only');
    assert(out.includes('Tick the people to remove from Team KJ.'));
    const off = out.slice(out.indexOf('aria-label="Off the roster"'));
    assert(/gs-fg-ght">Off the roster<\/span><span class="gs-fg-ghn">3</.test(off), 'the group head counts the characters');
    assert.deepEqual([...off.matchAll(/gs-hd-chip is-rose">(\w+)</g)].map(m => m[1]).slice(0, 3), ['Social', 'Former', 'Former']);
    assert(off.includes('Member in game') && off.includes('Left the guild') && off.includes('Removed from the guild'), 'why each is off the roster: the in-game rank, left, removed');
    assert(/data-cid="c_o1" aria-label="Select Aldwyn" checked/.test(off), 'the ticked off-roster character is checked');
    const bar = out.slice(out.indexOf('id="roster-selbar"'));
    assert(bar.includes('2 selected') && bar.includes('data-action="roster-remove-open"') && !/roster-remove-open[^>]*disabled/.test(bar.slice(0, bar.indexOf('Done'))) && bar.includes('data-action="roster-done"'));
    const none = page(gd(OFFICER_CAN), rosterData(), { gid: 'g1', teamId: 't1', ticked: {}, off: { status: 'ready', list: [] } });
    assert(none.includes('0 selected') && /<button type="button" class="gs-btn gs-btn-sm" disabled[^>]*data-action="roster-remove-open"/.test(none), 'nothing ticked: Remove waits');
    assert(!none.includes('Off the roster'), 'an empty group draws nothing');
    assertNoRawAttrs(out);
  });

  await check('Manage team: only an officer or Team Lead of the team gets the mode; a member, an archived team and the plain page never do', () => {
    const member = page(gd(MEMBER_CAN), rosterData({ can: { edit: false } }), { gid: 'g1', teamId: 't1', ticked: {}, off: { status: 'ready', list: OFF } });
    assert(!member.includes('gs-rs-pickable') && !member.includes('roster-selbar') && !member.includes('Off the roster') && !member.includes('data-action="roster-manage"'));
    const archived = page(gd(OFFICER_CAN), rosterData({ team: { id: 't1', name: 'Team KJ', archived: true } }), { gid: 'g1', teamId: 't1', ticked: {}, off: { status: 'ready', list: OFF } });
    assert(!archived.includes('gs-rs-pickable') && !archived.includes('roster-selbar'));
    const plainPage = page(gd(OFFICER_CAN), rosterData());
    assert(!plainPage.includes('gs-rs-pickable') && !plainPage.includes('roster-selbar') && plainPage.includes('data-action="roster-manage"') && plainPage.includes('data-action="roster-add-team"'));
    // An empty roster still reaches Manage team (a team whose placed characters are all Social or Former).
    const empty = page(gd(OFFICER_CAN), rosterData({ people: [] }), { gid: 'g1', teamId: 't1', ticked: {}, off: { status: 'ready', list: OFF } });
    assert(empty.includes('Off the roster') && empty.includes('roster-selbar') && empty.includes('No one on the roster yet'));
    const emptyPlain = page(gd(OFFICER_CAN), rosterData({ people: [] }));
    assert(emptyPlain.includes('data-action="roster-add-team"') && emptyPlain.includes('id="roster-empty-more"') && emptyPlain.includes('data-action="roster-manage"'));
  });

  await check('Manage team: Manage team opens the mode and reads the Off the roster list; a tick adds or drops the character, the twins follow and the bar counts; Done leaves the mode', withState(async (S, log) => {
    const s = stub((m, url) => Promise.resolve({ team: { id: 't1', name: 'Team KJ' }, characters: OFF }));
    G.handlers.click['roster-manage']();
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.m + ' ' + c.url), ['get /api/guild/g1/roster/off-roster?team=t1']);
    assert.deepEqual([S.rosterManage.off.status, S.rosterManage.off.list.length, Object.keys(S.rosterManage.ticked).length], ['ready', 3, 0]);
    assert(log.rendered >= 2, 'drawn once with the loading state, once with the list');
    const bar = fakeBar();
    const box = tickBox('c_1', true);
    twins = [box, tickBox('c_1', true)];
    G.handlers.change['roster-tick'](box);
    assert.deepEqual(Object.keys(S.rosterManage.ticked), ['c_1']);
    assert.deepEqual(plain(S.rosterManage.ticked.c_1), { cid: 'c_1', pid: 'p_1', name: 'Fenwick', class: 'WARRIOR', mainSpec: 'Protection', teamId: 't1' });
    assert(twins.every(t => t.checked === true && t.rowClass.has('is-ticked')), 'the desktop and phone copies say the same');
    assert(bar.innerHTML.includes('1 selected'));
    const off = tickBox('c_o2', true);
    G.handlers.change['roster-tick'](off);
    assert.deepEqual(plain(S.rosterManage.ticked.c_o2), { cid: 'c_o2', pid: 'p_o2', name: 'Fallowick', class: 'HUNTER', mainSpec: 'Survival', teamId: 't1' }, 'an off-roster character is ticked like the others');
    assert(bar.innerHTML.includes('2 selected'));
    box.checked = false; twins = [box];
    G.handlers.change['roster-tick'](box);
    assert.deepEqual(Object.keys(S.rosterManage.ticked), ['c_o2']);
    assert(bar.innerHTML.includes('1 selected'));
    G.handlers.change['roster-tick'](tickBox('c_unknown', true));
    assert.deepEqual(Object.keys(S.rosterManage.ticked), ['c_o2'], 'a character the page does not hold is ignored');
    G.handlers.click['roster-done']();
    assert.equal(S.rosterManage, null);
  }));

  function fakeBar() { const b = { innerHTML: '' }; els['roster-selbar'] = b; return b; }
  function tickBox(cid, checked) {
    const rowClass = new Set();
    return { checked, rowClass, getAttribute: k => (k === 'data-cid' ? cid : null), closest: () => ({ classList: { toggle: (c, on) => { if (on) rowClass.add(c); else rowClass.delete(c); } } }) };
  }

  // ═══ Remove from team: the confirm, the releases, the answer ═══════
  await check('Remove confirm: one name or many, the upcoming sign-ups of each (raids and standing), the unticked box that frees the seats, a danger primary', () => {
    const entries = [
      { cid: 'c_1', pid: 'p_1', name: 'Fenwick', class: 'WARRIOR', mainSpec: 'Protection', teamId: 't1', read: { signups: [{ raidOn: '2026-10-29', zone: 'Serpentshrine Cavern' }, { raidOn: '2026-11-01', zone: 'Tempest Keep' }], standing: [] } },
      { cid: 'c_o1', pid: 'p_o1', name: 'Aldwyn', class: 'PALADIN', mainSpec: 'Holy', teamId: 't1', read: { signups: [], standing: [{ weekday: 4 }] } },
      { cid: 'c_o3', pid: 'p_o3', name: 'Pyrewick', class: 'MAGE', mainSpec: 'Fire', teamId: 't1', read: { signups: [], standing: [] } },
      { cid: 'c_o2', pid: 'p_o2', name: 'Fallowick', class: 'HUNTER', mainSpec: 'Survival', teamId: 't1', read: null },
    ];
    const many = G.pages.rosterTeam.removeDialogHtml({ teamName: 'Team KJ', entries });
    assert(many.includes('Remove 4 people from Team KJ?') && many.includes('They leave the Team KJ roster. Past raids, attendance and loot stay. Ticking the box frees their seats in those plans.'));
    assert(!many.includes('and stay in the guild'), 'the old sentence is untrue for a Former character');
    const text = stripTags(many);
    assert(text.includes('Upcoming sign-ups for Team KJ raids') && text.includes('Thu Oct 29 Serpentshrine Cavern, Sun Nov 1 Tempest Keep'));
    assert(text.includes('Standing sign-up: Thu') && text.includes('No upcoming sign-ups') && text.includes('The upcoming sign-ups could not be read'));
    assert(/<input type="checkbox" id="rm-also" name="removeSignups"><label for="rm-also">Also remove them from these upcoming raids<\/label>/.test(many), 'asked each time, unticked');
    assert(many.includes('gs-btn-danger') && many.includes('data-action="dialog-cancel" autofocus') && many.includes('data-submit="roster-remove-form"'));
    const one = G.pages.rosterTeam.removeDialogHtml({ teamName: 'Team KJ', entries: [entries[0]] });
    assert(one.includes('Remove Fenwick from Team KJ?') && one.includes('Fenwick leaves the Team KJ roster.') && one.includes('frees their seat in those plans') && one.includes('Also remove Fenwick from these upcoming raids'));
    assertNoRawAttrs(many);
  });

  await check('Remove answer: who left and who was skipped, with the API\'s sentence each; the title counts', () => {
    const e = (cid, name, cls) => ({ cid, pid: 'p_' + cid, name, class: cls, mainSpec: null, teamId: 't1' });
    const SENIOR = 'That person\'s account ranks the same as you or above you, so only someone more senior can change them.';
    const mixed = G.pages.rosterTeam.resultDialogHtml({ teamName: 'Team KJ', done: [e('c_a', 'Aldwyn', 'PALADIN'), e('c_f', 'Fenwick', 'WARRIOR')], skipped: [{ entry: e('c_g', 'Ashgrove', 'DRUID'), message: SENIOR }] });
    assert(mixed.includes('Removed 2 of 3 people') && mixed.includes('1 person was skipped.'));
    const text = stripTags(mixed);
    assert(text.includes('Aldwyn Removed from Team KJ') && text.includes('Fenwick Removed from Team KJ') && text.includes('Ashgrove ' + SENIOR.replace(/'/g, "'")));
    assert(mixed.includes('data-submit="roster-remove-done"') && count(mixed, /data-action="dialog-cancel"/g) === 0 && mixed.includes('gs-btn-molten'), 'one primary: Done');
    assert(G.pages.rosterTeam.resultDialogHtml({ teamName: 'Team KJ', done: [e('c_a', 'Aldwyn', 'PALADIN'), e('c_f', 'Fenwick', 'WARRIOR')], skipped: [] }).includes('Removed 2 people'));
    assert(G.pages.rosterTeam.resultDialogHtml({ teamName: 'Team KJ', done: [e('c_a', 'Aldwyn', 'PALADIN')], skipped: [] }).includes('Removed Aldwyn from Team KJ'));
    const none = G.pages.rosterTeam.resultDialogHtml({ teamName: 'Team KJ', done: [], skipped: [{ entry: e('c_g', 'Ashgrove', 'DRUID'), message: SENIOR }, { entry: e('c_h', 'Hexen', 'MAGE'), message: 'Server says so.' }] });
    assert(none.includes('No one was removed') && none.includes('2 people were skipped.'));
  });

  await check('Remove from team (Roster): the sign-ups of every ticked character are read, then the dialog opens; the form sends ONE release per character with the page\'s team and the box; skipped names stay ticked, the others leave', withState(async (S, log) => {
    S.rosterManage = { gid: 'g1', teamId: 't1', ticked: { c_1: TICK('c_1', 'p_1', 'Fenwick', 'WARRIOR', 'Protection'), c_2: TICK('c_2', 'p_2', 'Lumenfall', 'PRIEST', 'Holy'), c_3: TICK('c_3', 'p_3', 'Marrowind', 'MAGE', 'Fire') }, off: { status: 'ready', list: [] } };
    let s = stub((m, url) => Promise.resolve({ signups: [{ raidOn: '2026-10-29', zone: 'Gruul\'s Lair' }], standing: [] }));
    G.handlers.click['roster-remove-open']();
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.m + ' ' + c.url).sort(), ['get /api/guild/g1/roster/p_1/characters/c_1/team-signups', 'get /api/guild/g1/roster/p_2/characters/c_2/team-signups', 'get /api/guild/g1/roster/p_3/characters/c_3/team-signups']);
    assert.equal(log.dialogs.length, 1);
    assert(log.dialogs[0].includes('Remove 3 people from Team KJ?') && stripTags(log.dialogs[0]).includes('Thu Oct 29 Gruul\'s Lair'));
    // The submit: the second release is refused by the Seniority guard; the answer is a list.
    const SENIOR = 'That person\'s account ranks the same as you or above you, so only someone more senior can change them.';
    const box = { checked: true };
    const form = dlgForm({ querySelector: sel => (/removeSignups/.test(sel) ? box : null), closest: () => ({}) });
    s = stub((m, url) => (/p_2\//.test(url) ? Promise.reject(ApiErr(403, 'seniority', SENIOR)) : Promise.resolve({ person: { id: 'p' }, rosterFlags: { t1: 1 } })));
    G.handlers.submit['roster-remove-form'](form);
    await settle();
    s.restore();
    assert.deepEqual(s.calls.filter(c => c.m === 'del').map(c => [c.m, c.url, c.body]), [
      ['del', '/api/guild/g1/roster/p_1/characters/c_1/team', { fromTeamId: 't1', removeSignups: true }],
      ['del', '/api/guild/g1/roster/p_2/characters/c_2/team', { fromTeamId: 't1', removeSignups: true }],
      ['del', '/api/guild/g1/roster/p_3/characters/c_3/team', { fromTeamId: 't1', removeSignups: true }],
    ], 'one call per character, in the order ticked');
    assert.equal(log.replaced.length, 1);
    assert(log.replaced[0].includes('Removed 2 of 3 people') && stripTags(log.replaced[0]).includes('Lumenfall ' + SENIOR));
    assert.deepEqual(Object.keys(S.rosterManage.ticked), ['c_2'], 'the skipped name stays ticked, the removed leave the selection');
    assert.deepEqual(log.refreshed, ['g1:t1'], 'the list is read again');
    assert.equal(s.calls.at(-1).url, '/api/guild/g1/roster/off-roster?team=t1', 'and so is the Off the roster group (the mode goes on: a name was skipped)');
    assert.deepEqual(log.flags, [{ t1: 1 }], 'the nav badge follows the last answer that worked');
    // Done closes the answer.
    G.handlers.submit['roster-remove-done'](dlgForm());
    assert.equal(log.closed, 1);
  }));

  await check('Remove from team (Roster): everything removed leaves the tick mode; nothing ticked opens no dialog; the box left unticked sends removeSignups false', withState(async (S, log) => {
    S.rosterManage = { gid: 'g1', teamId: 't1', ticked: {}, off: { status: 'ready', list: [] } };
    const s0 = stub(() => Promise.resolve({}));
    G.handlers.click['roster-remove-open']();
    await settle();
    s0.restore();
    assert.deepEqual([s0.calls.length, log.dialogs.length], [0, 0]);
    S.rosterManage.ticked = { c_1: TICK('c_1', 'p_1', 'Fenwick', 'WARRIOR', 'Protection') };
    let s = stub(() => Promise.resolve({ signups: [], standing: [] }));
    G.handlers.click['roster-remove-open']();
    await settle();
    s.restore();
    s = stub(() => Promise.resolve({ rosterFlags: {} }));
    G.handlers.submit['roster-remove-form'](dlgForm({ querySelector: () => ({ checked: false }) }));
    await settle();
    s.restore();
    assert.deepEqual(s.calls[0].body, { fromTeamId: 't1', removeSignups: false });
    assert(log.replaced[0].includes('Removed Fenwick from Team KJ'));
    assert.equal(S.rosterManage, null, 'all gone: the mode ends');
  }));

  // ═══ Add to team ═════════════════════════════════════════════════
  const CANDIDATES = [
    { id: 'c_f', name: 'Fallowmere', class: 'HUNTER', mainSpec: 'Survival', realm: 'Dreamscythe', isMain: true, status: 'raider', inGameRank: 'Core Raider', trialEnd: null, person: { id: 'p_f', name: 'Fallowmere' }, requestedTeamId: null },
    { id: 'c_l', name: 'Larkwick', class: 'PRIEST', mainSpec: 'Holy', realm: 'Dreamscythe', isMain: false, status: 'raider', inGameRank: 'Core Raider', trialEnd: null, person: { id: 'p_c', name: 'Coppervane' }, requestedTeamId: 't1' },
    { id: 'c_p', name: 'Pellan', class: 'MAGE', mainSpec: 'Fire', realm: 'Dreamscythe', isMain: true, status: 'trial', inGameRank: 'Raider', trialEnd: null, person: { id: 'p_p', name: 'Pellan' }, requestedTeamId: 't1' },
    { id: 'c_t', name: 'Tamsin', class: 'WARRIOR', mainSpec: 'Protection', realm: 'Dreamscythe', isMain: true, status: 'trial', inGameRank: null, trialEnd: '2026-11-04', person: { id: 'p_t', name: 'Tamsin' }, requestedTeamId: 't2' },
  ];
  const addState = (over) => Object.assign({ gid: 'g1', teamId: 't1', teamName: 'Team KJ', trialDays: 14, today: '2026-10-28', status: 'ready', list: CANDIDATES, more: false, q: '', picked: null, error: '' }, over || {});

  await check('Add to team dialog: a pick row per character (class and spec, the in-game rank, a waiting request, the core rank it becomes), the primary waits for a pick', () => {
    const out = G.pages.rosterTeam.addDialogHtml(addState());
    assert(out.includes('Add to Team KJ') && out.includes('Pick a guild member&#39;s character.') && out.includes('id="team-add-search"'));
    assert.equal(count(out, /name="pick"/g), 4);
    const text = stripTags(out);
    assert(text.includes('Fallowmere Survival Hunter ' + DOT + ' in-game Core Raider Raider') && text.includes('Larkwick Holy Priest ' + DOT + ' in-game Core Raider ' + DOT + ' asked for Team KJ Raider'));
    assert(text.includes('Pellan Fire Mage ' + DOT + ' in-game Raider ' + DOT + ' asked for Team KJ Trial') && text.includes('Tamsin Protection Warrior Trial'), 'the request for ANOTHER team is not mentioned');
    assert(/<button type="submit" class="gs-btn gs-btn-molten" disabled[^>]*id="team-add-go"><span>Add<\/span>/.test(out), 'nothing picked: the primary waits');
    assert(out.includes('id="team-add-what" hidden'));
    assert(!/gs-hd-panel gs-rs-joins" id="team-add-what"[^>]*>[^<]*<h3/.test(out), 'no What happens before a pick');
    assertNoRawAttrs(out);
  });

  await check('Add to team dialog: what a pick does - the Trial that starts (today + the team\'s trial length), the request it approves, the rank; a Raider has neither; a Trial with a date keeps it', () => {
    const picked = (id) => G.pages.rosterTeam.addDialogHtml(addState({ picked: id }));
    const pellan = stripTags(picked('c_p'));
    assert(pellan.includes('What happens') && pellan.includes('Rank Trial (in-game Raider) A promotion in game ends the trial.'));
    assert(pellan.includes('Trial Starts today, ends Nov 11 14 days, Team KJ\'s trial length.'), 'today Oct 28 + 14 days');
    assert(pellan.includes('Request Pellan\'s request for Team KJ is approved'));
    assert(picked('c_p').includes('is-picked') && picked('c_p').includes('<span>Add Pellan</span>') && !/id="team-add-go"[^>]*disabled/.test(picked('c_p').replace(/\n/g, '')));
    const fallow = stripTags(picked('c_f'));
    assert(fallow.includes('Rank Raider (in-game Core Raider)') && !fallow.includes('Trial Starts') && !fallow.includes('Request '));
    const tamsin = stripTags(picked('c_t'));
    assert(tamsin.includes('Rank Trial') && tamsin.includes('Trial Ends Nov 4') && !tamsin.includes('Starts today') && !tamsin.includes('A promotion in game'), 'a Trial that already has its dates keeps them; no in-game rank, no promotion line');
    assert(stripTags(G.pages.rosterTeam.addDialogHtml(addState({ picked: 'c_l' }))).includes('Request Larkwick\'s request for Team KJ is approved'), 'a Raider with a request: the request line too');
  });

  await check('Add to team dialog: states - loading, a failed read, nothing to add, no match for the search; the list filters by any part of the name', () => {
    assert(stripTags(G.pages.rosterTeam.addDialogHtml(addState({ status: 'loading', list: [] }))).includes('Loading characters...'));
    assert(G.pages.rosterTeam.addDialogHtml(addState({ status: 'error', list: [], error: 'Server says so.' })).includes('role="alert">Server says so.<'));
    assert(stripTags(G.pages.rosterTeam.addDialogHtml(addState({ list: [] }))).includes('No characters to add.'));
    const q = G.pages.rosterTeam.addDialogHtml(addState({ q: 'ELL' }));
    assert.equal(count(q, /name="pick"/g), 1, 'Pellan');
    assert(stripTags(G.pages.rosterTeam.addDialogHtml(addState({ q: 'zzz' }))).includes('No character matches "zzz".'));
    assert(stripTags(G.pages.rosterTeam.addDialogHtml(addState({ more: true }))).includes('Showing the first 4. Search to narrow the list.'));
  });

  await check('Add to team: the head button reads the characters for THIS team, a pick fills What happens, Add places the character with PUT, says so and reads the list and the requests again', withState(async (S, log) => {
    let s = stub((m, url) => Promise.resolve({ characters: CANDIDATES, more: false }));
    G.handlers.click['roster-add-team']();
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.m + ' ' + c.url), ['get /api/guild/g1/roster/unassigned?team=t1']);
    assert(log.dialogs[0].includes('Add to Team KJ') && log.dialogs[0].includes('Loading characters...'));
    const what = fakeEl('team-add-what'); fakeEl('team-add-list'); const go = fakeEl('team-add-go', { querySelector: () => ({ textContent: '' }) });
    G.handlers.change['team-add-pick']({ value: 'c_p' });
    assert(what.innerHTML.includes('Pellan&#39;s request for Team KJ is approved') && what.hidden === false && go.disabled === false);
    // Submit: PUT with the team; the notice names the approved request.
    let ran = null;
    const saved = G.ui.runDialog;
    G.ui.runDialog = (form, promise, onOk) => { ran = promise.then(res => onOk(res)); return ran; };
    const reads = [];
    G.pages.teamRequests.read = gid => { reads.push(gid); return Promise.resolve(); };
    s = stub(() => Promise.resolve({ person: { id: 'p_p' }, rosterFlags: { t1: 0 }, teamRequestFlags: { t1: 0 }, approvedRequestId: 'tq_9' }));
    G.handlers.submit['team-add-form'](dlgForm());
    await settle();
    s.restore();
    G.ui.runDialog = saved;
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/roster/p_p/characters/c_p/team', { teamId: 't1' }]]);
    assert.equal(S.rosterNotice, 'Added Pellan to Team KJ and approved their request.');
    assert.deepEqual([reads, log.refreshed], [['g1'], ['g1:t1']]);
  }));
  function fakeEl(id, over) { const e = Object.assign({ id, textContent: '', hidden: false, innerHTML: '', disabled: false, focus() {} }, over || {}); els[id] = e; return e; }

  // ═══ The person record ═══════════════════════════════════════════
  const char = (id, name, cls, spec, team, over) => Object.assign({ id, name, class: cls, mainSpec: spec, offSpec: null, role: 'dps', isMain: false, realm: 'Dreamscythe', team: team ? { id: team, name: team === 't1' ? 'Team KJ' : 'Sunday Alts', archived: false } : { id: null, name: null, archived: false },
    coreRank: 'raider', inGameRank: 'Core Raider', mayRelease: false }, over || {});
  const record = (chars, can) => ({
    today: '2026-10-28', can: Object.assign({ edit: true, notesView: true, notesEdit: true, delete: false, addCharacter: true }, can || {}),
    person: { id: 'p_1', status: 'raider', joinedOn: '2026-03-14', trialStart: null, trialEnd: null, trialFlag: null, isMe: false, version: 3, leftReason: null, leftOn: null,
      discord: { signIn: 'signed_in', user: null, nickname: null }, account: { user: { id: 'u1', displayName: 'Fenwick' }, via: 'discord' }, homeTeam: { id: 't1', name: 'Team KJ' } },
    characters: chars, notes: { text: '', version: 0, updatedBy: null, updatedAt: null },
  });
  const personPage = (rec) => G.pages.person.personHtml({ guildData: gd(LEAD_CAN), record: rec, linkable: [], alert: '', requests: { mine: [], pending: [], can: { decide: false } } });
  const FENWICK = char('c1', 'Fenwick', 'WARRIOR', 'Protection', 't1', { isMain: true, mayRelease: true });
  const WICKWOOD = char('c2', 'Wickwood', 'PRIEST', 'Holy', 't2');

  await check('Person record: Remove from team is a danger item in the head More only when the viewer may release a character; each character row says its own rank and in-game rank', () => {
    const lead = personPage(record([FENWICK, WICKWOOD]));
    const more = lead.slice(lead.indexOf('id="person-more-list"'), lead.indexOf('</header>'));
    assert(/<div class="gs-menu-sep" role="separator"><\/div><button[^>]*is-danger[^>]*data-action="person-remove-team" data-key="person-remove-team">Remove from team<\/button>/.test(more), 'after the rule, danger');
    assert(!more.includes('Delete person'), 'a Team Lead cannot delete');
    const officer = personPage(record([FENWICK, WICKWOOD], { delete: true }));
    const om = officer.slice(officer.indexOf('id="person-more-list"'), officer.indexOf('</header>'));
    assert(om.indexOf('Remove from team') < om.indexOf('Delete person') && count(om, /role="separator"/g) === 1, 'Remove from team, then Delete person, one rule');
    assert(!personPage(record([Object.assign({}, FENWICK, { mayRelease: false }), WICKWOOD])).includes('person-remove-team'), 'nothing the viewer may release: no item');
    assert(!personPage(record([Object.assign({}, FENWICK, { mayRelease: undefined })])).includes('person-remove-team'), 'an answer without mayRelease shows no item');
    const text = stripTags(lead);
    assert(text.includes('Raider (in-game Core Raider)'), 'the rank and the in-game rank of the character');
    const trial = personPage(record([Object.assign({}, FENWICK, { coreRank: 'trial', inGameRank: null })]));
    assert(stripTags(trial).includes(DOT + ' Trial') && !stripTags(trial).includes('(in-game'), 'no in-game rank: only the core rank');
  });

  await check('Person record: one releasable character gets the Roster\'s confirm, several get a tick list whose primary waits for a tick; the releases are one call per ticked character', withState(async (S, log) => {
    const rec = record([FENWICK, Object.assign({}, WICKWOOD, { mayRelease: true })]);
    S.person = { gid: 'g1', pid: 'p_1', record: rec };
    let s = stub((m, url) => Promise.resolve({ signups: /c1/.test(url) ? [{ raidOn: '2026-10-29', zone: 'Serpentshrine Cavern' }] : [], standing: [] }));
    G.handlers.click['person-remove-team']();
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url).sort(), ['/api/guild/g1/roster/p_1/characters/c1/team-signups', '/api/guild/g1/roster/p_1/characters/c2/team-signups']);
    const multi = log.dialogs[0];
    assert(multi.includes('Remove from a team') && multi.includes('Tick the characters to take off their team. Past raids, attendance and loot stay.') && multi.includes('Also remove them from their upcoming raids'));
    assert(count(multi, /name="release"/g) === 2 && /id="person-remove-go"[^>]*disabled|disabled[^>]*id="person-remove-go"/.test(multi), 'the primary waits for a tick');
    const text = stripTags(multi);
    assert(text.includes('Fenwick Team KJ ' + DOT + ' Thu Oct 29 Serpentshrine Cavern') && text.includes('Wickwood Sunday Alts ' + DOT + ' No upcoming sign-ups'));
    // Tick one: the primary opens.
    const go = { disabled: true };
    G.handlers.change['person-remove-pick']({ closest: () => ({ querySelectorAll: () => [{}], querySelector: () => go }) });
    assert.equal(go.disabled, false);
    G.handlers.change['person-remove-pick']({ closest: () => ({ querySelectorAll: () => [], querySelector: () => go }) });
    assert.equal(go.disabled, true);
    // Submit with only Wickwood ticked: one release, the record shows it, no answer dialog when nothing was skipped.
    const form = dlgForm({ querySelectorAll: sel => (/release/.test(sel) ? [{ value: 'c2' }] : []), querySelector: () => ({ checked: false }) });
    s = stub(() => Promise.resolve({ person: { id: 'p_1' }, characters: [], rosterFlags: { t1: 5 } }));
    const setPerson = [];
    G.app.setPerson = (gid, r) => setPerson.push(gid + ':' + r.person.id);
    G.handlers.submit['person-remove-form'](form);
    await settle();
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['del', '/api/guild/g1/roster/p_1/characters/c2/team', { fromTeamId: 't2', removeSignups: false }]]);
    assert.deepEqual([log.replaced.length, log.closed, setPerson], [0, 1, ['g1:p_1']]);
    // A refusal on the record is told before the dialog goes.
    log.dialogs.length = 0; log.closed = 0;
    S.person = { gid: 'g1', pid: 'p_1', record: record([FENWICK]) };
    s = stub(() => Promise.resolve({ signups: [], standing: [] }));
    G.handlers.click['person-remove-team']();
    await settle();
    s.restore();
    assert(log.dialogs[0].includes('Remove Fenwick from Team KJ?'), 'one releasable character: the Roster\'s confirm');
    s = stub(() => Promise.reject(ApiErr(403, 'seniority', 'That person\'s account ranks the same as you or above you, so only someone more senior can change them.')));
    G.handlers.submit['roster-remove-form'](dlgForm({ querySelector: () => ({ checked: true }) }));
    await settle();
    s.restore();
    assert(log.replaced.at(-1).includes('No one was removed') && stripTags(log.replaced.at(-1)).includes('only someone more senior can change them'));
  }));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
