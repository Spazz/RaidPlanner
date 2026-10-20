/**
 * Raidsmith guild UI - design framework Wave 1 (items 1 and 2): the raid page on the T2 object template (stage strip derived from the raid's data, the next-step
 * bar with the one primary, the "You" line, post-raid mode, the Publish question) and Guild settings on the T3 template (five groups, old addresses, the General
 * page, the Save bar on form pages, Attendance in sections).
 * Run: node tests/guild/guild-fw1a-ui-tests.js
 *
 * Same approach as guild-framework-ui-tests.js: the guild scripts load in a vm with no DOM, the pages return HTML strings, and the few behaviours (the General
 * submit, the draft Save bar) run against a few lines of fake DOM. The pages against the real Worker are checked in a browser by tools/guild-smoke.js.
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
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = require('path').join(__dirname, '..', '..');
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
const ui = G.ui;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const count = (s, re) => (s.match(re) || []).length;
const settle = () => new Promise(r => setTimeout(r, 5));

// ── fixtures ─────────────────────────────────────────────────────
const T1 = { id: 't1', name: 'Team KJ' };
const OFFICER_CAN = {
  'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'attendance.policy': 'guild',
  'guild.teams': 'guild', 'roster.edit': 'guild', 'loot.edit': 'guild', 'loot.view': 'guild',
};
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'] };
function gd(can, roles, over) {
  return {
    guild: Object.assign({ id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'firemaw', createdAt: 1 }, over || {}),
    teams: [T1].map(t => ({ id: t.id, name: t.name, size: 25, archived: false, players: 3, leads: [] })),
    me: { roles: roles || [{ role: 'officer' }], can },
    attendanceFlags: {},
  };
}
const GM = [{ role: 'guild_master' }];
const EVERYTHING = Object.fromEntries(['guild.teams', 'guild.access', 'guild.roles', 'raids.edit', 'attendance.policy', 'loot.policy', 'audit.view', 'roster.view'].map(a => [a, 'guild']));
const STARTS = Date.UTC(2026, 9, 25, 0, 0);
function up(over) {
  return Object.assign({
    raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: STARTS, upcoming: true, title: null, zone: 'Hyjal Summit', size: 25, state: 'upcoming', openFlags: 0, stale: false, version: 1 },
    can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
    sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [],
  }, over || {});
}
function prow(id, name, extra) {
  return Object.assign({ playerId: id, name, class: 'DRUID', signup: 'signed', plan: null, pulls: { present: 4, total: 4, missedFirst: false, missedLast: false }, outcome: 'present', credit: 1, pending: false, needsReview: false, flags: [], decision: null }, extra || {});
}
function past(over) {
  return Object.assign({
    raid: { id: 'r4', team: 't1', raidOn: '2026-10-17', startsAt: 1, upcoming: false, zone: 'Black Temple', size: 25, state: 'reviewed', openFlags: 0, stale: false, version: 1 },
    can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
    sources: { event: null, reports: [{ code: 'WaghkY9zwDyvLX7m', flavour: 'fresh', startedAt: 1, pulls: 4 }], plan: null },
    pulls: [{ encounter: 'Illidan', kill: true, startedAt: 1 }],
    people: [prow('p_a', 'Alliesha'), prow('p_b', 'Brewmaw', { outcome: 'bench', signup: 'tentative' })], unmatched: [], signups: [],
  }, over || {});
}
const view = (over) => Object.assign({
  raid: { id: 'u1', teamId: 't1', startsAt: STARTS, upcoming: true, locked: false, closed: null },
  can: { edit: true, self: false, seeList: true, seeNicknames: true }, me: null, roster: [],
  counts: { signed: 3, late: 0, tentative: 0, bench: 1, absence: 0, expected: 3, byRole: { tank: 0, healer: 0, melee: 3, ranged: 0, none: 0 }, byClass: { DRUID: 3 } },
  entries: [{ key: 'p:p_a', personId: 'p_a', source: 'raidsmith', kind: 'signed', name: 'Alliesha', classId: 'DRUID', className: 'Druid', spec: 'Feral', role: 'melee', characterId: null, note: null, updatedAt: null, matched: true, isMe: false, nickname: null }],
}, over || {});
const sState = v => ({ gid: 'g1', rid: 'u1', status: 'ok', data: v, ui: G.pages.raidSignups.freshUi(v) });
const rState = (data) => ({ status: 'ok', data: Object.assign({ published: false }, data || {}) });
const lState = (awards, canEdit) => ({ gid: 'g1', rid: 'r4', status: 'ok', data: { awards: awards || [], canEdit: canEdit !== false }, ui: G.pages.raidLoot.freshUi() });
const page = (data, over, can, roles) => G.pages.raid.raidHtml(Object.assign({ guildData: gd(can || OFFICER_CAN, roles), data }, over || {}));
const molten = html => count(html, /class="[^"]*gs-btn-molten[^"]*"/g);

(async () => {
  // ═══ 1. Stage strip: derived from the raid's data ═══
  const stateOf = (model, key) => model.stages.filter(s => s.key === key)[0].state;
  const keysOf = model => model.stages.map(s => s.key + ':' + s.state).join(' ');

  await check('stages: a raid nobody signed up for waits for sign-ups; a raid with sign-ups and no plan is on Plan; Publish needs a plan; the line-up being read never flashes a Publish button', () => {
    const none = G.pages.raid.stagesOf(up(), {});
    assert.equal(none.current, 'signups');
    assert.equal(keysOf(none), 'signups:current plan:later publish:later log:later loot:later');
    const signed = G.pages.raid.stagesOf(up(), { signups: sState(view()) });
    assert.equal(signed.current, 'plan');
    assert.equal(keysOf(signed), 'signups:done plan:current publish:later log:later loot:later');
    assert.equal(signed.stages[0].line, '3 signed up, 1 bench');
    assert.equal(signed.stages[1].line, 'Not planned yet');
    const planned = up({ sources: { event: null, reports: [], plan: { label: 'Gruul night', players: 19 } } });
    const reading = G.pages.raid.stagesOf(planned, { signups: sState(view()) });
    assert.equal(reading.current, null, 'the line-up is not read yet: nothing is current, so no Publish button for a raid that may be published');
    assert.equal(stateOf(reading, 'publish'), 'later');
    const unpublished = G.pages.raid.stagesOf(planned, { signups: sState(view()), roster: rState() });
    assert.equal(unpublished.current, 'publish');
    assert.equal(unpublished.stages[1].line, '19 players');
    const published = G.pages.raid.stagesOf(planned, { signups: sState(view()), roster: rState({ published: true, counts: { confirmed: 17, pending: 2, declined: 0 } }) });
    assert.equal(published.current, null, 'everything before the raid is done');
    assert.equal(published.stages[2].line, '17 of 19 confirmed');
    assert.equal(keysOf(published), 'signups:done plan:done publish:done log:later loot:later');
    const eventOnly = G.pages.raid.stagesOf(up({ sources: { event: { id: 'e1', title: 'E', signups: 12, otherServer: false }, reports: [], plan: null } }), {});
    assert.equal(eventOnly.stages[0].state, 'done', 'Raid-Helper sign-ups count while the panel is still loading');
  });

  await check('stages: after the start Plan and Publish are skipped when nothing was done; Log is current until there is a log and its flags are decided; Loot follows', () => {
    const bare = G.pages.raid.stagesOf(past({ sources: { event: null, reports: [], plan: null }, people: [] }), {});
    assert.equal(keysOf(bare), 'signups:done plan:skipped publish:skipped log:current loot:later');
    assert.equal(bare.stages[3].line, 'No log yet');
    assert.equal(bare.stages[4].line, 'After the log');
    const flagged = G.pages.raid.stagesOf(past({ people: [prow('p_a', 'Alliesha', { needsReview: true, outcome: 'late' })] }), {});
    assert.equal(flagged.current, 'log');
    assert.equal(flagged.stages[3].line, '1 to review');
    const reviewed = G.pages.raid.stagesOf(past(), { loot: lState([]) });
    assert.equal(keysOf(reviewed), 'signups:done plan:skipped publish:skipped log:done loot:current');
    assert.equal(reviewed.stages[3].line, '1 report');
    const byHand = G.pages.raid.stagesOf(past({ raid: Object.assign({}, past().raid, { state: 'manual', manual: { reason: 'x', presentPlayerIds: [] } }), sources: { event: null, reports: [], plan: null } }), { loot: lState([]) });
    assert.equal(byHand.stages[3].line, 'Entered by hand');
    const done = G.pages.raid.stagesOf(past({ sources: { event: null, reports: [{ code: 'W1' }, { code: 'W2' }], plan: { label: 'P', players: 3 } } }), { loot: lState([{ id: 1 }, { id: 2 }]), roster: rState({ published: true, counts: { confirmed: 3, pending: 0, declined: 0 } }) });
    assert.equal(done.current, null);
    assert.equal(keysOf(done), 'signups:done plan:done publish:done log:done loot:done');
    assert.equal(done.stages[3].line, '2 reports');
    assert.equal(done.stages[4].line, '2 items');
  });

  await check('no stage strip (the bar and the Raid facts carry the stages); the old jump targets still land on the page, before and after the raid', () => {
    const me = { personId: 'p_a', signup: { kind: 'signed', name: 'Alliesha', spec: 'Feral', source: 'raidsmith' }, notice: null, canChange: true, characters: [], defaultCharacterId: null };
    const before = page(up(), { signups: sState(view({ me })), roster: rState() });
    const after = page(past(), { signups: sState(view({ me })), loot: lState([]) });
    for (const out of [before, after]) assert(!out.includes('gs-stage') && !out.includes('Raid stages'), 'no stage strip');
    for (const t of ['s-signups', 's-plan', 's-publish', 'su-me']) assert(before.includes(' id="' + t + '"'), t + ' is on the page before the raid');
    for (const t of ['s-loot', 's-plan', 's-publish', 'raid-people']) assert(after.includes(' id="' + t + '"'), t + ' is on the page after the raid');
    assert(after.includes('id="s-signups"'), 'the sign-ups record keeps its address after the raid');
  });

  // ═══ 2. The next-step bar: one primary per stage ═══
  const nextOf = (data, parts, can) => {
    const model = G.pages.raid.stagesOf(data, parts);
    return G.pages.raid.nextStepOf(gd(can || OFFICER_CAN), data, parts, model);
  };

  await check('next step: the officer\'s primary is Plan in Planner, Publish line-up, Add log, Review attendance or Import loot awards for the stage that is current; Collect sign-ups has none', () => {
    assert.equal(nextOf(up(), {}).primary, undefined);
    assert.equal(nextOf(up(), {}).title, 'Collect sign-ups');
    assert.equal(nextOf(up(), {}).secondary.label, 'Link an event');
    const plan = nextOf(up(), { signups: sState(view()) });
    assert.deepEqual([plan.title, plan.primary.label, plan.primary.attrs['data-op']], ['Plan this raid', 'Plan in Planner', 'plan-in-planner']);
    assert(plan.text.startsWith('3 signed up, 1 bench.'));
    const planned = up({ sources: { event: null, reports: [], plan: { label: 'P', players: 3 } } });
    const publish = nextOf(planned, { signups: sState(view()), roster: rState() });
    assert.deepEqual([publish.title, publish.primary.label, publish.primary.attrs['data-action'], publish.primary.attrs['data-op']], ['Publish the line-up', 'Publish line-up', 'roster-publish', 'publish']);
    const addLog = nextOf(past({ sources: { event: null, reports: [], plan: null }, people: [] }), {});
    assert.deepEqual([addLog.primary.label, addLog.primary.attrs['data-op'], addLog.secondary.label, addLog.secondary.attrs['data-op']], ['Add log', 'report-add', 'Mark attendance by hand', 'manual-open']);
    const review = nextOf(past({ people: [prow('p_a', 'Alliesha', { needsReview: true, outcome: 'late' }), prow('p_b', 'Brewmaw', { needsReview: true, outcome: 'late' })] }), {});
    assert.deepEqual([review.title, review.primary.label, review.primary.attrs['data-action'], review.secondary.label, review.secondary.href], ['Review attendance', 'Review attendance', 'raid-review', 'Open review queue', '#/g/g1/attendance/review']);
    assert(review.text.startsWith('2 players need a decision'));
    const loot = nextOf(past(), { loot: lState([]) });
    assert.deepEqual([loot.title, loot.primary.label, loot.primary.attrs['data-action'], loot.secondary.label, loot.secondary.attrs['data-action']], ['Record the loot', 'Import loot awards', 'loot-import-open', 'Add loot award', 'loot-add-open']);
    assert.equal(nextOf(past(), { loot: lState([{ id: 1 }]) }).title, 'This raid is complete');
    assert.equal(nextOf(up({ sources: { event: null, reports: [], plan: { label: 'P', players: 3 } } }), { signups: sState(view()), roster: rState({ published: true }) }).title, 'The line-up is out');
    assert.equal(nextOf(planned, { signups: sState(view()) }), null, 'the line-up is still being read: no bar rather than a wrong one');
  });

  await check('next step: someone who cannot take the step reads what the officers are waiting for and gets no button; Review needs attendance.review', () => {
    const member = { 'raids.view': 'guild', 'attendance.view': ['t1'] };
    const memberData = over => up(Object.assign({ can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } }, over || {}));
    const waitPlan = nextOf(memberData(), { signups: sState(view({ can: { edit: false, self: true, seeList: true, seeNicknames: false } })) }, member);
    assert.deepEqual([waitPlan.title, waitPlan.text, waitPlan.primary, waitPlan.secondary], ['Plan this raid', 'Waiting for an officer to plan this raid.', undefined, undefined]);
    const waitLog = nextOf(past({ can: { edit: false, review: false, seeAttendance: true, seeNicknames: false }, sources: { event: null, reports: [], plan: null }, people: [] }), {}, member);
    assert.equal(waitLog.text, 'Waiting for an officer to add the log.');
    const reviewOnly = nextOf(past({ can: { edit: false, review: true, seeAttendance: true, seeNicknames: false }, people: [prow('p_a', 'Alliesha', { needsReview: true, outcome: 'late' })] }), {}, member);
    assert.equal(reviewOnly.primary.label, 'Review attendance', 'a reviewer who cannot edit the raid may still review');
    const waitLoot = nextOf(past({ can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), { loot: lState([], false) }, member);
    assert.equal(waitLoot.text, 'Waiting for an officer to record the loot.');
    const out = page(memberData(), { signups: sState(view({ can: { edit: false, self: true, seeList: true, seeNicknames: false } })) }, member);
    assert(!out.includes('is-waiting') && molten(out) <= 1 && !out.includes('data-op="plan-in-planner"'));
  });

  await check('one primary per screen: an officer\'s raid page has at most one molten button in every stage, a member\'s at most one', () => {
    const planned = up({ sources: { event: null, reports: [], plan: { label: 'P', players: 3 } } });
    const cases = [
      [up(), {}], [up(), { signups: sState(view()) }], [planned, { signups: sState(view()), roster: rState() }], [planned, { signups: sState(view()), roster: rState({ published: true }) }],
      [past({ sources: { event: null, reports: [], plan: null }, people: [] }), {}], [past({ people: [prow('p_a', 'Alliesha', { needsReview: true, outcome: 'late' })] }), { loot: lState([]) }],
      [past(), { loot: lState([]) }], [past(), { loot: lState([{ id: 1 }]) }],
    ];
    cases.forEach(([data, parts], i) => assert(molten(page(data, parts)) <= 1, 'officer case ' + i + ': ' + molten(page(data, parts))));
    const mine = view({ can: { edit: false, self: true, seeList: true, seeNicknames: false }, me: { personId: 'p_a', signup: null, notice: null, canChange: true, characters: [{ id: 'c1', name: 'Alliesha', class: 'DRUID', specs: ['Feral'], mainSpec: 'Feral' }], defaultCharacterId: 'c1' } });
    const memberUp = page(up({ can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } }), { signups: sState(mine) }, MEMBER_CAN);
    assert.equal(molten(memberUp), 1, 'a member without a sign-up has the Sign up button as the one primary');
    const officerNotSignedUp = page(up(), { signups: sState(Object.assign({}, mine, { can: { edit: true, self: true, seeList: true, seeNicknames: true } })) });
    assert.equal(molten(officerNotSignedUp), 1, 'an officer: the next-step bar has the primary and the sign-up buttons are plain');
  });

  // ═══ 3. The You line ═══
  const youOf = (data, parts) => stripTags(G.pages.raid.youHtml(data, parts)).replace(/\s+/g, ' ').trim();
  const meOf = (over) => ({ personId: 'p_a', signup: null, notice: null, canChange: true, characters: [], defaultCharacterId: null }, Object.assign({ personId: 'p_a', signup: null, notice: null, canChange: true, characters: [], defaultCharacterId: null }, over || {}));



  // ═══ 4. Sections and post-raid mode ═══
  const idsOf = out => [...out.matchAll(/<(?:section|div) class="gs-osection(?:-bare| is-locked)?"[^>]* id="([a-z-]+)"/g)].map(m => m[1]);

  await check('columns before the raid: main = Sign-ups panel, then Loot prios; side = the Raid facts panel; no locked After the raid card and no Raid settings card; the next-step bar comes first', () => {
    const out = page(up(), { signups: sState(view()), roster: rState() });
    assert.deepEqual(idsOf(out), ['raid-cols', 's-signups']);
    assert(!out.includes('Opens when the raid starts') && !out.includes('id="s-settings"') && !out.includes('id="rs-h"'), 'the locked card and the settings card are gone');
    assert(out.includes('class="gs-rpg-cols"') && out.indexOf('class="gs-rpg-main"') < out.indexOf('class="gs-rpg-side"'), 'two columns, main first');
    assert(out.indexOf('id="s-signups"') < out.indexOf('id="su-h"') && out.indexOf('id="su-h"') < out.indexOf('id="raid-facts"'), 'the Sign-ups panel is in the main column, the facts in the side one');
    assert(out.includes('gs-forge') && out.indexOf('class="gs-nextstep') < out.indexOf('class="gs-rpg-cols"'), 'the Forge page; the next-step bar comes before the columns');
    assert(!out.includes('id="su-me" tabindex="-1" role="group"') && !out.includes('Your sign-up</h3>'), 'the old Your sign-up form is gone from the Sign-ups panel');
    const noPanel = page(up(), { roster: rState() });
    assert(!noPanel.includes('id="s-board"'), 'no Loot prios section while nothing is pasted or loaded');
  });

  await check('Raid facts (officer): Plan shows the plan and its unmatched names with a Plan settings menu; Line-up says Not published with Publish line-up disabled and its reason while there is no plan', () => {
    const planned = up({ sources: { event: null, reports: [], plan: { label: 'Gruul night', players: 19, unmatched: ['Zed'] } } });
    const out = page(planned, { signups: sState(view()), roster: rState() });
    assert(out.includes('<dt>Plan</dt><dd><span class="gs-rpg-v">Gruul night, 19 players</span>'), 'the plan and its size');
    assert(out.includes('aria-label="Plan settings"') && out.includes('data-op="plan-in-planner"') && out.includes('data-op="plan-replace"') && out.includes('>Replace plan<') && out.includes('data-op="plan-remove"'));
    assert(out.includes('1 planned name is not on the roster.'));
    const row = out.slice(out.indexOf('id="s-publish"'), out.indexOf('id="s-publish"') + 2000);
    assert(row.includes('Not published') && row.includes('data-op="publish"') && !row.includes('is-disabled'), row);
    const none = page(up(), { signups: sState(view()), roster: rState() });
    const noneRow = none.slice(none.indexOf('id="s-publish"'), none.indexOf('id="s-publish"') + 2000);
    assert(noneRow.includes('is-disabled') && noneRow.includes('Needs a plan first') && !noneRow.includes('data-op="publish"'), noneRow);
    assert(none.includes('Not planned') && none.includes('>Link a plan<') && !none.includes('data-op="plan-remove"'));
    const memberRaid = up({ can: { edit: false, review: false, seeAttendance: false, seeNicknames: false }, sources: planned.sources });
    const member = page(memberRaid, { signups: sState(view({ can: { edit: false, self: true, seeList: true, seeNicknames: false } })), roster: rState() }, MEMBER_CAN);
    assert(!member.includes('data-op="publish"') && !member.includes('Plan settings') && !member.includes('>Change<') && member.includes('Gruul night, 19 players'), 'a member reads the rows and gets no Change');
    const pub = page(planned, { signups: sState(view()), roster: rState({ published: true, publishedAt: 1, entries: [], counts: { confirmed: 1, pending: 0, declined: 0 } }) });
    assert(pub.includes('Published, 1 of 1 confirmed') && pub.includes('id="ro-h"') && pub.includes('data-op="republish"') && pub.includes('data-op="unpublish"'), 'a published line-up row with its menu, and the officers\' card in the main column');
  });

  await check('post-raid mode: the log and the people lead the main column, the sign-ups record sits behind Show sign-ups, the facts and the Loot awards card are the side column; Add a sign-up, Close sign-ups and the status buttons are gone', () => {
    const data = past({ sources: { event: { id: 'e1', title: 'BT', signups: 26, syncedAt: 1, otherServer: false }, reports: [{ code: 'WaghkY9zwDyvLX7m', flavour: 'fresh', startedAt: 1, pulls: 4 }], plan: { label: 'BT run', players: 19 } } });
    const out = page(data, { signups: sState(view({ raid: { id: 'r4', teamId: 't1', startsAt: 1, upcoming: false, locked: false, closed: 'started' }, me: meOf() })), loot: lState([]), roster: rState({ published: true, counts: { confirmed: 17, pending: 2, declined: 0 }, publishedAt: 1760000000000 }) });
    assert.deepEqual(idsOf(out), ['raid-cols']);
    assert(out.includes('class="gs-rpg-sp gs-rpg-sp-loot" id="s-loot"'), 'the Loot panel is the side column anchor s-loot');
    assert(!out.includes('data-action="su-add"') && !out.includes('data-action="su-lock"') && !out.includes('data-action="su-kind"'), 'no Add a sign-up, Close sign-ups or status buttons');
    assert(!out.includes('Opens when the raid starts') && !out.includes('View line-up') && !out.includes('gs-srow-more"><summary>View'), 'nothing is locked, no summary rows');
    assert(out.includes('<details class="gs-srow-more gs-rpg-record" id="s-signups" tabindex="-1"><summary>Show sign-ups</summary>'), 'the sign-ups record opens on demand');
    assert(out.includes('id="s-publish"') && out.includes('Published, 17 of 19 confirmed'), stripTags(out).slice(0, 600));
    assert(out.indexOf('id="raid-people"') < out.indexOf('id="s-signups"') && out.indexOf('id="s-signups"') < out.indexOf('id="raid-facts"') && out.indexOf('id="raid-facts"') < out.indexOf('id="s-loot"'), 'main: log, sign-ups record; side: facts, then the loot awards');
    const stage = page(past({ sources: { event: null, reports: [], plan: null }, people: [] }), {});
    assert(stage.includes('Awaiting log.') && stage.includes('id="raid-people"'));
    const lootLocked = page(past({ sources: { event: null, reports: [], plan: null }, people: [] }), {});
    assert(lootLocked.includes('Opens after the log is attached. Then import the Gargul export here.') && lootLocked.includes('id="s-loot"') && lootLocked.includes('id="loot-ph-h">Loot</h2>'));
  });

  await check('post-raid mode: Everyone lists the people who were on the roster that day - a later joiner is left out unless they signed up, were in the log or were decided on; Needs review keeps every flag', () => {
    const rows = [
      prow('p_a', 'Alliesha'),
      prow('p_l1', 'Latecomer', { signup: null, outcome: 'missed', credit: 0, pulls: { present: 0, total: 4, missedFirst: false, missedLast: false }, joinedAfter: true }),
      prow('p_l2', 'Latesigned', { signup: 'signed', outcome: 'missed', credit: 0, pulls: { present: 0, total: 4, missedFirst: false, missedLast: false }, joinedAfter: true }),
      prow('p_l3', 'Latelogged', { signup: null, joinedAfter: true }),
      prow('p_l4', 'Latedecided', { signup: null, outcome: 'missed', pulls: { present: 0, total: 4, missedFirst: false, missedLast: false }, joinedAfter: true, decision: { applied: true, reason: 'x' } }),
      prow('p_f', 'Flagged', { needsReview: true, outcome: 'late', joinedAfter: true, signup: null, pulls: { present: 0, total: 4, missedFirst: false, missedLast: false } }),
    ];
    assert.deepEqual(rows.filter(G.pages.raid.onRosterThatDay).map(r => r.name), ['Alliesha', 'Latesigned', 'Latelogged', 'Latedecided']);
    const out = page(past({ people: rows.slice(0, 5) }), { filter: 'all' });
    assert(out.includes('Everyone <span class="gs-seg-count">4</span>'), 'the Everyone count is the people on the roster that day');
    assert(!out.includes('>Latecomer<') && out.includes('>Latesigned<') && out.includes('>Alliesha<'));
    assert(out.includes('id="raid-later-note"') && stripTags(out).includes('1 person who joined the guild after this raid is not listed.'));
    const review = page(past({ people: rows }), {});
    assert(review.includes('Needs review <span class="gs-seg-count">1</span>') && review.includes('>Flagged<'), 'the default list is what needs a decision, later joiner or not');
    assert(!page(past({ people: rows.slice(0, 1) }), { filter: 'all' }).includes('raid-later-note'), 'no note when nobody is left out');
  });

  // ═══ 5. The More menu ═══
  await check('More: Open in Planner first, Delete raid last and alone after a rule; members get none; the destructive one is the only danger item', () => {
    const items = G.pages.raid.moreItemsOf(up(), { roster: rState() });
    assert.equal(items[0].label, 'Open in Planner');
    assert.equal(items[items.length - 1].label, 'Delete raid');
    assert(items[items.length - 1].danger && items[items.length - 2].separator, 'Delete raid sits in its own group');
    assert.equal(items.filter(i => i.danger).length, 1);
    assert.equal(G.pages.raid.moreItemsOf(up({ can: { edit: false } }), {}).length, 0);
    const out = page(up(), { roster: rState() });
    assert.equal(count(out, /id="raid-actions"/g), 1);
    assert(out.includes('class="gs-back-link"') && out.includes('href="#/g/g1/raids"'), 'a back link to Raids');
  });

  // ═══ 6. The Publish question says who is told ═══
  await check('Publish line-up: the question names who is told - members on their raid page, and the team\'s Discord channel only when its line-up post is on; unpublishing posts nothing', () => {
    const on = stripTags(G.pages.raidRoster.confirmDialogHtml('publish', true));
    assert(on.includes('Who is told: members, on their raid page.') && on.includes('The team\'s Discord channel also gets a post with the line-up.'), on);
    const off = stripTags(G.pages.raidRoster.confirmDialogHtml('publish', false));
    assert(off.includes('Who is told: members, on their raid page.') && off.includes('Nothing is posted to Discord') && !off.includes('channel also gets'), off);
    assert(stripTags(G.pages.raidRoster.confirmDialogHtml('republish', true)).includes('also gets a post'), 'a re-publish posts again');
    const un = stripTags(G.pages.raidRoster.confirmDialogHtml('unpublish', true));
    assert(!un.includes('Who is told') && !un.includes('Discord'), un);
    assert.equal(G.pages.raidRoster.confirmDialogHtml('publish', false).includes('Publish line-up'), true);
    // the click handler reads the officer's reply
    const st = G.app.state;
    const a = G.pages.attendance.attState();
    st.guilds.g1 = gd(OFFICER_CAN); st.currentGid = 'g1';
    a.raid = { gid: 'g1', rid: 'u1', data: up() };
    a.raidRoster = { gid: 'g1', rid: 'u1', status: 'ok', data: { published: false, discordPost: true }, busy: false, error: '' };
    let opened = null;
    const realOpen = ui.openDialog; ui.openDialog = html => { opened = html; };
    G.handlers.click['roster-publish']({ getAttribute: k => (k === 'data-op' ? 'publish' : null) });
    ui.openDialog = realOpen;
    assert(opened && opened.includes('channel also gets a post'), 'the handler passes discordPost from the reply');
  });

  // ═══ 7. Guild settings on T3 ═══
  await check('settings: five groups in order, 16 pages for the Guild Master, General first; an officer has no Guild data; a Team Lead only reaches Raid schedule', () => {
    const everything = Object.fromEntries(['guild.teams', 'guild.access', 'guild.roles', 'raids.edit', 'attendance.policy', 'loot.policy', 'audit.view'].map(a => [a, 'guild']));
    const groups = plain(G.shell.settingsGroups(everything, GM));
    assert.deepEqual(groups.map(g => g.label), ['Guild', 'People and access', 'Sharing', 'Raid rules', 'Connections and data']);
    assert.deepEqual(groups.map(g => g.items.map(i => i.tab)), [
      ['general', 'teams', 'schedule'], ['people', 'roles', 'discord'], ['guests', 'public', 'dataaccess'], ['attendance', 'loot', 'notifications', 'applications'], ['battlenet', 'activity', 'data'],
    ]);
    assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 16);
    assert.deepEqual(groups[0].items.map(i => i.label), ['General', 'Teams', 'Raid schedule']);
    assert.equal(groups[1].items[0].label, 'Accounts', 'the sign-in accounts page is called Accounts; its address stays people');
    assert.equal(groups[0].items[0].isNew, true);
    const officer = plain(G.shell.settingsGroups(everything, [{ role: 'officer' }]));
    assert.equal(officer.reduce((n, g) => n + g.items.length, 0), 15);
    assert(!officer[4].items.some(i => i.tab === 'data'));
    const lead = plain(G.shell.settingsGroups({ 'raids.edit': ['t1'] }, [{ role: 'team_lead' }]));
    assert.deepEqual(lead.map(g => [g.label, g.items.map(i => i.tab)]), [['Guild', ['schedule']]], 'groups with no page for the viewer are left out');
    assert.deepEqual(plain(G.shell.settingsGroups({}, [])), []);
    for (const t of G.shell.SETTINGS_TABS) assert.equal(G.shell.SETTINGS_TABS.filter(x => x.tab === t.tab).length, 1);
    assert(G.shell.SETTINGS_TABS.every(t => G.shell.SETTINGS_GROUPS.includes(t.group)), 'every page is in a group');
  });

  await check('settings: every address that worked before still opens its page, the Accounts address has both names, and the bare address is for the app to resolve', () => {
    const OLD = ['teams', 'schedule', 'people', 'roles', 'discord', 'guests', 'dataaccess', 'public', 'applications', 'notifications', 'attendance', 'loot', 'battlenet', 'activity', 'data'];
    for (const tab of OLD) {
      assert.deepEqual(plain(G.router.parse('#/g/g1/settings/' + tab)), { name: 'settings', gid: 'g1', tab });
      assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab }), '#/g/g1/settings/' + tab);
      assert(G.shell.SETTINGS_TABS.some(t => t.tab === tab), tab + ' is a page in a group');
    }
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings/general')), { name: 'settings', gid: 'g1', tab: 'general' });
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings/accounts')), { name: 'settings', gid: 'g1', tab: 'people' }, 'the new name reads as the old address');
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings')), { name: 'settings', gid: 'g1', tab: null });
    assert.equal(G.router.parse('#/g/g1/settings/nope').name, 'notfound');
    assert.equal(G.router.parse('#/g/g1/settings/constructor').name, 'notfound');
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings/__proto__')), { name: 'notfound' });
    const nav = G.shell.navItems('g1', OFFICER_CAN).find(i => i.key === 'settings');
    assert.equal(nav.href, '#/g/g1/settings', 'the nav item opens the bare address');
  });

  await check('settings frame: the groups on the left with the open page marked, the heading line, the page\'s title and one-line purpose, the save status in its head; the list screen shows the groups alone', () => {
    const guild = gd(EVERYTHING, [{ role: 'officer' }]);
    const frame = G.shell.settingsFrameHtml({ guildData: guild }, 'teams', '<p id="body">x</p>');
    assert.equal(count(frame, /<h2 class="gs-sgroup-h"/g), 5);
    assert(frame.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Guild settings</h1>') && frame.includes('Ravens - 15 pages in 5 groups'));
    assert(/<a class="gs-sitem is-active" href="#\/g\/g1\/settings\/teams" aria-current="page">Teams<\/a>/.test(frame));
    assert(frame.includes('id="settings-title" tabindex="-1">Teams</h2>') && frame.includes('The raid teams of the guild.'));
    assert(frame.includes('is-view-detail') && frame.includes('class="gs-back-link gs-sback" href="#/g/g1/settings"'));
    assert(frame.includes('>General<span class="gs-nbadge">New</span></a>'), 'General carries the New badge');
    assert(frame.includes('data-saved-status'));
    const saved = G.shell.settingsFrameHtml({ guildData: guild, settingsSavedAt: Date.UTC(2026, 9, 18, 1, 14) }, 'teams', '');
    assert(/Saved at \d{1,2}:14 [AP]M CT/.test(saved), 'Saved at 8:14 PM CT, in the guild zone');
    const list = G.shell.settingsListHtml({ guildData: guild });
    assert(list.includes('is-view-list') && count(list, /class="gs-sitem/g) === 15 && !list.includes('aria-current="page"'));
    assert(!list.includes('<form'), 'the list screen has no form');
  });

  await check('settings CSS: the list and the page are two screens on a phone (the other is hidden), the Save bar sits above the tab bar, and the heading belongs to the list screen', () => {
    const css = read('guild.css');
    assert(/is-view-list \.gs-sdetail \{ display: none; \}/.test(css) && /is-view-detail \.gs-slist \{ display: none; \}/.test(css) && /is-view-detail \.gs-shead \{ display: none; \}/.test(css));
    assert(/\.gs-savebar, \.gs-commitbar \{ bottom: 64px;/.test(css));
  });

  // ═══ 8. General ═══
  const generalFixture = (over, can, roles) => { const g = gd(can || OFFICER_CAN, roles || GM, Object.assign({ discordServerId: '900000000000000001' }, over || {})); G.app.state.guilds.g1 = g; G.app.state.currentGid = 'g1'; return g; };

  await check('General (Guild Master): name, realm and time zone are fields in one form with the Save bar; game version, region and the Discord server are read-only with the reason', () => {
    G.app.state.me = { create: { options: { realms: { tbc: { US: [{ name: 'Firemaw', type: 'PvP' }, { name: 'Dreamscythe', type: 'PvE' }] } } } } };
    const g = generalFixture();
    const out = G.pages.settingsGeneral.generalHtml({ guildData: g });
    assert(out.includes('<form class="gs-general-form" id="general-form" data-submit="general-form" novalidate data-dirty-form data-input="dirty-form" data-change="dirty-form">'));
    assert(/id="general-name" name="name"[^>]*required[^>]*value="Ravens"/.test(out) && out.includes('Shown in the sidebar, in Discord posts and on the public page.'));
    assert(/id="general-realm" name="realm"[^>]*list="general-realm-list"[^>]*value="Firemaw"/.test(out) && out.includes('<option value="Dreamscythe">'));
    assert(/<select class="gs-input" id="general-zone" name="timeZone"/.test(out) && out.includes('<option value="America/Chicago" selected>America/Chicago (CT)</option>'));
    assert(stripTags(out).includes('Changing it changes how times read ("8:00 PM ET" becomes "8:00 PM CT").'));
    assert(out.includes('data-savebar hidden') && out.includes('>Save changes<'));
    assert(out.includes('Set when the guild was created') && out.includes('<dt class="gs-ro-label">Game version</dt><dd class="gs-ro-value">TBC Anniversary</dd>') && out.includes('The buff and comp rules differ per version. To change it, create a new guild.'));
    assert(out.includes('<dt class="gs-ro-label">Region</dt><dd class="gs-ro-value">US</dd>') && out.includes('<dt class="gs-ro-label">Discord server</dt><dd class="gs-ro-value">ID 900000000000000001</dd>') && out.includes('Members sign in through this server.'));
    assert(!out.includes('Ruleset'), 'a realm guild has no ruleset row');
    assert.equal(count(out, /<h2 class="gs-h2"/g), 2, 'two headed cards: Guild and the fixed values');
    const frame = G.shell.settingsFrameHtml({ guildData: g }, 'general', out);
    assert(frame.includes('id="settings-title" tabindex="-1">General</h2>') && frame.includes('Raid times everywhere read in this zone.'));
    G.app.state.me = null;
  });

  await check('General: a Forever guild has a ruleset instead of a realm field (read-only, with the reason); an officer reads the values as text and is told only the Guild Master changes them', () => {
    const forever = generalFixture({ gameVersion: 'forever', realmKind: 'ruleset', realm: 'PvP', realmSlug: null });
    const out = G.pages.settingsGeneral.generalHtml({ guildData: forever });
    assert(!out.includes('id="general-realm"') && out.includes('<dt class="gs-ro-label">Ruleset</dt><dd class="gs-ro-value">PvP</dd>') && out.includes('To change it, create a new guild.'));
    assert(out.includes('WoW Forever') && out.includes('id="general-name"') && out.includes('id="general-zone"'));
    const officer = generalFixture({ discordServerId: undefined }, OFFICER_CAN, [{ role: 'officer' }]);
    const text = G.pages.settingsGeneral.generalHtml({ guildData: officer });
    assert(!text.includes('<form') && !text.includes('data-savebar') && text.includes('Only the Guild Master can change the name, realm or time zone.'));
    assert(text.includes('<dd class="gs-ro-value">Ravens</dd>') && text.includes('America/Chicago (CT)') && text.includes('The server you chose when you created the guild'), 'the officer reads the same values; the server id is the Guild Master\'s');
  });

  const fakeForm = (values) => {
    const controls = {};
    const ctl = (id, name, value) => { controls[id] = { id, name, value, type: 'text', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, focus() { this.focused = true; } }; return controls[id]; };
    const name = ctl('general-name', 'name', values.name);
    const realm = values.realm === undefined ? null : ctl('general-realm', 'realm', values.realm);
    const zone = ctl('general-zone', 'timeZone', values.timeZone);
    const errors = {};
    const form = {
      id: 'general-form', elements: { name, realm, timeZone: zone }, errors,
      querySelector(sel) {
        if (sel === '[aria-invalid="true"]') return Object.values(controls).filter(c => c.attrs['aria-invalid'])[0] || null;
        if (sel === '[data-error-summary-slot]') return { innerHTML: '' };
        const id = sel.slice(1);
        if (controls[id]) return controls[id];
        if (/-err$/.test(id)) return (errors[id] = errors[id] || { innerHTML: '', hidden: true });
        return null;
      },
      querySelectorAll: () => [],
    };
    return form;
  };
  const withGeneral = async (fn) => {
    const realApi = { patch: G.api.patch }; const app = { render: G.app.render, loadMe: G.app.loadMe, showFailure: G.app.showFailure, requireSignin: G.app.requireSignin };
    const calls = []; const renders = [];
    G.app.render = () => renders.push(1); G.app.loadMe = () => Promise.resolve();
    const realBusy = ui.setBusy; ui.setBusy = () => {};
    const realSetText = ui.setText; const texts = {}; ui.setText = (id, t) => { texts[id] = t; };
    try { await fn({ calls, renders, texts, stub: handler => { G.api.patch = (url, body) => { calls.push({ url, body }); return handler(url, body); }; } }); }
    finally { G.api.patch = realApi.patch; Object.assign(G.app, app); ui.setBusy = realBusy; ui.setText = realSetText; }
  };

  await check('General submit: only what changed is sent to PATCH /api/guild/:gid; the reply replaces the guild, the head says Saved at and the account\'s guild list is read again', async () => {
    const g = generalFixture();
    await withGeneral(async (h) => {
      const reply = Object.assign({}, g, { guild: Object.assign({}, g.guild, { name: 'Ravens Reborn', timeZone: 'America/Denver' }) });
      h.stub(() => Promise.resolve(reply));
      G.handlers.submit['general-form'](fakeForm({ name: '  Ravens Reborn ', realm: 'Firemaw', timeZone: 'America/Denver' }));
      await settle();
      assert.deepEqual(h.calls.map(c => [c.url, plain(c.body)]), [['/api/guild/g1', { name: 'Ravens Reborn', timeZone: 'America/Denver' }]], 'the unchanged realm is not sent');
      assert.equal(G.app.state.guilds.g1, reply);
      assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'general');
      assert.equal(h.renders.length, 1);
    });
    generalFixture();
    await withGeneral(async (h) => {
      h.stub(() => Promise.resolve({}));
      G.handlers.submit['general-form'](fakeForm({ name: 'Ravens', realm: 'Firemaw', timeZone: 'America/Chicago' }));
      await settle();
      assert.equal(h.calls.length, 0, 'nothing changed: nothing is sent');
    });
  });

  await check('General submit: the form\'s own checks come first (name 1 to 60, realm 1 to 64, a real zone) and nothing is sent; a refusal from the Worker lands on its field or in the form; an officer\'s submit does nothing', async () => {
    generalFixture();
    await withGeneral(async (h) => {
      h.stub(() => Promise.resolve({}));
      const form = fakeForm({ name: '   ', realm: 'x'.repeat(65), timeZone: 'Mars/Olympus' });
      G.handlers.submit['general-form'](form);
      await settle();
      assert.equal(h.calls.length, 0);
      assert.equal(form.querySelector('#general-name').attrs['aria-invalid'], 'true');
      assert(form.errors['general-name-err'].innerHTML.includes('Enter the guild name.') && form.errors['general-realm-err'].innerHTML.includes('at most 64') && form.errors['general-zone-err'].innerHTML.includes('Pick a time zone.'));
      assert.equal(form.querySelector('[data-error-summary-slot]').innerHTML, '', 'a summary only from three errors on is built by the helper, not here');
    });
    await withGeneral(async (h) => {
      h.stub(() => Promise.reject(Object.assign(new G.api.ApiError(400, { error: 'bad_request', message: 'name must be 1 to 60 characters of plain text.', field: 'name' }))));
      const form = fakeForm({ name: 'New name', realm: 'Firemaw', timeZone: 'America/Chicago' });
      G.handlers.submit['general-form'](form);
      await settle();
      assert(form.errors['general-name-err'].innerHTML.includes('1 to 60 characters'), 'the Worker\'s message sits under the name field');
      h.stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'Only the Guild Master can change the name, realm or time zone of the guild.' })));
      const shown = []; const realFail = G.app.showFailure; G.app.showFailure = (t, x) => shown.push([t, x]);
      G.handlers.submit['general-form'](fakeForm({ name: 'Other', realm: 'Firemaw', timeZone: 'America/Chicago' }));
      await settle();
      G.app.showFailure = realFail;
      assert(shown.length === 1 || h.texts['general-error'], 'a 403 is shown as the message page or in the form');
    });
    generalFixture({}, OFFICER_CAN, [{ role: 'officer' }]);
    await withGeneral(async (h) => {
      h.stub(() => Promise.resolve({}));
      G.handlers.submit['general-form'](fakeForm({ name: 'Hijack', realm: 'Firemaw', timeZone: 'America/Chicago' }));
      await settle();
      assert.equal(h.calls.length, 0, 'only the Guild Master submits');
    });
  });

  await check('Battle.net import copy: the guild name links to Guild settings > Battle.net and a realm guild\'s realm to Guild settings > General (the Guild Master\'s); a Forever guild\'s realm is on Battle.net; others are told to ask', () => {
    const info = (g, d) => G.pages.importBnet.bnetHtml ? null : null;
    const src = read('js/guild/pages-import-bnet.js');
    assert(src.includes('Change it in Guild settings &gt; Battle.net') && src.includes("tab: 'general'") && src.includes('Wrong realm?'));
    const guildData = gd(OFFICER_CAN, GM);
    const html = G.pages.importBnet.bnetHtml({ guildData, bnet: { gid: 'g1', info: { configured: true, supported: true, realmNeeded: false, canEdit: true, effectiveGuildName: 'Ravens', realmKind: 'realm' }, view: {}, status: 'idle', rows: null, search: '', filters: {}, defaultStatus: 'raider', ticked: {} } });
    assert(html.includes('href="#/g/g1/settings/battlenet">Change it in Guild settings &gt; Battle.net</a>') && html.includes('href="#/g/g1/settings/general">Change it in Guild settings &gt; General</a>'), html.slice(html.indexOf('bnet-import-target') - 20, html.indexOf('bnet-import-target') + 600));
    const officer = G.pages.importBnet.bnetHtml({ guildData: gd(OFFICER_CAN, [{ role: 'officer' }]), bnet: { gid: 'g1', info: { configured: true, supported: true, realmNeeded: false, canEdit: true, effectiveGuildName: 'Ravens', realmKind: 'realm' }, view: {}, status: 'idle', rows: null, search: '', filters: {}, defaultStatus: 'raider', ticked: {} } });
    assert(officer.includes('Wrong realm? Ask the Guild Master') && !officer.includes('settings/general'));
  });

  // ═══ 9. The Save bar ═══
  await check('Save bar: a draft page counts what differs from what is saved (every changed setting once, a list item added or removed once); 0 hides the bar', () => {
    const n = ui.saveBar.draftChanges;
    assert.equal(n({}, {}), 0);
    assert.equal(n({ a: 1 }, { a: 1 }), 0);
    assert.equal(n({ a: 1 }, { a: 2 }), 1);
    assert.equal(n({}, { credit: { values: [1, 2] } }), 1, 'a list of plain values is one setting');
    assert.equal(n({ watch: { below: 0.7 } }, { watch: { below: 0.8, dropBy: 0.1 } }), 2, 'nested keys count one each');
    assert.equal(n({ slots: [{ weekday: 2, startTime: '20:00' }] }, { slots: [{ weekday: 2, startTime: '20:00' }, { weekday: 4, startTime: '20:00' }] }), 1, 'a slot added is one change');
    assert.equal(n({ slots: [{ weekday: 2, startTime: '20:00' }] }, { slots: [{ weekday: 2, startTime: '21:00' }] }), 1, 'a slot changed is one change');
    assert.equal(n({ slots: [{ weekday: 2 }, { weekday: 4 }] }, { slots: [] }), 2, 'two slots removed');
    assert.equal(n({ a: null }, { a: undefined }), 0, 'null and absent are the same');
    const bar = ui.saveBarHtml({ count: 0, discardAttrs: { 'data-action': 'x-discard', 'data-key': 'x-discard' } });
    assert(bar.includes('data-savebar-count="0"') && bar.includes(' hidden>') && bar.includes('data-action="x-discard"') && !bar.includes('data-action="savebar-discard"'));
    const three = ui.saveBarHtml({ count: 3 });
    assert(!three.includes(' hidden') && three.includes('3 unsaved changes') && three.includes('data-savebar-count="3"'));
    assert(ui.saveBarHtml({}).includes(' hidden') && !ui.saveBarHtml({}).includes('data-savebar-count'), 'a form page\'s bar starts hidden and is driven by its controls');
  });

  await check('Save bar: setCount shows or hides the bar and keeps the leave guard and the head status in step; sync starts every held-back form from what was drawn', () => {
    const bar = { hidden: true, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }, querySelector: () => text };
    const text = { textContent: '' };
    const slot = { textContent: 'Saved at 8:14 PM CT', className: 'gs-saved-status is-saved', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] || null; } };
    const doc = { querySelector: sel => (sel === '[data-savebar]' ? bar : sel === '[data-saved-status]' ? slot : null) };
    const realDoc = ctx.document; ctx.document = doc;
    try {
      ui.unsaved.clear();
      ui.saveBar.setCount(null, 2);
      assert.equal(bar.hidden, false); assert.equal(text.textContent, '2 unsaved changes'); assert.equal(ui.unsaved.isDirty(), true);
      assert.equal(slot.textContent, 'Unsaved changes'); assert(slot.className.includes('is-unsaved'));
      ui.saveBar.setCount(null, 0);
      assert.equal(bar.hidden, true); assert.equal(ui.unsaved.isDirty(), false);
      assert.equal(slot.textContent, 'Saved at 8:14 PM CT', 'the status goes back to what it said'); assert(slot.className.includes('is-saved'));
      // sync: a draw with a draft bar that has changes arms the guard; a form is bound
      const bound = []; const realBind = ui.saveBar.bind; ui.saveBar.bind = f => bound.push(f);
      const root = { querySelectorAll: sel => (sel === 'form[data-dirty-form]' ? ['formA'] : sel === '[data-savebar-count]' ? [{ getAttribute: () => '3' }] : []) };
      ui.saveBar.sync(root);
      ui.saveBar.bind = realBind;
      assert.deepEqual(bound, ['formA']); assert.equal(ui.unsaved.isDirty(), true);
      ui.unsaved.clear();
    } finally { ctx.document = realDoc; ui.unsaved.clear(); }
  });

  await check('Save bar: a snapshot counts every box of a group that shares a name (the Public page\'s sections), not just the last', () => {
    const box = (value, checked) => ({ name: 'section', type: 'checkbox', value, checked });
    const form = { elements: [box('roster', true), box('raids', false), { name: 'enabled', type: 'checkbox', value: 'on', checked: true }] };
    assert.deepEqual(plain(ui.saveBar.snapshot(form)), { 'section:roster': 'on', 'section:raids': '', enabled: 'on' });
    const before = ui.saveBar.snapshot(form);
    form.elements[0].checked = false;
    assert.deepEqual(plain(ui.saveBar.diff(before, ui.saveBar.snapshot(form))), ['section:roster']);
  });

  // ═══ 10. The form pages carry the Save bar; Attendance is in sections ═══
  await check('form pages: General, Public page, Battle.net, Discord roles, Notifications (one bar per team), Applications, Raid schedule, Attendance and Loot all draw the Save bar; lists and dialog pages do not', () => {
    const src = f => read('js/guild/' + f);
    for (const f of ['pages-settings-general.js', 'pages-settings-public.js', 'pages-settings-bnet.js', 'pages-settings-discord.js', 'pages-settings-notifications.js', 'pages-settings-applications.js', 'pages-settings-schedule.js', 'pages-settings-attendance.js', 'pages-settings-loot.js']) {
      assert(src(f).includes('G.ui.saveBarHtml('), f + ' draws the Save bar');
      assert(!/class="gs-btn gs-btn-molten"[^>]*>Save(?: schedule| mapping)?<\/button>/.test(src(f)), f + ' has no page-level Save button of its own');
    }
    for (const f of ['pages-settings-teams.js', 'pages-settings-roles.js', 'pages-settings-guests.js', 'pages-settings-dataaccess.js', 'pages-settings-people.js', 'pages-settings-activity.js', 'pages-settings-data.js']) assert(!src(f).includes('saveBarHtml'), f + ' saves per row or per dialog');
    assert(src('pages-settings-notifications.js').includes("saveLabel: 'Save ' + team.name"), 'each team\'s form says whose Save it is');
    assert(src('app.js').includes('G.ui.saveBar.sync(main)'), 'the app starts each drawn form from what it drew');
    for (const f of ['pages-settings-teams.js', 'pages-settings-roles.js', 'pages-settings-discord.js', 'pages-settings-guests.js', 'pages-settings-dataaccess.js', 'pages-settings-public.js', 'pages-settings-applications.js', 'pages-settings-notifications.js', 'pages-settings-bnet.js', 'pages-settings-data.js']) {
      assert(!/<h2 class="gs-h2" id="[a-z-]+">(Teams|Roles|Discord roles|Guest links|Data access|Public page|Applications|Notifications|Battle\.net|Guild data)<\/h2>/.test(src(f)), f + ' does not repeat the page title the frame already shows');
    }
  });

  await check('Attendance page: three headed sections with an On this page list of anchors, every group in exactly one section, Bench with the late rules, the Save bar inside the rules form and the Warcraft Logs card saved on its own', () => {
    const S = G.pages.settingsAtt;
    assert.deepEqual(plain(S.SECTIONS.map(s => s.id)), ['att-present', 'att-late', 'att-review']);
    for (const g of S.GROUPS) assert.equal(S.SECTIONS.filter(s => s.id === g.section).length, 1, g.id + ' is in one section');
    assert.deepEqual(plain(S.GROUPS.filter(g => g.section === 'att-present').map(g => g.id)), ['expected', 'signups', 'fillin']);
    assert.deepEqual(plain(S.GROUPS.filter(g => g.section === 'att-late').map(g => g.id)), ['bench', 'late', 'credit']);
    assert.deepEqual(plain(S.GROUPS.filter(g => g.section === 'att-review').map(g => g.id)), ['windows', 'watch', 'ladder', 'reset']);
    const fieldPaths = S.GROUPS.reduce((all, g) => all.concat(g.fields.map(f => f.path)), []);
    assert.equal(new Set(fieldPaths).size, fieldPaths.length, 'no field is listed twice');
    assert(fieldPaths.includes('bench') && fieldPaths.includes('lateSignup') && fieldPaths.includes('fillIn'));
    const VIEW = { defaults: { expected: { mode: 'signedUp', statuses: ['raider'] }, noSignup: 'shown', tentative: 'asNoSignup', absence: 'missedWithNotice', bench: 'full', lateSignup: 'fullCreditNoFlag', detection: { mode: 'pulls' }, credit: { values: [{ id: 'half', label: 'Half', value: 0.5 }, { id: 'full', label: 'Full', value: 1 }] }, fillIn: 'always', window: { defaultWeeks: 8, switchWeeks: [8, 12] }, effectiveStart: 'laterOfJoinAndFirst', streakFlagAt: 3, resetDay: 2 }, guild: {}, teams: {}, versions: { guild: 0, teams: {} }, resolved: {}, wcl: { guildId: null, uploaders: {} } };
    const state = draft => ({ view: VIEW, scope: 'guild', draft: draft || {}, stale: 0 });
    const out = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: state() });
    assert.deepEqual([...out.matchAll(/<section class="gs-osection gs-att-section" id="(att-[a-z]+)"/g)].map(m => m[1]), ['att-present', 'att-late', 'att-review']);
    assert(out.includes('<nav class="gs-onpage-nav" aria-label="On this page">') && count(out, /data-action="jump" data-target="att-/g) === 4);
    for (const id of ['att-present', 'att-late', 'att-review', 'att-wcl']) assert(out.includes(' id="' + id + '" tabindex="-1"'), id + ' is a jump target');
    assert(out.includes('<h2 class="gs-h2" id="att-present-h">What counts as attended</h2>') && out.includes('>Late and bench rules</h2>') && out.includes('>Review and watch list</h2>'));
    const form = out.slice(out.indexOf('<form class="gs-pol-form"'), out.indexOf('</form>', out.indexOf('<form class="gs-pol-form"')));
    assert(form.includes('data-savebar') && form.includes('data-action="pol-discard"') && !form.includes('data-action="pol-discard"') === false, 'the Save bar is inside the rules form');
    assert(!/<button type="submit" class="gs-btn gs-btn-molten">Save<\/button>/.test(out));
    assert(out.includes('data-submit="wcl-form"') && out.includes('Saved on its own, apart from the rules above.'));
    assert(!form.includes('data-submit="wcl-form"'), 'the Warcraft Logs card is its own form');
    // the bar counts what differs from what is saved, and starts hidden at no changes
    assert(form.includes('data-savebar-count="0"'));
    const edited = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: state({ bench: 'excluded', watch: { below: 0.5 } }) });
    assert(edited.includes('data-savebar-count="2"') && edited.includes('2 unsaved changes'));
    const same = S.settingsHtml({ guildData: gd(OFFICER_CAN), s: state({ bench: 'full' }) });
    assert(same.includes('data-savebar-count="0"'), 'a value equal to the built-in rule is not a change on the guild default');
  });

  await check('Raid schedule and Loot pages: the Save bar counts the draft against what is saved and Discard puts the draft back', async () => {
    const Sched = G.pages.settingsSchedule;
    const data = { slots: [{ weekday: 2, startTime: '20:00', zone: null, title: null }], weeks: 2, auto: false, signupCloseHours: 24, timeZone: 'America/Chicago', zones: [] };
    const draft = Sched.draftFrom(data);
    const base = { teamId: 't1', data, draft, error: '', closeError: '', note: '', busy: false };
    const clean = Sched.scheduleHtml({ guildData: gd(OFFICER_CAN), s: base });
    assert(clean.includes('data-savebar-count="0"') && clean.includes('data-action="sched-discard"') && clean.includes('>Save schedule<') && !clean.includes('data-key="sched-save"'));
    const edited = Sched.scheduleHtml({ guildData: gd(OFFICER_CAN), s: Object.assign({}, base, { draft: Object.assign({}, draft, { weeks: 4, slots: draft.slots.concat([{ weekday: 4, startTime: '20:00', zone: '', title: '' }]) }) }) });
    assert(edited.includes('data-savebar-count="2"'), 'weeks changed and a slot added');
    const st = G.app.state; const a = G.pages.attendance.attState();
    st.guilds.g1 = gd(OFFICER_CAN); st.currentGid = 'g1';
    a.settingsSchedule = Object.assign({ gid: 'g1' }, base, { draft: Object.assign({}, draft, { weeks: 6 }) });
    const rendered = []; const realRender = G.app.render; G.app.render = () => rendered.push(1);
    G.handlers.click['sched-discard']();
    G.app.render = realRender;
    assert.equal(a.settingsSchedule.draft.weeks, 2, 'Discard returns the saved weeks');
    assert.equal(rendered.length, 1);
    const Loot = G.pages.settingsLoot;
    assert(read('js/guild/pages-settings-loot.js').includes("data-action': 'lpol-discard'") && typeof G.handlers.click['lpol-discard'] === 'function' && typeof G.handlers.click['pol-discard'] === 'function' && typeof G.handlers.click['apply-discard'] === 'function');
    assert(Loot && Loot.GROUPS.length > 0);
  });

  // ═══ 11. The addresses and the phone, through the real router ═══
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
