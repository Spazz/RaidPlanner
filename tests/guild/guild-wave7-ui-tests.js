/**
 * Raidsmith guild UI, PM wave 7 - tests for the team progress board (Raids > Progress and the public
 * page's Progress section) and the rank ladder (the ladder editor, the rank chip and suggestions on Attendance, the person's attendance page, Home).
 * Run: node tests/guild/guild-wave7-ui-tests.js
 *
 * Same approach as guild-roles-ui-tests.js: the shared guild script list (tests/guild-scripts.js) is loaded in a vm with no DOM; the render functions return
 * HTML strings and the handlers run against a stubbed G.api and a fake document. guild-wave7-worker-tests.js covers the Worker half.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('node:url');

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
const css = read('guild.css');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const fields = {};
ctx.document = { getElementById: id => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 14; i++) await tick(); };
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 17, 12);
const HOSTILE = '<img src=x onerror=1>';

function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

const TEAMS = [{ id: 't1', name: 'Alpha', size: 25, archived: false }, { id: 't2', name: 'Bravo', size: 25, archived: false }];
const OFFICER = { 'guild.access': 'guild', 'guild.roles': 'guild', 'attendance.policy': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'roster.edit': 'guild' };
function guildData(can, extra) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', realmSlug: 'dreamscythe', region: 'US', timeZone: 'UTC', gameVersion: 'tbc', createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({ players: 0, leads: [] }, t)),
    me: { roles: [{ role: 'officer' }], can: can || OFFICER },
    rosterOptions: null,
  }, extra || {});
}

function withApi(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = G.api[k]; G.api[k] = stubs[k]; }
  const savedGo = G.app.go, savedRender = G.app.render, savedRoute = G.app.routeAll, savedOpen = G.ui.openDialog, savedHandle = G.app.handleError;
  const opened = [];
  const routed = [];
  const handled = [];
  let renders = 0;
  G.app.go = () => {};
  G.app.render = () => { renders++; };
  G.app.routeAll = (o) => { routed.push(o); return Promise.resolve(); };
  G.app.handleError = (err, o) => { handled.push([err, o]); };
  G.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return { open: true }; };
  const probe = { opened, routed, handled, renders: () => renders };
  return Promise.resolve(fn(probe)).finally(() => {
    for (const k of Object.keys(saved)) G.api[k] = saved[k];
    G.app.go = savedGo; G.app.render = savedRender; G.app.routeAll = savedRoute; G.ui.openDialog = savedOpen; G.app.handleError = savedHandle;
  });
}
function formEl(attrs, elements, lists) {
  return {
    getAttribute: k => (attrs || {})[k], elements: elements || {}, querySelectorAll: sel => ((lists || {})[sel] || []), querySelector: () => null, closest: () => null, disabled: false,
  };
}
const el = attrs => ({ disabled: false, hidden: false, getAttribute: k => (attrs || {})[k], closest: () => null, focus() {}, select() {} });
function field(id) { fields[id] = { textContent: '', hidden: true }; return fields[id]; }
function clearFields() { for (const k of Object.keys(fields)) delete fields[k]; }
const okRes = body => Promise.resolve(body);
const rejectWith = (status, body) => Promise.reject(new G.api.ApiError(status, body));

(async () => {
  const { DEFAULT_POLICY } = await import(pathToFileURL(path.join(ROOT, 'worker/attendance-policy.js')).href);

  // =========================================================================
  // Data access moved to Guild settings > Links and keys (guild-b8a-links-tests.js); the data API itself stays here

  await check('data API: the Worker runs first for /api/v1/*', () => {
    assert(/"\/api\/v1\/\*"/.test(read('wrangler.jsonc')), 'the Worker runs first for /api/v1/*');
  });

  // =========================================================================
  // Progress

  const PROGRESS = {
    team: { id: 't1', name: 'Alpha' },
    zones: [
      { zone: 'Karazhan', bossesKilled: 0, nightCount: 0, nights: [], bestClear: null, bosses: [{ encounterId: 652, name: 'Attumen the Huntsman', killed: false, firstKillOn: null, firstKillRaidId: null, wipesBeforeKill: 0, wipes: 4, kills: 0, killsSince: 0, pulls: 4 }] },
      { zone: "Gruul's Lair", bossesKilled: 2, nightCount: 11, bestClear: { raidId: 'r_2', raidOn: '2026-12-08', bosses: 2, kills: 2, wipes: 0, durationMs: 20 * 60000 },
        nights: [{ raidId: 'r_2', raidOn: '2026-12-08', bosses: 2, kills: 2, wipes: 0, durationMs: 80 * 60000 }, { raidId: 'r_1', raidOn: '2026-12-01', bosses: 1, kills: 1, wipes: 3, durationMs: 65 * 60000 }],
        bosses: [{ encounterId: 649, name: 'High King Maulgar', killed: true, firstKillOn: '2026-12-01', firstKillRaidId: 'r_1', wipesBeforeKill: 2, wipes: 2, kills: 3, killsSince: 2, pulls: 5 },
          { encounterId: 650, name: 'Gruul the Dragonkiller', killed: true, firstKillOn: '2026-12-08', firstKillRaidId: 'r_2', wipesBeforeKill: 0, wipes: 0, kills: 1, killsSince: 0, pulls: 1 }] },
    ],
  };

  await check('progress board: per zone the bosses with first kill, wipes before it and kills since, the best clear, the nights; a boss not yet down says Progressing; stacks on a phone', () => {
    const P = G.pages.progress;
    assert.equal(P.duration(0), '0m'); assert.equal(P.duration(45 * 60000), '45m'); assert.equal(P.duration(192 * 60000), '3h 12m'); assert.equal(P.duration(65 * 60000), '1h 05m'); assert.equal(P.duration(-5), '0m');
    const out = P.boardHtml({ gid: 'g1', data: PROGRESS });
    const t = text(out);
    assert(t.includes('Karazhan') && t.includes("Gruul's Lair") && t.includes('0 of 1 boss down') && t.includes('2 of 2 bosses down'), t);
    assert(t.includes('Progressing') && t.includes('Down') && t.includes('Attumen the Huntsman'), t);
    assert(t.includes('Best clear: 2 bosses in 20m on'), t);
    assert(t.includes('No night with a boss kill yet.'), 'a zone with no kill says so');
    assert(t.includes('Nights with a kill (newest 2 of 11)'), t);
    assert(t.includes('1h 20m') && t.includes('1h 05m'), t);
    // Wipes: before the kill for a boss that is down, all wipes for one that is not.
    assert(/data-label="Wipes before the kill" class="gs-num">2</.test(out) && /data-label="Wipes" class="gs-num">4</.test(out));
    assert(/<button[^>]*data-sort="wipes"[^>]*>Wipes before the kill/.test(out) && /<button[^>]*data-sort="since"[^>]*>Kills since/.test(out));
    assert(/<a href="#\/g\/g1\/raids\/r\/r_2">/.test(out), 'a night links to its raid for members');
    assert(out.includes('gs-table-stack') && out.includes('data-label="First kill"'));
    assert(/\.gs-table-prog \{ min-width: 520px; \}/.test(css) && /@media \(max-width: 600px\) \{\s*\.gs-table-prog \{ min-width: 0; \}/.test(css), 'the desktop minimum is reset on a phone');
    // The public variant has no raid links; an empty team says what to do; a failure and loading are plain.
    const pub = P.blockHtml(PROGRESS, 'vprog-t1');
    assert(!/href=/.test(pub) && text(pub).includes('Gruul') && pub.includes('id="vprog-t1-z0-h"'), 'no links, ids from the prefix');
    assert(text(P.boardHtml({ gid: 'g1', data: { zones: [] } })).includes('No boss pulls yet.'));
    assert(text(P.boardHtml({ gid: 'g1', data: null })).includes('Loading'));
    assert(P.boardHtml({ gid: 'g1', error: 'Nope' }).includes('role="alert"'));
    assert(!P.boardHtml({ gid: 'g1', data: Object.assign({}, PROGRESS, { zones: [Object.assign({}, PROGRESS.zones[0], { zone: HOSTILE })] }) }).includes('<img src=x'));
    assertNoRawAttrs(out);
  });

  await check('Raids page: a third tab, Progress; opening it reads the board once, shows it, and a reload of the list keeps Upcoming / Past but not Progress', async () => {
    const gd = guildData();
    const data = { raids: [{ id: 'r_1', raidOn: '2026-12-01', zone: "Gruul's Lair", state: 'reviewed', openFlags: 0, sources: {} }], upcoming: [], today: '2026-12-10', can: {} };
    const tabs = G.pages.raids.raidsHtml({ guildData: gd, teamId: 't1', data, tab: 'past' });
    assert(/aria-pressed="false" data-action="raids-tab" data-value="progress"[^>]*>Progress</.test(tabs), 'the third button');
    const withBoard = G.pages.raids.raidsHtml({ guildData: gd, teamId: 't1', data, tab: 'progress', progressHtml: '<p id="the-board">Board</p>' });
    assert(/aria-pressed="true" data-action="raids-tab" data-value="progress"/.test(withBoard) && withBoard.includes('id="the-board"') && text(withBoard).includes('Boss progress from the logged raids'));
    assert(!withBoard.includes('aria-label="Raids"><thead'), 'the list of past raids is not drawn under it');
    // An unknown tab falls back; the empty team has no tabs at all.
    assert(/aria-pressed="true" data-action="raids-tab" data-value="past"/.test(G.pages.raids.raidsHtml({ guildData: gd, teamId: 't1', data, tab: 'nonsense' })));
    // The click.
    const S = G.app.state;
    S.guilds.g1 = gd; S.currentGid = 'g1';
    const x = { gid: 'g1', teamId: 't1', data, tab: 'past' };
    S.att = { raids: x };
    const gets = [];
    await withApi({ get: (url) => { gets.push(url); return okRes(PROGRESS); } }, async probe => {
      G.handlers.click['raids-tab'](el({ 'data-tab': 'progress' }));
      assert.equal(x.tab, 'progress');
      assert.deepEqual(plain(x.progress), { teamId: 't1', data: null, error: '' }, 'loading while it is read');
      assert(text(G.pages.progress.tabHtml(x)).includes('Loading'));
      await settle();
      assert.deepEqual(gets, ['/api/guild/g1/teams/t1/progress']);
      assert.equal(x.progress.data.zones.length, 2);
      assert(G.pages.progress.tabHtml(x).includes('prog-board'));
      G.handlers.click['raids-tab'](el({ 'data-tab': 'upcoming' }));
      assert.equal(x.tab, 'upcoming');
      assert.equal(G.pages.progress.tabHtml(x), '', 'only on its own tab');
    });
    // A failed read shows its words.
    await withApi({ get: () => rejectWith(403, { error: 'forbidden', message: 'You do not have permission to do that.' }) }, async () => {
      G.handlers.click['raids-tab'](el({ 'data-tab': 'progress' }));
      await settle();
      assert(x.progress.error && !x.progress.data);
      assert(G.pages.progress.tabHtml(x).includes('role="alert"'));
    });
    S.att = {};
  });

  await check('public page: Progress is an option between Raids and Attendance, and the read-only view draws the board without raid links', () => {
    const items = G.pages.settingsPublic.SECTION_ITEMS.map(i => i.key);
    assert.deepEqual(plain(items), ['roster', 'raids', 'progress', 'attendance', 'loot']);
    const settings = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: { enabled: true, sections: ['progress'], allowed: { roster: true, raids: true, progress: true, attendance: true, loot: true }, path: '/#/public/g1' }, origin: 'https://r.test' });
    assert(/id="public-sec-progress" name="section" value="progress" checked/.test(settings) && text(settings).includes('Boss progress'));
    const closed = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: { enabled: true, sections: [], allowed: { roster: true, raids: true, progress: false }, path: '/#/public/g1' } });
    assert(/id="public-sec-progress"[^>]*disabled/.test(closed));
    const view = G.pages.view.viewHtml({ kind: 'public', data: { viewer: { kind: 'public' }, guild: { name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', region: 'US', gameVersion: 'tbc' }, teams: [{ id: 't1', name: 'Alpha' }], sections: { progress: [PROGRESS] } } });
    assert(text(view).includes('Progress') && text(view).includes("Gruul's Lair") && text(view).includes('High King Maulgar'));
    assert(!/href="#\/g\//.test(view), 'no link into the guild');
    assert(view.indexOf('view-progress-h') > 0 && /<h3 class="gs-h3">Alpha<\/h3>/.test(view));
    assertNoRawAttrs(view);
  });

  // =========================================================================
  // Ranks

  const SUGGEST_PROMOTE = { kind: 'promote', from: { id: 'raider', name: 'Raider' }, to: { id: 'core', name: 'Core' }, reasons: ['attendance of 90% or more', '6 raids attended since the current rank'] };
  const SUGGEST_REVIEW = { kind: 'review', from: { id: 'raider', name: 'Raider' }, to: { id: 'member', name: 'Member' }, reasons: ['attendance 25% (the rank asks 75%)'] };

  await check('ranks: the chip says "Suggested: promote to Core" / "Suggested: review (below Raider)", with Accept and Dismiss that name the person; only a suggestion has buttons', () => {
    const R = G.pages.ranks;
    assert.equal(R.suggestionText(SUGGEST_PROMOTE), 'Suggested: promote to Core');
    assert.equal(R.suggestionText(SUGGEST_REVIEW), 'Suggested: review (below Raider)');
    assert.equal(R.suggestionText(null), '');
    const line = R.lineHtml({ id: 'p_1', name: 'Bran', rank: { id: 'raider', name: 'Raider', set: true }, rankSuggestion: SUGGEST_PROMOTE }, 't1');
    assert(text(line).includes('Rank: Raider') && text(line).includes('Suggested: promote to Core'), text(line));
    assert(/data-action="rank-accept" data-pid="p_1" data-team="t1" data-kind="promote" data-to="core" data-from="raider"/.test(line));
    assert(/data-action="rank-dismiss" data-pid="p_1" data-team="t1" data-kind="promote" data-to="core"/.test(line));
    assert(line.includes('aria-label="Accept: Promote Bran to Core"') && line.includes('aria-label="Dismiss for 30 days: Suggested: promote to Core for Bran"'));
    assert(line.includes('title="attendance of 90% or more; 6 raids attended since the current rank"'));
    const review = R.lineHtml({ id: 'p_2', name: 'Cora', rank: { id: 'raider', name: 'Raider', set: true }, rankSuggestion: SUGGEST_REVIEW }, 't1');
    assert(review.includes('aria-label="Accept: Move Cora down to Member"') && text(review).includes('Suggested: review (below Raider)'));
    // A person on the default rank carries no expected rank (the Worker has none stored); no suggestion, no buttons; no ladder, nothing.
    const plainLine = R.lineHtml({ id: 'p_3', name: 'Aria', rank: { id: 'member', name: 'Member', set: false } }, 't1');
    assert(text(plainLine).includes('Member') && !plainLine.includes('data-action'));
    assert(/data-from=""/.test(R.lineHtml({ id: 'p_3', name: 'Aria', rank: { id: 'member', name: 'Member', set: false }, rankSuggestion: SUGGEST_PROMOTE }, 't1')));
    assert.equal(R.lineHtml({ id: 'p_4', name: 'Dax' }, 't1'), '');
    assert(!R.lineHtml({ id: 'p_5', name: HOSTILE, rank: { id: 'x', name: HOSTILE, set: true }, rankSuggestion: SUGGEST_PROMOTE }, 't1').includes('<img src=x'));
    assertNoRawAttrs(line);
  });

  const teamData = (people) => ({
    team: { id: 't1', name: 'Alpha' }, today: '2027-01-15', window: 8, policy: { switchWeeks: [8, 12], defaultWeeks: 8, streakFlagAt: 4, creditValues: [] }, weeks: [{ weekStart: '2027-01-12', raids: [{ id: 'r_1', raidOn: '2027-01-12', zone: 'Karazhan' }] }],
    awaitingReview: 0, staleRaids: 0, watch: null, ladder: [{ id: 'member', name: 'Member' }, { id: 'raider', name: 'Raider' }, { id: 'core', name: 'Core' }],
    people: people || [
      { id: 'p_1', name: 'Bran', class: 'MAGE', status: 'raider', isMe: false, pct: 100, pctAll: 100, signupRate: 100, streak: 0, lastAttended: '2027-01-12', cells: [], rank: { id: 'raider', name: 'Raider', set: true }, rankSuggestion: SUGGEST_PROMOTE },
      { id: 'p_2', name: 'Aria', class: 'WARRIOR', status: 'raider', isMe: false, pct: 90, pctAll: 90, signupRate: 90, streak: 0, lastAttended: '2027-01-12', cells: [], rank: { id: 'member', name: 'Member', set: false } },
    ],
  });

  await check('Attendance page: the rank under the name in the In between rows, the suggestion where there is one (also in a compact Reliable row); nothing when the guild has no ladder', () => {
    const gd = guildData();
    const withLadder = teamData();
    withLadder.people[1].pct = 80; // Aria is In between (a rank chip), Bran is Reliable (a compact row: only his suggestion)
    const out = G.pages.attendance.attendanceHtml({ guildData: gd, teamId: 't1', data: withLadder, view: {}, policy: null });
    assert.equal((out.match(/gs-rank-chip/g) || []).length, 2, 'Aria\'s rank, and Bran\'s with his suggestion');
    assert.equal((out.match(/data-action="rank-accept"/g) || []).length, 1, 'the one suggestion');
    assert(text(out).includes('Suggested: promote to Core'));
    const none = teamData([{ id: 'p_1', name: 'Bran', class: 'MAGE', status: 'raider', pct: 100, pctAll: 100, signupRate: 100, streak: 0, lastAttended: '2027-01-12', cells: [] }]);
    delete none.ladder;
    const bare = G.pages.attendance.attendanceHtml({ guildData: gd, teamId: 't1', data: none, view: {}, policy: null });
    assert(!bare.includes('gs-rank') && !bare.includes('rank-accept'));
    assertNoRawAttrs(out);
  });

  await check('rank handlers: Accept PUTs the suggested rank with the one the page showed, Dismiss POSTs the kind and target; both read the page again and forget the Home count; a conflict reads again too', async () => {
    const S = G.app.state;
    S.guilds.g1 = guildData(); S.currentGid = 'g1'; S.attention = { g1: { data: { total: 3 }, at: 1 } };
    const calls = [];
    await withApi({ put: (url, body) => { calls.push(['put', url, plain(body)]); return okRes({ ok: true }); }, post: (url, body) => { calls.push(['post', url, plain(body)]); return okRes({ ok: true, until: 1 }); } }, async probe => {
      const attrs = { 'data-pid': 'p_1', 'data-team': 't1', 'data-kind': 'promote', 'data-to': 'core', 'data-from': 'raider' };
      const button = el(attrs);
      G.handlers.click['rank-accept'](button);
      assert.equal(button.disabled, true, 'a second click does nothing');
      await settle();
      assert.deepEqual(calls[0], ['put', '/api/guild/g1/roster/p_1/rank', { teamId: 't1', rank: 'core', via: 'accept', expectedRank: 'raider' }]);
      assert.deepEqual(plain(probe.routed), [{ force: true }]);
      assert.equal(S.attention.g1, undefined, 'the Home count is read again');
      G.handlers.click['rank-accept'](el(Object.assign({}, attrs, { 'data-from': '' })));
      await settle();
      assert.equal(calls[1][2].expectedRank, null, 'a person with no stored rank');
      G.handlers.click['rank-dismiss'](el(attrs));
      await settle();
      assert.deepEqual(calls[2], ['post', '/api/guild/g1/roster/p_1/rank/dismiss', { teamId: 't1', kind: 'promote', to: 'core' }]);
    });
    // A conflict shows the Worker's words and reads again; another failure goes to the page alert.
    await withApi({ put: () => rejectWith(409, { error: 'conflict', message: 'Someone changed this rank. Reload and look again.' }) }, async probe => {
      const button = el({ 'data-pid': 'p_1', 'data-team': 't1', 'data-kind': 'promote', 'data-to': 'core', 'data-from': 'raider' });
      G.handlers.click['rank-accept'](button);
      await settle();
      assert.equal(S.pageAlert, 'Someone changed this rank. Reload and look again.');
      assert.deepEqual(plain(probe.routed), [{ force: true }]);
    });
    await withApi({ put: () => rejectWith(500, { error: 'server_error' }) }, async probe => {
      const button = el({ 'data-pid': 'p_1', 'data-team': 't1', 'data-kind': 'promote', 'data-to': 'core', 'data-from': '' });
      G.handlers.click['rank-accept'](button);
      await settle();
      assert.equal(button.disabled, false, 'the button comes back');
      assert.equal(probe.handled.length, 1);
    });
    S.pageAlert = '';
  });

  await check('person attendance page: the rank, a select of the ladder with Set rank (for whoever reviews a team of theirs), and the suggestion with its reasons; a member sees only the rank', async () => {
    const gd = guildData();
    const data = {
      person: { id: 'p_9', name: 'Cora', class: 'MAGE', status: 'raider', joinedOn: '2026-09-01', isMe: false, rank: { id: 'raider', name: 'Raider', set: true, on: '2026-10-01' },
        rankChoices: [{ id: 'member', name: 'Member' }, { id: 'raider', name: 'Raider' }, { id: 'core', name: 'Core' }], rankTeamId: 't1' },
      teams: [{ team: { id: 't1', name: 'Alpha' }, window: 8, metrics: {}, cells: [], rankSuggestion: SUGGEST_REVIEW }],
    };
    const out = G.pages.personAtt.personAttHtml({ guildData: gd, pid: 'p_9', data });
    assert(/<select class="gs-input gs-input-short" id="pa-rank"/.test(out) && /<option value="raider" selected>Raider<\/option>/.test(out) && out.includes('<option value="core">Core</option>'));
    assert(/data-action="rank-set" data-pid="p_9" data-team="t1" data-from="raider"/.test(out) && text(out).includes('Set rank'));
    assert(text(out).includes('Suggested: review (below Raider)') && text(out).includes('attendance 25% (the rank asks 75%)'));
    assert(/<label class="gs-label" for="pa-rank">Rank<\/label>/.test(out));
    const member = G.pages.personAtt.personAttHtml({ guildData: gd, pid: 'p_9', data: { person: Object.assign({}, data.person, { rankTeamId: null }), teams: [{ team: { id: 't1', name: 'Alpha' }, window: 8, metrics: {}, cells: [] }] } });
    assert(text(member).includes('Raider') && !member.includes('rank-set') && !member.includes('pa-rank"'), 'no way to change it');
    const none = G.pages.personAtt.personAttHtml({ guildData: gd, pid: 'p_9', data: { person: { id: 'p_9', name: 'Cora', status: 'raider' }, teams: [] } });
    assert(!none.includes('gs-rank-box'), 'no ladder, no box');
    // Set rank by hand.
    const S = G.app.state;
    S.guilds.g1 = gd; S.currentGid = 'g1';
    fields['pa-rank'] = { value: 'core' };
    const calls = [];
    await withApi({ put: (url, body) => { calls.push([url, plain(body)]); return okRes({ ok: true }); } }, async probe => {
      G.handlers.click['rank-set'](el({ 'data-pid': 'p_9', 'data-team': 't1', 'data-from': 'raider' }));
      await settle();
      assert.deepEqual(calls, [['/api/guild/g1/roster/p_9/rank', { teamId: 't1', rank: 'core', via: 'manual', expectedRank: 'raider' }]]);
      assert.equal(probe.routed.length, 1);
    });
    clearFields();
    assertNoRawAttrs(out);
  });

  await check('Home (round 4): rank suggestions are no to-do kind any more; the Guild box counts them ("N rank suggestions" -> Attendance, where the Ranks card is)', () => {
    const A = G.pages.attention;
    const kinds = A.KINDS.map(k => k.id);
    assert(!kinds.includes('rank') && !kinds.includes('watch'), 'the watch list and the rank suggestions left Home');
    const out = A.attentionHtml({ guildData: guildData(), data: { today: '2027-01-15', total: 0, items: [], more: {}, counts: { t1: { watchOpen: 0, rankOpen: 2 }, t2: { watchOpen: 0, rankOpen: 1 } }, week: [], hidden: [] } });
    assert(text(out).includes('3 rank suggestions'), 'summed over the teams');
    assert(out.includes('href="#/g/g1/attendance" aria-label="Open Ranks (3 rank suggestions)"><span>Open Ranks</span>'), 'a button to where they are handled');
    const none = A.attentionHtml({ guildData: guildData(), data: { today: '2027-01-15', total: 0, items: [], more: {}, counts: { t1: { watchOpen: 1, rankOpen: 0 } }, week: [], hidden: [] } });
    assert(!text(none).includes('rank suggestion'), 'no suggestions, no row');
  });

  // ladder editor on Guild settings > Attendance
  const policyView = (ranks) => ({
    defaults: DEFAULT_POLICY, guild: ranks ? { ladder: { ranks } } : {}, teams: {}, resolved: {}, versions: { guild: 2, teams: {} }, resetDayDerived: 2, wcl: { guildId: null, uploaders: {} },
  });
  const STARTER = [{ id: 'member', name: 'Member', rules: {} }, { id: 'raider', name: 'Raider', rules: { minAttendance: 0.75, minWeeksAttended: 2, since: 'join' } }];
  const settingsState = (ranks, scope = 'guild') => {
    const view = policyView(ranks);
    return { gid: 'g1', view, scope, draft: JSON.parse(JSON.stringify(scope === 'guild' ? view.guild : {})), wclUi: null, stale: 0 };
  };

  await check('Attendance settings: the rank ladder editor - empty, started, with the rules of each rank; the ladder belongs to the guild default only', () => {
    const gd = guildData();
    const empty = G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(null) });
    assert(/id="pg-ladder">Rank ladder</.test(empty) && empty.includes('data-action="pol-rank-start"') && text(empty).includes('No ladder yet.'));
    const out = G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(STARTER) });
    assert((out.match(/<li class="gs-rank-row">/g) || []).length === 2);
    assert(text(out).includes('Everyone starts here.') && text(out).includes('To earn Raider, a person needs all of these that are set'));
    assert(/id="pr-minAttendance-1"[^>]*value="75"/.test(out) && /id="pr-minWeeksAttended-1"[^>]*value="2"/.test(out) && /id="pr-minRaids-1"[^>]*value=""/.test(out) && /placeholder="Off"/.test(out));
    assert(/<option value="join" selected>When they joined<\/option>/.test(out) && out.includes('When they got the rank before this one'));
    assert(!/id="pr-minAttendance-0"/.test(out), 'the first rank has no rules');
    assert(/aria-label="Move Member down"/.test(out) && /aria-label="Move Member up"[^>]*disabled/.test(out) && /aria-label="Remove Member"[^>]*disabled/.test(out), 'two ranks at least');
    assert(out.includes('data-action="pol-rank-add"') && out.includes('data-action="pol-rank-off"'));
    assert(/for="pr-n-0"/.test(out) && /for="pr-minRaids-1"/.test(out), 'labels for the controls');
    const six = Array.from({ length: 6 }, (_, i) => ({ id: 'rank' + String.fromCharCode(97 + i), name: 'R' + i, rules: {} }));
    assert(/data-action="pol-rank-add"[^>]*disabled/.test(G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(six) })), 'six at most');
    const team = G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(STARTER, 't1') });
    assert(text(team).includes('The rank ladder belongs to the whole guild') && !team.includes('pol-rank-add'), 'a team override does not edit it');
    assertNoRawAttrs(out);
  });

  await check('ladder editor handlers: start, add, rename, set a rule (empty = off, percent -> fraction), move, remove, turn off; and Save sends the whole ladder', async () => {
    const S = G.app.state;
    S.guilds.g1 = guildData(); S.currentGid = 'g1';
    const a = G.pages.attendance.attState();
    a.settingsAtt = settingsState(null);
    const s = a.settingsAtt;
    const savedRender = G.app.render;
    G.app.render = () => {};
    const savedFocus = G.ui.focusByKey;
    G.ui.focusByKey = () => {};
    const ranks = () => plain(s.draft.ladder && s.draft.ladder.ranks);
    try {
      G.handlers.click['pol-rank-start'](el({}));
      assert.deepEqual(ranks(), STARTER);
      G.handlers.click['pol-rank-add'](el({}));
      assert.deepEqual(ranks()[2], { id: 'rank', name: 'New rank', rules: { since: 'join' } });
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'name' }), { value: '  Core Raider  ' }));
      assert.equal(ranks()[2].name, 'Core Raider', 'the id stays');
      assert.equal(ranks()[2].id, 'rank');
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'minRaids' }), { value: '8' }));
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'since' }), { value: 'rank' }));
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'minAttendance' }), { value: '90' }));
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'maxMissed' }), { value: '99999' }));
      assert.deepEqual(ranks()[2].rules, { since: 'rank', minRaids: 8, minAttendance: 0.9, maxMissed: 100 }, 'clamped to what the Worker takes');
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'minRaids' }), { value: '' }));
      assert.equal(ranks()[2].rules.minRaids, null, 'an empty box turns the rule off');
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'name' }), { value: '   ' }));
      assert.equal(ranks()[2].name, 'Core Raider', 'a blank name changes nothing');
      G.handlers.click['pol-rank-move'](el({ 'data-idx': '2', 'data-dir': '-1', 'data-key': 'pr-up-2' }));
      assert.deepEqual(ranks().map(r => r.id), ['member', 'rank', 'raider']);
      G.handlers.click['pol-rank-remove'](el({ 'data-idx': '1' }));
      assert.deepEqual(ranks().map(r => r.id), ['member', 'raider']);
      G.handlers.click['pol-rank-remove'](el({ 'data-idx': '1' }));
      assert.equal(ranks().length, 2, 'two ranks are the least');
      // Save: the guild default stores only the differences; the ladder is one value.
      const sent = [];
      const form = Object.assign(formEl({}), { querySelectorAll: () => [] });
      field('pol-error');
      await withApi({ put: (url, body) => { sent.push([url, plain(body)]); return Promise.reject(new G.api.ApiError(500, { error: 'server_error' })); } }, async () => {
        G.handlers.submit['pol-form'](form);
        await settle();
      });
      assert.equal(sent[0][0], '/api/guild/g1/attendance/policy');
      assert.deepEqual(sent[0][1].policy, { ladder: { ranks: STARTER } });
      assert.equal(sent[0][1].teamId, null);
      assert.equal(sent[0][1].expectedVersion, 2);
      G.handlers.click['pol-rank-off'](el({}));
      assert.deepEqual(ranks(), []);
      // In a team scope the handlers do nothing.
      s.scope = 't1'; s.draft = {};
      G.handlers.click['pol-rank-start'](el({}));
      assert.deepEqual(s.draft, {});
    } finally {
      G.app.render = savedRender; G.ui.focusByKey = savedFocus; a.settingsAtt = null; clearFields();
    }
  });

  await check('wave 7 wiring: the new scripts are in the manifest after the pages they extend; no inline styles or handlers; the styles exist', () => {
    const manifest = GUILD_SCRIPTS.map(s => s.replace('/js/guild/', ''));
    for (const [file, after] of [['pages-progress.js', 'pages-raids.js'], ['pages-ranks.js', 'pages-person-attendance.js']]) {
      assert(manifest.indexOf(file) > manifest.indexOf(after) && manifest.indexOf(file) < manifest.indexOf('app.js'), file);
    }
    for (const cls of ['gs-prog-board', 'gs-table-prog', 'gs-rank-line', 'gs-rank-suggest', 'gs-rank-list', 'gs-rank-row', 'gs-rank-rules', 'gs-rank-rule', 'gs-rank-set']) assert(css.includes('.' + cls), cls);
    for (const file of ['pages-progress.js', 'pages-ranks.js']) assert(!/\sstyle=|\sonclick=/.test(read('js/guild/' + file)), file);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
