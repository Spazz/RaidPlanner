/**
 * Raidsmith guild UI - the raid page shell (raids revamp, lane 2): the head (title, ONE chip per state, context line, More with page-level items only), the Raid settings
 * form dialog, the Raid facts panel with an officer's Change menus, the You bar (not signed up, signed up, closed, seated waiting / confirmed / declined, the officer who
 * raids too, the result after the raid) and the two-column layout with no stage strip.
 * Run: node guild-raidpage-ui-tests.js
 *
 * Same approach as guild-fw1a-ui-tests.js: the guild scripts load in a vm with no DOM and the pages return HTML strings; the few behaviours (the Raid settings dialog and its
 * PATCH) run against a few lines of fake DOM. The pages against the real Worker are checked in a browser by tools/guild-smoke.js.
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
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+,/g, ',').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
const count = (s, re) => (s.match(re) || []).length;
const settle = () => new Promise(r => setTimeout(r, 5));
const opsOf = html => [...html.matchAll(/data-op="([a-z-]+)"/g)].map(m => m[1]);

// ── fixtures ─────────────────────────────────────────────────────
const OFFICER_CAN = {
  'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'attendance.policy': 'guild',
  'guild.teams': 'guild', 'roster.edit': 'guild', 'loot.edit': 'guild', 'loot.view': 'guild',
};
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'signups.self': ['t1'] };
function gd(can, teams) {
  return {
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'firemaw', createdAt: 1 },
    teams: (teams || [{ id: 't1', name: 'Team KJ' }]).map(t => ({ id: t.id, name: t.name, size: 25, archived: false, players: 3, leads: [] })),
    me: { roles: [{ role: 'officer' }], can }, attendanceFlags: {},
  };
}
const STARTS = Date.UTC(2026, 9, 25, 0, 0); // Sat Oct 24 2026, 19:00 in Chicago (CDT)
const CLOSES = STARTS - 6 * 3600000;
function up(over, rover) {
  return Object.assign({
    raid: Object.assign({ id: 'u1', team: { id: 't1', name: 'Team KJ' }, teamId: 't1', raidOn: '2026-10-24', startsAt: STARTS, timeKnown: true, upcoming: true, title: null, zone: 'Karazhan', size: 10, state: 'awaiting_log', openFlags: 0, stale: false, version: 1, closesAt: CLOSES, closeHours: 6, signupsLocked: false }, rover || {}),
    can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
    sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [], duties: [],
  }, over || {});
}
function prow(id, name, extra) {
  return Object.assign({ playerId: id, name, class: 'DRUID', signup: 'signed', plan: null, pulls: { present: 8, total: 9, missedFirst: false, missedLast: false }, outcome: 'present', credit: 1, pending: false, needsReview: false, flags: [], decision: null }, extra || {});
}
function past(over, rover) {
  return Object.assign({
    raid: Object.assign({ id: 'r4', team: { id: 't1', name: 'Team KJ' }, teamId: 't1', raidOn: '2026-10-17', startsAt: 1, timeKnown: true, upcoming: false, zone: 'Black Temple', size: 25, state: 'reviewed', openFlags: 0, stale: false, version: 1 }, rover || {}),
    can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
    sources: { event: null, reports: [{ code: 'WaghkY9zwDyvLX7m', flavour: 'fresh', startedAt: 1, pulls: 9 }], plan: null },
    pulls: [{ encounter: 'Illidan', kill: true, startedAt: 1 }, { encounter: 'Illidan', kill: false, startedAt: 2 }],
    people: [prow('p_a', 'Alliesha', { plan: 'G1' }), prow('p_b', 'Brewmaw', { plan: 'bench', outcome: 'bench', pulls: { present: 0, total: 9, missedFirst: false, missedLast: false } })],
    unmatched: [], signups: [], duties: [],
  }, over || {});
}
const CHAR = { id: 'c1', name: 'Alliesha', class: 'DRUID', specs: ['Balance', 'Feral'], mainSpec: 'Balance' };
const ME = (over) => Object.assign({ personId: 'p_a', signup: null, notice: null, canChange: true, characters: [CHAR], defaultCharacterId: 'c1' }, over || {});
const SIGNED = { kind: 'signed', name: 'Alliesha', spec: 'Balance', source: 'raidsmith', characterId: 'c1' };
const view = (over, raidOver) => Object.assign({
  raid: Object.assign({ id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: true, locked: false, closed: null, closesAt: CLOSES, closeHours: 6 }, raidOver || {}),
  can: { edit: false, self: true, seeList: true, seeNicknames: false }, me: ME(), roster: [],
  counts: { signed: 3, late: 0, tentative: 0, bench: 1, absence: 0, expected: 3, byRole: {}, byClass: { DRUID: 3 } },
  entries: [{ key: 'p:p_a', personId: 'p_a', source: 'raidsmith', kind: 'signed', name: 'Alliesha', classId: 'DRUID', className: 'Druid', spec: 'Balance', role: 'ranged', characterId: 'c1', note: null, updatedAt: null, matched: true, isMe: true, nickname: null }],
}, over || {});
const sState = v => ({ gid: 'g1', rid: 'u1', status: 'ok', data: v, ui: G.pages.raidSignups.freshUi(v) });
const rState = (data, over) => Object.assign({ status: 'ok', data: Object.assign({ published: false }, data || {}) }, over || {});
const lState = (awards) => ({ gid: 'g1', rid: 'r4', status: 'ok', data: { awards: awards || [], canEdit: true }, ui: G.pages.raidLoot.freshUi() });
const PLAN = { label: 'Gruul night', players: 10, unmatched: [] };
const page = (data, over, can) => G.pages.raid.raidHtml(Object.assign({ guildData: gd(can || OFFICER_CAN), data }, over || {}));
const molten = html => count(html, /class="[^"]*gs-btn-molten[^"]*"/g);
const chipOf = html => { const m = /<span class="gs-hd-chip is-(\w+)">([^<]*)<\/span>/.exec(html); return m ? m[1] + ':' + m[2].replace(/&#39;/g, "'") : null; };
const labelsOf = (out, id) => {
  const menu = out.slice(out.indexOf('id="' + id + '-list"'), out.indexOf('</div></div>', out.indexOf('id="' + id + '-list"')));
  return [...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(m => m[1]);
};

(async () => {
  // ═══ 1. The head ═══
  await check('head chip, before the raid: Sign-ups open (green) or closed (grey, by an officer or the deadline); Needs recalculation (rose) wins; exactly one chip', () => {
    assert.equal(chipOf(page(up(), { signups: sState(view()) })), 'green:Sign-ups open');
    assert.equal(chipOf(page(up(), {})), 'green:Sign-ups open', 'until the sign-ups are read');
    assert.equal(chipOf(page(up(), { signups: sState(view({ raid: Object.assign({}, view().raid, { closed: 'locked', locked: true }) })) })), 'grey:Sign-ups closed');
    assert.equal(chipOf(page(up(), { signups: sState(view({ raid: Object.assign({}, view().raid, { closed: 'deadline' }) })) })), 'grey:Sign-ups closed');
    assert.equal(chipOf(page(up({}, { signupsLocked: true }), {})), 'grey:Sign-ups closed', 'an officer\'s lock is known before the view');
    assert.equal(chipOf(page(up({}, { stale: true }), { signups: sState(view()) })), 'rose:Needs recalculation');
    assert.equal(count(page(up(), { signups: sState(view()) }), /class="gs-hd-chip /g), 1);
    assert.equal(chipOf(page(up({ can: { edit: false } }), { signups: sState(view()) }, MEMBER_CAN)), 'green:Sign-ups open', 'a member sees it too');
  });

  await check('head chip, after the raid: Complete (green) when the bar says so, else the state word - N to review and Needs recalculation rose; Awaiting log, No log - by hand, Reviewed grey', () => {
    const done = past({ sources: { event: null, reports: [{ code: 'WaghkY9zwDyvLX7m', flavour: 'fresh', startedAt: 1, pulls: 9 }], plan: null } });
    const out = page(done, { loot: lState([{ id: 1 }]) });
    assert(out.includes('This raid is complete'), 'the bar says complete');
    assert.equal(chipOf(out), 'green:Complete');
    const review = past({ raid: Object.assign(past().raid, { state: 'to_review', openFlags: 3 }), people: [prow('p_a', 'Alliesha', { needsReview: true, outcome: 'late' })] });
    assert.equal(chipOf(page(review, { loot: lState([]) })), 'rose:3 to review');
    assert.equal(chipOf(page(past({ raid: Object.assign(past().raid, { stale: true, state: 'stale' }) }), { loot: lState([]) })), 'rose:Needs recalculation');
    const awaiting = past({ raid: Object.assign(past().raid, { state: 'awaiting_log' }), people: [], sources: { event: null, reports: [], plan: null } });
    assert.equal(chipOf(page(awaiting, {})), 'grey:Awaiting log');
    const manual = past({ raid: Object.assign(past().raid, { state: 'manual', manual: { reason: 'x', by: 'Officer', at: 1 } }), sources: { event: null, reports: [], plan: null } });
    assert.equal(chipOf(page(manual, { loot: lState([]) })), 'grey:No log - by hand');
    assert.equal(chipOf(page(Object.assign({}, manual, { raid: Object.assign({}, manual.raid, { openFlags: 2 }) }), { loot: lState([]) })), 'rose:2 to review');
    assert.equal(chipOf(page(past(), { loot: lState([]) })), 'grey:Reviewed', 'reviewed but the loot is not recorded yet');
  });

  await check('head title and context line: "<Fri Oct 23> - <title, else zone, else size>"; before = [team, ] time with its zone (or Time not set), where, sign-ups close; after = bosses, attended / missed, items', () => {
    const t = page(up(), { signups: sState(view()) });
    assert(t.includes('>Sat Oct 24 - Karazhan</h1>') && page(up({}, { title: 'Prog night' }), {}).includes('>Sat Oct 24 - Prog night</h1>') && page(up({}, { zone: null }), {}).includes('>Sat Oct 24 - 10-player</h1>'));
    const line = stripTags(t.slice(t.indexOf('gs-pagehead-context') + 'gs-pagehead-context">'.length, t.indexOf('</p>', t.indexOf('gs-pagehead-context'))));
    assert(/^7:00 PM CT Karazhan, 10-player sign-ups close Sat Oct 24, 1:00 PM CT$/.test(line), line);
    assert(stripTags(page(up({}, { timeKnown: false }), {})).includes('Time not set'));
    const two = G.pages.raid.raidHtml({ guildData: gd(OFFICER_CAN, [{ id: 't1', name: 'Team KJ' }, { id: 't2', name: 'Team B' }]), data: up(), signups: sState(view()) });
    assert(/gs-pagehead-context"><span>Team KJ<\/span>/.test(two), 'the team first when the guild has several');
    const closed = page(up(), { signups: sState(view({ raid: Object.assign({}, view().raid, { closed: 'locked' }) })) });
    assert(stripTags(closed).includes('sign-ups closed') && !stripTags(closed).includes('sign-ups close Sat'));
    const after = page(past(), { loot: lState([{ id: 1, match: {} }, { id: 2, match: {} }, { id: 3, match: {} }]) });
    const aLine = stripTags(after.slice(after.indexOf('gs-pagehead-context') + 'gs-pagehead-context">'.length, after.indexOf('</p>', after.indexOf('gs-pagehead-context'))));
    assert(/^1 kill, 1 wipe 1 attended, 0 missed 3 items$/.test(aLine), aLine);
    assert(!page(past(), {}).includes(' items'), 'no loot read yet: no item count');
  });

  // ═══ 2. More ═══
  await check('More: page-level items only - before: Open in Planner, Raid settings, Guest sign-up link, rule, Delete raid; after: Open in Planner, Recalculate attendance, Mark as No log, Paste raid roster, Raid settings, rule, Delete raid; none for a member', () => {
    const before = page(up(), { signups: sState(view()), roster: rState() });
    assert.deepEqual(labelsOf(before, 'raid-actions'), ['Open in Planner', 'Raid settings', 'Guest sign-up link', 'Delete raid']);
    assert(!before.includes('data-op="duties"') || !labelsOf(before, 'raid-actions').includes('Set raid duties'));
    const planned = up({ sources: { event: null, reports: [], plan: PLAN } });
    assert(!labelsOf(page(planned, { signups: sState(view()), roster: rState() }), 'raid-actions').includes('Publish line-up'), 'Publish line-up left More');
    const noLog = past({ sources: { event: null, reports: [], plan: null }, people: [] });
    assert.deepEqual(labelsOf(page(noLog, {}), 'raid-actions'), ['Open in Planner', 'Recalculate attendance', 'Mark as No log', 'Paste raid roster', 'Raid settings', 'Delete raid']);
    assert.deepEqual(labelsOf(page(past(), {}), 'raid-actions'), ['Open in Planner', 'Recalculate attendance', 'Raid settings', 'Delete raid'], 'with a log: no Mark as No log, no pasted roster');
    const manual = past({ raid: Object.assign(past().raid, { state: 'manual', manual: { reason: 'x', by: 'o', at: 1 } }), sources: { event: null, reports: [], plan: null } });
    assert.deepEqual(labelsOf(page(manual, {}), 'raid-actions'), ['Open in Planner', 'Recalculate attendance', 'Paste raid roster (replaces who is present)', 'Raid settings', 'Delete raid']);
    const out = page(before.includes('raid-actions') ? up() : up(), {});
    assert(/is-danger"[^>]*data-op="raid-delete"/.test(out) && out.indexOf('gs-menu-sep') < out.indexOf('data-op="raid-delete"'));
    const member = page(up({ can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } }), { signups: sState(view()) }, MEMBER_CAN);
    assert(!member.includes('id="raid-actions"') && !member.includes('data-op="settings"'));
    assert.equal(G.pages.raid.moreItemsOf(up({ can: { edit: false } }), {}).length, 0);
  });

  await check('Raid settings: More opens a Forge form dialog with the same fields; Save sends the same PATCH (only what changed), closes the dialog and keeps the messages', async () => {
    const S = G.app.state;
    S.guilds = { g1: gd(OFFICER_CAN) }; S.currentGid = 'g1';
    const att = G.pages.attendance.attState();
    att.raid = { gid: 'g1', rid: 'u1', data: up(), filter: null };
    const opened = [];
    const realOpen = G.ui.openDialog; G.ui.openDialog = (html, o) => { opened.push({ html, o }); return null; };
    G.handlers.click['raid-op']({ getAttribute: k => ({ 'data-op': 'settings' }[k] || null) });
    G.ui.openDialog = realOpen;
    assert.equal(opened.length, 1);
    const html = opened[0].html;
    assert(html.includes('class="gs-dialog-form gs-forge') && html.includes('<h2 class="gs-dialog-title" id="dlg-title">Raid settings</h2>') && html.includes('data-submit="raid-settings-form"'));
    assert(html.includes('id="rs-size"') && html.includes('id="rs-hours-mode"'), 'size and, while upcoming, the deadline');
    assert(html.includes('data-action="dialog-cancel">Cancel</button>') && html.includes('gs-btn-molten') && html.includes('>Save settings</button>'));
    // The PATCH.
    const calls = [];
    const realPatch = G.api.patch; G.api.patch = (url, body) => { calls.push([url, body]); return Promise.resolve(up({}, { sizeOverride: 20, size: 20 })); };
    let closed = 0;
    const realClose = G.ui.closeDialogOf; G.ui.closeDialogOf = () => { closed++; };
    const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
    const realRender = G.app.render; G.app.render = () => {};
    const form = { elements: { size: { value: '20', focus() {} }, hoursMode: { value: '', focus() {} }, hours: { value: '', focus() {} } } };
    G.handlers.submit['raid-settings-form'](form);
    await settle();
    G.api.patch = realPatch; G.ui.closeDialogOf = realClose; G.ui.setBusy = realBusy; G.app.render = realRender;
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/api/guild/g1/raids/u1', { size: 20 }]], 'only the changed key');
    assert.equal(closed, 1, 'the dialog closes');
    assert.equal(G.pages.attendance.attState().note, 'Raid settings saved.');
  });

  // ═══ 3. The Raid facts panel ═══
  const facts = out => out.slice(out.indexOf('id="raid-facts"'), out.indexOf('</section>', out.indexOf('id="raid-facts"')));
  const factRow = (out, label) => facts(out).split('<div class="gs-rpg-fact"').slice(1).filter(r => r.includes('<dt>' + label + '</dt>'))[0] || '';

  await check('Raid facts, before the raid (officer): Sign-ups from = This page / the Raid-Helper event with its count and sync, Plan, Line-up, Duties - each with a Change menu or button', () => {
    const none = page(up(), { signups: sState(view()), roster: rState() });
    assert.deepEqual([...facts(none).matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]), ['Sign-ups from', 'Plan', 'Line-up', 'Duties']);
    assert(stripTags(factRow(none, 'Sign-ups from')).includes('Sign-ups from This page'));
    assert.deepEqual(labelsOf(none, 'fact-event'), ['Link an event']);
    assert(stripTags(factRow(none, 'Plan')).includes('Not planned') && stripTags(factRow(none, 'Duties')).includes('Not set'));
    assert.deepEqual(labelsOf(none, 'fact-plan'), ['Open in Planner', 'Link a plan']);
    assert(factRow(none, 'Line-up').includes('Not published') && factRow(none, 'Line-up').includes('is-disabled') && factRow(none, 'Line-up').includes('Needs a plan first'), 'Publish line-up is not offered without a plan');
    assert(factRow(none, 'Duties').includes('data-action="raid-extra" data-op="duties"') && factRow(none, 'Duties').includes('>Change<'));
    const ev = up({ sources: { event: { id: 'e1', title: 'KJ BT', signups: 15, syncedAt: Date.now(), otherServer: true }, reports: [], plan: { label: 'Gruul night', players: 19, unmatched: ['Zed'] } },
      duties: [{ duty: 'leader', label: 'Raid leader', personId: 'p1', name: 'Aldric', class: 'WARRIOR' }, { duty: 'loot', label: 'Loot master', personId: 'p2', name: 'Brenna', class: 'PRIEST' }] });
    const linked = page(ev, { signups: sState(view()), roster: rState({ published: true, counts: { confirmed: 3, pending: 1, declined: 1 }, entries: [] }) });
    const evRow = stripTags(factRow(linked, 'Sign-ups from'));
    assert(evRow.includes('Raid-Helper, KJ BT (15, synced today)') && evRow.includes('The event is from another server.'), evRow);
    assert.deepEqual(labelsOf(linked, 'fact-event'), ['Refresh sign-ups', 'Replace event', 'Remove event']);
    assert(stripTags(factRow(linked, 'Plan')).includes('Gruul night, 19 players') && stripTags(factRow(linked, 'Plan')).includes('1 planned name is not on the roster.'));
    assert.deepEqual(labelsOf(linked, 'fact-plan'), ['Open in Planner', 'Replace plan', 'Remove plan']);
    assert(stripTags(factRow(linked, 'Line-up')).includes('Published, 3 of 5 confirmed'));
    assert.deepEqual(labelsOf(linked, 'fact-lineup'), ['Re-publish line-up', 'Unpublish']);
    assert(stripTags(factRow(linked, 'Duties')).includes('Raid leader Aldric, Loot master Brenna') && factRow(linked, 'Duties').includes('gs-class-warrior'), 'duties with the names in class colours');
    const planned = page(up({ sources: { event: null, reports: [], plan: PLAN } }), { signups: sState(view()), roster: rState() });
    assert.deepEqual(labelsOf(planned, 'fact-lineup'), ['Publish line-up'], 'with a plan: Publish line-up');
    assert(!page(up(), {}).includes('id="fact-lineup"'), 'the line-up not read yet: no menu');
    assert(factRow(page(up(), {}), 'Line-up').includes('Checking...'));
  });

  await check('Raid facts, after the raid (officer): Sign-ups, Plan (Skipped), Line-up (no Change), Log with its menu, Duties', () => {
    const out = page(past({ sources: { event: { id: 'e1', title: 'KJ BT', signups: 12, syncedAt: 1, otherServer: false }, reports: [{ code: 'WaghkY9zwDyvLX7m', flavour: 'fresh', startedAt: 1, pulls: 9 }, { code: 'h8VAwCFa79Jk1cvf', flavour: 'fresh', startedAt: 2, pulls: 3 }], plan: null } }), { loot: lState([]), roster: rState() });
    assert.deepEqual([...facts(out).matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]), ['Sign-ups', 'Plan', 'Line-up', 'Log', 'Duties']);
    assert(stripTags(factRow(out, 'Sign-ups')).includes('12 signed') && stripTags(factRow(out, 'Plan')).includes('Skipped') && stripTags(factRow(out, 'Line-up')).includes('Not published'));
    assert(!factRow(out, 'Line-up').includes('menu-toggle'), 'no Change on the line-up after the raid');
    assert(stripTags(factRow(out, 'Log')).includes('Warcraft Logs - 2 reports, 12 pulls'));
    assert.deepEqual(labelsOf(out, 'fact-log'), ['Refresh WaghkY9zwDyvLX7m', 'Remove WaghkY9zwDyvLX7m', 'Refresh h8VAwCFa79Jk1cvf', 'Remove h8VAwCFa79Jk1cvf', 'Add report']);
    assert.deepEqual(labelsOf(out, 'fact-event'), ['Refresh sign-ups', 'Replace event', 'Remove event']);
    assert.deepEqual(labelsOf(out, 'fact-plan'), ['Open in Planner', 'Link a plan']);
    const none = page(past({ sources: { event: null, reports: [], plan: null }, people: [] }), {});
    assert(stripTags(factRow(none, 'Log')).includes('None'));
    assert.deepEqual(labelsOf(none, 'fact-log'), ['Add report', 'Mark attendance by hand']);
    const manual = page(past({ raid: Object.assign(past().raid, { state: 'manual', manual: { reason: 'Nobody uploaded', by: 'Officer', at: 1760000000000 } }), sources: { event: null, reports: [], plan: null } }), {});
    assert(stripTags(factRow(manual, 'Log')).includes('Entered by hand by Officer on ') && stripTags(factRow(manual, 'Log')).includes('Reason: Nobody uploaded.'));
    assert.deepEqual(labelsOf(manual, 'fact-log'), ['Edit attendance by hand', 'Remove hand-entered attendance']);
    assert(!stripTags(factRow(page(past({ raid: Object.assign(past().raid, { state: 'manual', manual: { reason: null, by: null, at: 1 } }), sources: { event: null, reports: [], plan: null } }), {}, MEMBER_CAN), 'Log')).includes('Officer'), 'who entered it is for reviewers');
  });

  await check('Raid facts (member): the same rows to read, no Change buttons or menus anywhere in the panel', () => {
    const memberData = up({ can: { edit: false, review: false, seeAttendance: false, seeNicknames: false }, sources: { event: { id: 'e1', title: 'KJ BT', signups: 15, syncedAt: Date.now(), otherServer: false }, reports: [], plan: PLAN } });
    const out = page(memberData, { signups: sState(view()), roster: rState({ published: true, counts: { confirmed: 1, pending: 0, declined: 0 }, entries: [] }) }, MEMBER_CAN);
    const f = facts(out);
    assert(f.includes('Raid-Helper, KJ BT') && f.includes('Gruul night, 10 players') && f.includes('Published, 1 of 1 confirmed') && f.includes('Not set'));
    assert(!f.includes('>Change<') && !f.includes('menu-toggle') && !f.includes('data-op='));
    const after = page(past({ can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), {}, MEMBER_CAN);
    assert(facts(after).includes('Warcraft Logs - 1 report, 9 pulls') && !facts(after).includes('>Change<'));
  });

  await check('layout: no stage strip; the Forge page; the next-step bar and the You bar come before the two columns (main, then side with the facts); the facts carry the phone order hook; the stale banner is a notice above the columns', () => {
    const out = page(past({ raid: Object.assign(past().raid, { stale: true, state: 'stale' }) }), { loot: lState([]), signups: sState(view({ raid: Object.assign({}, view().raid, { upcoming: false, closed: 'started' }) })) });
    assert(!out.includes('gs-stage') && !out.includes('gs-stages'), 'no stage strip');
    assert(/class="gs-page gs-object-page gs-raid-page gs-forge gs-rpg is-after"/.test(out));
    assert(out.indexOf('data-op="recompute"') < out.indexOf('class="gs-rpg-cols"'), 'the stale banner (with its Recalculate button) sits above the columns');
    const o = page(up({ sources: { event: null, reports: [], plan: PLAN } }), { signups: sState(view({ me: ME({ signup: SIGNED }) })), roster: rState() });
    const at = s => o.indexOf(s);
    assert(at('class="gs-pagehead"') < at('class="gs-nextstep') && at('class="gs-nextstep') < at('id="su-me"') && at('id="su-me"') < at('class="gs-rpg-cols"') && at('class="gs-rpg-main"') < at('class="gs-rpg-side"'));
    assert(o.includes('class="gs-hd-panel gs-rpg-facts gs-rpg-sp gs-rpg-sp-facts"'));
    const a = page(past(), { loot: lState([]) });
    assert(a.includes('class="gs-rpg-sp gs-rpg-sp-loot"') && a.indexOf('id="raid-facts"') < a.indexOf('id="s-loot"'), 'after the raid: facts, then the Loot awards card in the side column');
    const css = read('guild.css');
    assert(/@media \(min-width: 1024px\) \{\s*\.gs-rpg-cols \{ display: grid; grid-template-columns: minmax\(0, 2fr\) minmax\(0, 1fr\)/.test(css), 'two columns from 1024 px');
    assert(/\.gs-rpg-sp-loot \{ order: 1; \}[\s\S]*\.gs-rpg-sp-facts \{ order: 3; \}/.test(css), 'the phone order hooks');
  });

  // ═══ 4. The You bar ═══
  const bar = (v, rosterData, opts) => {
    const o = Object.assign({ data: up(), nextHasPrimary: false, guildData: gd(MEMBER_CAN), parts: { signups: v ? sState(v) : null, roster: rosterData ? rState(rosterData) : null } }, opts || {});
    return G.pages.raidYou.youBarHtml(o);
  };
  const line = html => stripTags(html);

  await check('You bar, not signed up: "You have not signed up yet." with the five pills (the first reads Signed up, molten when nothing else is) and Change character or note', () => {
    const out = bar(view());
    assert(out.includes('class="gs-hd-panel gs-rpg-you" id="su-me"') && out.includes('<span class="gs-fg-lbl" id="rpg-you-l">You</span>'));
    assert(line(out).startsWith('You You have not signed up yet.'), line(out));
    assert.deepEqual([...out.matchAll(/data-action="su-kind" data-kind="(\w+)"[^>]*>([^<]+)</g)].map(m => m[1] + ':' + m[2].replace(/&#39;/g, "'")), ['signed:Signed up', 'late:Late', 'standby:Standby', 'tentative:Tentative', 'absence:Can\'t come']);
    assert(/class="gs-btn gs-su-kind gs-btn-molten" data-action="su-kind" data-kind="signed"/.test(out) && molten(out) === 1, 'the one molten');
    assert(out.includes('data-action="su-details-open"') && out.includes('>Change character or note<'));
    assert(!/aria-pressed="true"/.test(out) && !/su-kind[^>]*disabled/.test(out));
    const secondary = bar(view(), null, { nextHasPrimary: true });
    assert.equal(molten(secondary), 0, 'a secondary pill while the next-step bar has the primary');
    const officer = bar(view({ can: { edit: true, self: true, seeList: true, seeNicknames: true } }), null, { guildData: gd(OFFICER_CAN), nextHasPrimary: true });
    assert(officer.includes('data-kind="signed"') && molten(officer) === 0, 'an officer who raids too gets the same bar');
  });

  await check('You bar, signed up: "Signed up - Alliesha, Balance" (the character in its class colour), the current pill pressed; Late, Standby, Can\'t come and an Away notice read as themselves', () => {
    const out = bar(view({ me: ME({ signup: SIGNED }) }));
    assert(line(out).startsWith('You Signed up - Alliesha, Balance'), line(out));
    assert(out.includes('<span class="gs-char-name gs-class-druid">Alliesha</span>'));
    assert(/data-kind="signed"[^>]*aria-pressed="true"/.test(out) && molten(out) === 0);
    assert(line(bar(view({ me: ME({ signup: Object.assign({}, SIGNED, { kind: 'late' }) }) }))).startsWith('You Late - Alliesha, Balance'));
    assert(line(bar(view({ me: ME({ signup: Object.assign({}, SIGNED, { kind: 'standby', spec: null }) }) }))).startsWith('You Standby - Alliesha'));
    assert(line(bar(view({ me: ME({ signup: Object.assign({}, SIGNED, { kind: 'absence', spec: null }) }) }))).startsWith('You Can\'t come - Alliesha'));
    const away = bar(view({ me: ME({ signup: { kind: 'absence', source: 'away', name: null } }) }));
    assert(line(away).startsWith('You Away (notice)') && !/aria-pressed="true"/.test(away));
    assert(line(bar(view({ me: ME({ signup: { kind: 'signed', name: null, source: 'raid_helper' } }) }))).startsWith('You Signed up'));
  });

  await check('You bar, closed sign-ups: the pills are disabled, the reason sits next to them, no Change character or note', () => {
    const closedView = view({ raid: Object.assign({}, view().raid, { closed: 'locked' }), me: ME({ canChange: false }) });
    const out = bar(closedView);
    assert(line(out).includes('You have not signed up, and sign-ups are closed.') && line(out).includes('An officer has closed sign-ups. Ask an officer if you need to change yours.'));
    assert.equal(count(out, /data-action="su-kind"[^>]*disabled/g), 5);
    assert(!out.includes('su-details-open') && molten(out) === 0);
    const signedClosed = bar(view({ me: ME({ canChange: false, signup: SIGNED }) }));
    assert(line(signedClosed).includes('Signed up - Alliesha, Balance') && !signedClosed.includes('su-details-open'));
  });

  await check('You bar, seated in the published line-up: Group N - spec class (character) or Bench; waiting asks Are you coming? with Confirm + Can\'t come, confirmed shows the grey chip + Can\'t come, declined the chip + Confirm after all; the pills are in the Change sign-up dialog', () => {
    const seat = (over) => ({ published: true, mine: Object.assign({ group: 2, name: 'Alliesha', class: 'DRUID', spec: 'Balance', status: 'pending' }, over || {}) });
    const v = view({ me: ME({ signup: SIGNED }) });
    const waiting = bar(v, seat());
    assert(line(waiting).startsWith('You Group 2 - Balance Druid (Alliesha) Are you coming? Confirm Can\'t come Change sign-up'), line(waiting));
    assert(!waiting.includes('data-action="su-kind"') && waiting.includes('data-action="su-signup-open"'));
    assert(/class="gs-btn gs-btn-molten" data-action="seat-confirm"/.test(waiting) && molten(waiting) === 1);
    const withPrimary = bar(v, seat(), { nextHasPrimary: true });
    assert(/class="gs-btn" data-action="seat-confirm"/.test(withPrimary) && molten(withPrimary) === 0, 'an officer who raids too, with a next-step primary: a secondary Confirm');
    const confirmed = bar(v, seat({ status: 'confirmed' }));
    assert(confirmed.includes('<span class="gs-hd-chip is-grey">Confirmed</span>') && !confirmed.includes('seat-confirm') && confirmed.includes('data-action="seat-decline"') && !confirmed.includes('Are you coming?'));
    const declined = bar(v, seat({ status: 'declined' }));
    assert(declined.includes('<span class="gs-hd-chip is-rose">Can&#39;t come</span>') && declined.includes('>Confirm after all<') && !declined.includes('seat-decline'));
    assert(line(bar(v, seat({ group: 0 }))).startsWith('You Bench - Balance Druid (Alliesha)'));
    const dlg = G.pages.raidSignups.detailsDialogHtml(v.me ? v : v, G.pages.raidSignups.freshUi(v), true);
    assert(dlg.includes('<h2 class="gs-dialog-title" id="dlg-title">Change sign-up</h2>') && count(dlg, /data-action="su-kind"/g) === 5 && dlg.includes('class="gs-dialog-form gs-forge"'));
    const plain = G.pages.raidSignups.detailsDialogHtml(v, G.pages.raidSignups.freshUi(v), false);
    assert(plain.includes('Change character or note</h2>') && !plain.includes('su-kind') && plain.includes('id="su-spec"') && plain.includes('id="su-note"') && plain.includes('>Save details<') && plain.includes('>Remove my sign-up<'));
    assert(G.pages.raidSignups.detailsDialogHtml(view({ me: ME({ signup: Object.assign({}, SIGNED, { standing: true }) }) }), G.pages.raidSignups.freshUi(view()), false).includes('>Skip this week<'));
    assert(G.pages.raidSignups.detailsDialogHtml(view(), G.pages.raidSignups.freshUi(view()), false).includes('>Done<'), 'without a sign-up the details wait for the first pill');
  });

  await check('You bar, after the raid: "<Outcome> - 8 of 9 pulls - won <item> (MS)" from the loaded people and loot, no buttons; nothing for someone with no row', () => {
    const v = view({ raid: Object.assign({}, view().raid, { upcoming: false, closed: 'started' }) });
    const data = past();
    const base = G.pages.raidYou.youBarHtml({ guildData: gd(MEMBER_CAN), data, parts: { signups: sState(v), loot: null }, nextHasPrimary: false });
    assert(line(base) === 'You Attended - 8 of 9 pulls', line(base));
    assert(!base.includes('<button') && !base.includes('<a '), 'no buttons');
    const awards = [{ id: 'a1', itemId: 30311, itemName: 'Warp Slicer', quality: 4, tag: 'MS', winner: { name: 'Alliesha', class: 'DRUID' }, match: { kind: 'character', personId: 'p_a', characterName: 'Alliesha' } },
      { id: 'a2', itemId: 30312, itemName: 'Infinity Blade', quality: 4, tag: 'OS', winner: { name: 'Brewmaw', class: 'DRUID' }, match: { kind: 'character', personId: 'p_b' } }];
    const won = G.pages.raidYou.youBarHtml({ guildData: gd(MEMBER_CAN), data, parts: { signups: sState(v), loot: lState(awards) }, nextHasPrimary: false });
    assert(/^You Attended - 8 of 9 pulls - won Warp Slicer \(MS\)$/.test(line(won)), line(won));
    assert(!line(won).includes('Infinity Blade'));
    const bench = G.pages.raidYou.youBarHtml({ guildData: gd(MEMBER_CAN), data, parts: { signups: sState(view({ raid: v.raid, me: ME({ personId: 'p_b' }) })), loot: lState(awards) }, nextHasPrimary: false });
    assert(/^You Bench - 0 of 9 pulls - won Infinity Blade \(OS\)$/.test(line(bench)), line(bench));
    assert.equal(G.pages.raidYou.youBarHtml({ guildData: gd(MEMBER_CAN), data, parts: { signups: sState(view({ raid: v.raid, me: ME({ personId: 'p_zz' }) })) }, nextHasPrimary: false }), '', 'no row for the viewer: no bar');
    const full = page(data, { signups: sState(v), loot: lState(awards) }, MEMBER_CAN);
    assert(full.includes('id="su-me"') && full.indexOf('id="su-me"') < full.indexOf('class="gs-rpg-cols"'));
  });

  await check('one molten per screen on the whole page, for every state of an officer who raids too and of a member', () => {
    const planned = up({ sources: { event: null, reports: [], plan: PLAN } });
    const seatPub = rState({ published: true, counts: { confirmed: 0, pending: 1, declined: 0 }, entries: [], mine: { group: 1, name: 'Alliesha', class: 'DRUID', spec: 'Balance', status: 'pending' } });
    const cases = [
      [up(), { signups: sState(view({ can: { edit: true, self: true, seeList: true, seeNicknames: true } })) }, OFFICER_CAN],
      [planned, { signups: sState(view({ can: { edit: true, self: true, seeList: true, seeNicknames: true } })), roster: rState() }, OFFICER_CAN],
      [planned, { signups: sState(view({ can: { edit: true, self: true, seeList: true, seeNicknames: true }, me: ME({ signup: SIGNED }) })), roster: seatPub }, OFFICER_CAN],
      [up({ can: { edit: false } }), { signups: sState(view()) }, MEMBER_CAN],
      [up({ can: { edit: false } }), { signups: sState(view({ me: ME({ signup: SIGNED }) })), roster: seatPub }, MEMBER_CAN],
      [past(), { loot: lState([]), signups: sState(view({ raid: Object.assign({}, view().raid, { upcoming: false }) })) }, OFFICER_CAN],
    ];
    cases.forEach(([data, parts, can], i) => assert(molten(page(data, parts, can)) <= 1, 'case ' + i + ': ' + molten(page(data, parts, can))));
  });

  console.log(`\nRaid page shell UI tests: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
