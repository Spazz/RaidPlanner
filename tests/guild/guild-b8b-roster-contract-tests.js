/**
 * Raidsmith guild UI, lane roster of B8b - CONTRACT test (Worker <-> page) for Add to team, Manage team, Remove from team and the person record
 * Run: node tests/guild/guild-b8b-roster-contract-tests.js
 *
 * The real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in, the guild world of tests/guild-b3-world.js)
 * through G.api, one page set per signed-in person:
 *   - an officer's Add to team lists the characters that can go on the team (no Social, no Former, nobody who already holds a character there), the pick says what the placement does,
 *     Add puts the character on the team and approves its waiting request in the same step (Needs you is empty, the badge drops);
 *   - a Team Lead's Manage team lists the team's placed Social / Former characters (Off the roster), ticks across both lists, asks about the sign-ups, sends ONE release per character and
 *     shows the answer: the Officer's character is refused by the Seniority guard with the API's own sentence, the rest left the team;
 *   - the person record offers Remove from team exactly for the characters the viewer may release (the Worker's mayRelease), and releasing from there updates the record.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runChecks, scenario } = require('../guild-b3-world');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = require('path').join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&middot;/g, String.fromCharCode(183)).replace(/\s+/g, ' ').trim();
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 14; i++) await tick(); };

function pagesFor(s, who) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  const els = {};
  sandbox.document = { getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  const f = async (urlPath, init = {}) => {
    s.w.advance(2000);
    return s.w.req(init.method || 'GET', urlPath, { jar: s.jars[who], rawBody: init.body });
  };
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  const shown = { dialogs: [] };
  G.ui.openDialog = (html) => { shown.dialogs.push(html); return null; };
  G.app.requireSignin = () => { throw new Error('the page was sent to sign-in'); };
  G.app.showFailure = (title, text) => { throw new Error('failure page: ' + title + ' ' + text); };
  return { G, els, shown, state: G.app.state, gid: s.gid };
}
const formOf = (over) => Object.assign({ querySelector: () => null, querySelectorAll: () => [], closest: () => null, elements: {} }, over || {});
const box = (checked) => ({ checked });

async function openGuild(p) {
  const { G, state, gid } = p;
  state.currentGid = gid;
  state.guilds[gid] = await G.api.get(`/api/guild/${gid}`);
  return state.guilds[gid];
}
// The Roster of a team as the page holds it: the read, the requests, the page state.
async function openRoster(p, teamId) {
  const { G, state, gid } = p;
  const data = await G.api.get(`/api/guild/${gid}/roster?team=${teamId}`);
  state.roster = { gid, teamId, data };
  await G.pages.teamRequests.read(gid);
  return data;
}
const rosterHtml = (p) => p.G.pages.roster.rosterHtml({
  guildData: p.state.guilds[p.gid], data: p.state.roster.data, view: { status: 'everyone', query: '' }, shape: { status: 'loading' }, apps: null,
  requests: p.G.pages.teamRequests.pendingOf(p.gid, p.state.roster.teamId), manage: p.state.rosterManage && p.state.rosterManage.teamId === p.state.roster.teamId ? p.state.rosterManage : null,
});

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const SENIOR = 'That person\'s account ranks the same as you or above you, so only someone more senior can change them.';

async function world() {
  const s = await scenario({ teams: ['Team KJ', 'Sunday Alts'] });
  const [kj, sunday] = s.tids;
  Object.assign(s, { kj, sunday });
  await s.officer('o1', 'Officerone');
  await s.lead('tl', [kj], 'Leadkj');
  await s.member('m1', 'Memberone');
  // On Team KJ: Fenwick (a Raider; his alt Wickwood is on Sunday Alts) and Ashgrove (the Officer's own person).
  s.fen = await s.person({ name: 'Fenwick', class: 'WARRIOR', mainSpec: 'Protection', teamId: kj });
  s.wick = await s.alt(s.fen.pid, 'Wickwood', { class: 'PRIEST', mainSpec: 'Holy' });
  await s.ok('gm', 'PUT', `/roster/${s.fen.pid}/characters/${s.wick}/team`, { teamId: sunday }, 200);
  s.ash = await s.person({ name: 'Ashgrove', class: 'DRUID', mainSpec: 'Balance', teamId: kj });
  await s.link(s.ash.pid, 'o1');
  // Placed on Team KJ but on no roster view: Aldwyn is Social, Fallowick Former.
  s.ald = await s.person({ name: 'Aldwyn', class: 'PALADIN', mainSpec: 'Holy', teamId: kj });
  s.exec(`UPDATE characters SET core_rank = 'social' WHERE id = '${s.ald.cid}'`);
  s.fal = await s.person({ name: 'Fallowick', class: 'HUNTER', mainSpec: 'Survival', teamId: kj });
  s.exec(`UPDATE characters SET core_rank = 'social', left_on = '2026-10-02', left_reason = 'left' WHERE id = '${s.fal.cid}'`);
  return s;
}

check('Add to team: the list leaves out Social and Former characters and the people who already have a character on the team; the pick explains the placement; Add places it and approves its waiting request', async () => {
  const s = await world();
  const { kj } = s;
  // Candidates: Pellan (a Trial with a request for Team KJ), Tamsin (a Raider), Socialite (Social), and Wickwood's person (Fenwick) already holds Team KJ.
  const pellan = await s.person({ name: 'Pellan', class: 'MAGE', mainSpec: 'Fire', teamId: null });
  s.exec(`UPDATE characters SET core_rank = 'trial', trial_end = NULL WHERE id = '${pellan.cid}'`);
  await s.member('m2', 'Membertwo');
  await s.link(pellan.pid, 'm2');
  await s.ok('m2', 'POST', '/team-requests', { characterId: pellan.cid, teamId: kj }, 201);
  await s.person({ name: 'Tamsin', class: 'ROGUE', mainSpec: 'Combat', teamId: null });
  const soc = await s.person({ name: 'Socialite', class: 'MAGE', mainSpec: 'Frost', teamId: null });
  s.exec(`UPDATE characters SET core_rank = 'social' WHERE id = '${soc.cid}'`);
  await s.alt(s.fen.pid, 'Fenalt', { class: 'MAGE', mainSpec: 'Arcane' });

  const o = pagesFor(s, 'o1');
  await openGuild(o);
  const data = await openRoster(o, kj);
  assert.deepEqual(plain(data.rankSegments), ['raider']);
  const before = stripTags(rosterHtml(o));
  assert(before.includes('Fenwick') && before.includes('Ashgrove') && !before.includes('Aldwyn') && !before.includes('Fallowick'), 'Social and Former are on no roster view');
  assert(stripTags(rosterHtml(o)).includes('Pellan asks to join'), 'the request waits in Needs you');

  o.G.handlers.click['roster-add-team']();
  await settle();
  assert.equal(o.shown.dialogs.length, 1);
  const dialog = o.G.pages.rosterTeam.addDialogHtml(Object.assign({}, { gid: s.gid, teamId: kj, teamName: 'Team KJ', trialDays: 14, today: data.today, status: 'ready', more: false, q: '', picked: null, error: '' },
    { list: (await o.G.api.get(`/api/guild/${s.gid}/roster/unassigned?team=${kj}`)).characters }));
  const text = stripTags(dialog);
  assert(text.includes('Pellan') && text.includes('Tamsin') && !text.includes('Socialite') && !text.includes('Aldwyn') && !text.includes('Fallowick'), 'no Social, no Former');
  assert(!text.includes('Fenalt') && !text.includes('Wickwood'), 'Fenwick already has a character on Team KJ');
  assert(/Pellan[^A-Za-z]+Fire Mage[^A-Za-z]+asked for Team KJ Trial/.test(text), text);
  // The page's own state: the dialog opened with the list read for THIS team.
  assert(o.G.app.state.roster.teamId === kj);
  // Pick Pellan and Add.
  o.G.handlers.change['team-add-pick']({ value: pellan.cid });
  const what = stripTags(o.G.pages.rosterTeam.addDialogHtml({ gid: s.gid, teamId: kj, teamName: 'Team KJ', trialDays: 14, today: data.today, status: 'ready', more: false, q: '', picked: pellan.cid,
    list: (await o.G.api.get(`/api/guild/${s.gid}/roster/unassigned?team=${kj}`)).characters, error: '' }));
  assert(what.includes('Starts today, ends') && what.includes('Pellan\'s request for Team KJ is approved'));
  o.G.handlers.submit['team-add-form'](formOf());
  await settle();
  assert.equal(await s.teamOf(pellan.cid), kj);
  const req = await s.one('SELECT status, decided_by FROM team_requests WHERE character_id = ?', pellan.cid);
  assert.deepEqual([req.status, req.decided_by], ['approved', s.uids.o1], 'the placement approved the request');
  assert.equal(o.state.rosterNotice, 'Added Pellan to Team KJ and approved their request.');
  assert.deepEqual(plain(o.G.pages.teamRequests.pendingOf(s.gid, kj)), [], 'Needs you is empty');
  assert(o.state.roster.data.people.some((p) => p.shown.name === 'Pellan'), 'the list was read again');
  const row = o.state.roster.data.people.find((p) => p.shown.name === 'Pellan');
  assert.deepEqual([row.shown.coreRank, typeof row.shown.trialEnd, row.shown.trialFlag], ['trial', 'string', null], 'a Trial: the placement started its clock (ends in 14 days, so no flag yet)');
  assert.equal(o.state.guilds[s.gid].teamRequestFlags[kj], 0, 'the badge dropped');
});

check('Manage team (a Team Lead): Off the roster lists the placed Social and Former characters; ticks across both lists; the Officer\'s character is refused with the API\'s sentence, the others leave; the skipped name stays ticked', async () => {
  const s = await world();
  const { kj } = s;
  const t = pagesFor(s, 'tl');
  await openGuild(t);
  await openRoster(t, kj);
  t.G.handlers.click['roster-manage']();
  await settle();
  const manage = t.state.rosterManage;
  assert.deepEqual(manage.off.list.map((c) => [c.name, c.kind, c.leftReason]), [['Aldwyn', 'social', null], ['Fallowick', 'former', 'left']]);
  const html = rosterHtml(t);
  assert(stripTags(html).includes('Off the roster 2') && html.includes('data-cid="' + s.ald.cid + '"') && html.includes('data-cid="' + s.fen.cid + '"'), 'both lists are tickable');
  assert(!/<a class="gs-rs-row/.test(html));
  // Tick Fenwick, Ashgrove (the Officer's person) and Aldwyn (Social) through the page's own change handler.
  const tickBox = (cid) => ({ checked: true, getAttribute: (k) => (k === 'data-cid' ? cid : null), closest: () => null });
  for (const cid of [s.fen.cid, s.ash.cid, s.ald.cid]) t.G.handlers.change['roster-tick'](tickBox(cid));
  assert.deepEqual(Object.keys(manage.ticked).sort(), [s.fen.cid, s.ash.cid, s.ald.cid].sort());
  // Remove from team: the sign-ups are read per character, then the confirm opens.
  t.G.handlers.click['roster-remove-open']();
  await settle();
  assert.equal(t.shown.dialogs.length, 1);
  const confirm = stripTags(t.shown.dialogs[0]);
  assert(confirm.includes('Remove 3 people from Team KJ?') && confirm.includes('Fenwick') && confirm.includes('Ashgrove') && confirm.includes('Aldwyn') && confirm.includes('No upcoming sign-ups'), confirm);
  t.G.handlers.submit['roster-remove-form'](formOf({ querySelector: (sel) => (/removeSignups/.test(sel) ? box(false) : null) }));
  await settle();
  assert.equal(await s.teamOf(s.fen.cid), null, 'Fenwick left the team');
  assert.equal(await s.teamOf(s.ald.cid), null, 'so did the Social character');
  assert.equal(await s.teamOf(s.ash.cid), s.kj, 'the Officer\'s character is still there');
  assert.equal(t.shown.dialogs.length, 2, 'the answer is a dialog');
  const answer = stripTags(t.shown.dialogs[1]);
  assert(answer.includes('Removed 2 of 3 people') && answer.includes('1 person was skipped.') && answer.includes('Fenwick Removed from Team KJ') && answer.includes('Aldwyn Removed from Team KJ') && answer.includes('Ashgrove ' + SENIOR), answer);
  assert.deepEqual(Object.keys(t.state.rosterManage.ticked), [s.ash.cid], 'the skipped name stays ticked, the removed leave the selection');
  assert.deepEqual(t.state.rosterManage.off.list.map((c) => c.name), ['Fallowick'], 'the Off the roster list was read again');
  assert.deepEqual(t.state.roster.data.people.map((p) => p.shown.name), ['Ashgrove'], 'and the roster');
  assert.equal((await s.rows("SELECT 1 FROM audit_log WHERE action = 'character.release'")).length, 2, 'one audit row per release, none for the refused one');
});

check('Manage team: a person who may not be released by this viewer and a member never get the mode; a former character can be removed on its own', async () => {
  const s = await world();
  const m = pagesFor(s, 'm1');
  await openGuild(m);
  await openRoster(m, s.kj);
  assert(!rosterHtml(m).includes('data-action="roster-manage"') && !rosterHtml(m).includes('Add to team'), 'a member: no Manage team, no Add to team');
  const off = await m.G.api.get(`/api/guild/${s.gid}/roster/off-roster?team=${s.kj}`).then(() => 'ok', (e) => e.status);
  assert.equal(off, 403);
  const o = pagesFor(s, 'o1');
  await openGuild(o);
  await openRoster(o, s.kj);
  o.G.handlers.click['roster-manage']();
  await settle();
  o.G.handlers.change['roster-tick']({ checked: true, getAttribute: (k) => (k === 'data-cid' ? s.fal.cid : null), closest: () => null });
  o.G.handlers.click['roster-remove-open']();
  await settle();
  assert(stripTags(o.shown.dialogs[0]).includes('Remove Fallowick from Team KJ?'));
  o.G.handlers.submit['roster-remove-form'](formOf({ querySelector: () => box(true) }));
  await settle();
  assert.equal(await s.teamOf(s.fal.cid), null);
  assert(stripTags(o.shown.dialogs[1]).includes('Removed Fallowick from Team KJ'));
  assert.equal(o.state.rosterManage, null, 'everything went through: the mode ends');
});

check('Person record: Remove from team is offered for the characters the viewer may release (mayRelease) and releasing from the record updates it; the Officer\'s record offers nothing to a Team Lead', async () => {
  const s = await world();
  const t = pagesFor(s, 'tl');
  await openGuild(t);
  const openPerson = async (pid) => {
    const record = await t.G.api.get(`/api/guild/${s.gid}/roster/${pid}`);
    t.state.person = { gid: s.gid, pid, record };
    return record;
  };
  const html = () => t.G.pages.person.personHtml({ guildData: t.state.guilds[s.gid], record: t.state.person.record, linkable: [], alert: '', requests: t.G.pages.teamRequests.bucketOf(s.gid) });
  let record = await openPerson(s.fen.pid);
  assert.deepEqual(record.characters.map((c) => [c.name, c.mayRelease, c.coreRank, c.inGameRank]), [['Fenwick', true, 'raider', null], ['Wickwood', false, 'raider', null]], 'the Team Lead of Team KJ releases Fenwick, not Wickwood on Sunday Alts');
  assert(html().includes('data-action="person-remove-team"') && stripTags(html()).includes('Raider'), 'the item and the rank per character');
  const officer = await openPerson(s.ash.pid);
  assert.deepEqual(officer.characters.map((c) => c.mayRelease), [false], 'the Seniority guard: the Officer\'s person is out of a Team Lead\'s reach');
  assert(!html().includes('person-remove-team'));
  record = await openPerson(s.fen.pid);
  t.G.handlers.click['person-remove-team']();
  await settle();
  assert.equal(t.shown.dialogs.length, 1);
  assert(stripTags(t.shown.dialogs[0]).includes('Remove Fenwick from Team KJ?'), 'one releasable character: the one-name confirm');
  t.G.handlers.submit['roster-remove-form'](formOf({ querySelector: () => box(false) }));
  await settle();
  assert.equal(await s.teamOf(s.fen.cid), null);
  assert.deepEqual(t.state.person.record.characters.map((c) => [c.name, c.team.id, c.mayRelease]), [['Fenwick', null, false], ['Wickwood', s.sunday, false]], 'the record on screen is the answer');
  assert(!html().includes('person-remove-team'), 'nothing left to release');
});

runChecks(checks);
