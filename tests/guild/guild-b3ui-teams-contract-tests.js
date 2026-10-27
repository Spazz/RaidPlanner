/**
 * Raidsmith guild UI, lane B3 UI - CONTRACT test (Worker <-> page) for Request team and "This is me"
 * Run: node tests/guild/guild-b3ui-teams-contract-tests.js
 *
 * The real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in, the guild world of
 * tests/guild-b3-world.js) through G.api, one page set per signed-in person:
 *   - a member asks for a team through the page's own Send request handler; the person page shows "Requested Bravo" with Withdraw, the Team Lead's Home and Roster
 *     show the row, the Roster badge counts it, Approve (the page's handler) places the character and the member's page shows the team;
 *   - a member with no roster entry finds an unlinked record through My characters, This is me sends it, the officer's Home shows the ask, Approve links it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runChecks, scenario } = require('../guild-b3-world');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = require('path').join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&middot;/g, '.').replace(/\s+/g, ' ').trim();
const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

// One page set for one signed-in person: the real scripts, G.api routed to the Worker with that person's session.
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
const form = (picks) => ({ querySelector: (sel) => { const m = /input\[name="(\w+)"\]:checked/.exec(sel); return m && picks[m[1]] ? { value: picks[m[1]] } : null; }, querySelectorAll: () => [], closest: () => null, elements: {} });
const el = (attrs) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null });

async function openGuild(p) {
  const { G, state, gid } = p;
  state.currentGid = gid;
  state.guilds[gid] = await G.api.get(`/api/guild/${gid}`);
  return state.guilds[gid];
}
async function openPerson(p, pid) {
  const { G, state, gid } = p;
  const record = await G.api.get(`/api/guild/${gid}/roster/${pid}`);
  state.person = { gid, pid, record };
  await G.pages.teamRequests.read(gid);
  return record;
}
const personHtml = (p) => p.G.pages.person.personHtml({ guildData: p.state.guilds[p.gid], record: p.state.person.record, linkable: [], alert: '', requests: p.G.pages.teamRequests.bucketOf(p.gid) });

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('Request team end to end: the member sends it from the page, sees Requested on the row and Withdraw; the Team Lead decides on Home and the Roster; the badge and the person page follow', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, bravo, charlie] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.lead('tlb', [bravo], 'Leadbravo');
  await s.member('m1', 'Memberone');
  const main = await s.person({ name: 'Askmain' });
  await s.link(main.pid, 'm1');
  const altId = await s.alt(main.pid, 'Askalt');
  const m = pagesFor(s, 'm1');
  await openGuild(m);
  let record = await openPerson(m, main.pid);
  let html = personHtml(m);
  assert(html.includes('data-action="team-request-open"'), 'the head button');
  assert(stripTags(html).includes('No team'), 'the teamless alt says so');
  // open the dialog and send
  m.G.handlers.click['team-request-open']();
  assert.equal(m.shown.dialogs.length, 1);
  const dialog = stripTags(m.shown.dialogs[0]);
  assert(dialog.includes('Askalt') && dialog.includes('Bravo 0 people') && dialog.includes('Charlie 0 people') && !dialog.includes('Alpha'), dialog);
  m.G.handlers.submit['team-request-form'](form({ characterId: altId, teamId: bravo }));
  await settle();
  html = personHtml(m);
  assert(stripTags(html).includes('Requested Bravo') && html.includes('data-action="team-request-withdraw"'));
  assert(!html.includes('data-action="team-request-open"'), 'its only teamless character has a request waiting');
  // the same request twice is the Worker's 409
  const again = await s.call('m1', 'POST', '/team-requests', { characterId: altId, teamId: charlie });
  assert.deepEqual([again.status, again.json.error], [409, 'request_pending']);

  // the Team Lead's Home and Roster
  const lead = pagesFor(s, 'tlb');
  const leadGuild = await openGuild(lead);
  assert.deepEqual(plain(leadGuild.teamRequestFlags), { [bravo]: 1 }, 'the guild payload carries the count the Roster badge adds');
  assert.equal(lead.G.shell.rosterBadge(leadGuild, bravo), 1);
  await lead.G.pages.attention.load({ name: 'section', gid: s.gid, section: 'home' }, leadGuild);
  const home = lead.G.pages.attention.main({}, leadGuild, {});
  assert(stripTags(home).includes('Askalt asks to join') && stripTags(home).includes('From Askmain') && home.includes('data-action="team-request-approve"'), stripTags(home).slice(0, 600));
  assert.equal(lead.G.app.attentionCountFor(s.gid), 1, 'the Home count is the one request');
  const roster = await lead.G.api.get(`/api/guild/${s.gid}/roster?team=${bravo}`);
  lead.state.roster = { gid: s.gid, teamId: bravo, data: roster };
  const rosterHtml = lead.G.pages.roster.rosterHtml({ guildData: leadGuild, data: roster, view: { status: 'active', query: '' }, shape: { status: 'loading' }, apps: null, requests: lead.G.pages.teamRequests.pendingOf(s.gid, bravo) });
  assert.equal(roster.people.length, 0);
  // Bravo has nobody yet: the Needs you panel still shows the request on the empty roster page
  assert(stripTags(rosterHtml).includes('Askalt asks to join'), 'the request shows on the Roster of its team, also while the team has no people');
  // Approve through the Home page's own handler
  const pending = lead.G.pages.teamRequests.pendingOf(s.gid)[0];
  await lead.G.handlers.click['team-request-approve'](el({ 'data-trid': pending.id, 'data-gid': s.gid, 'data-ctx': 'home' }));
  await settle();
  assert.equal(await s.teamOf(altId), bravo, 'the character is on Bravo now');
  assert.deepEqual(plain(lead.state.guilds[s.gid].teamRequestFlags), { [bravo]: 0 });
  assert.equal(lead.G.app.attentionCountFor(s.gid), 0, 'the Home count dropped');
  assert(!stripTags(lead.G.pages.attention.main({}, lead.state.guilds[s.gid], {})).includes('asks to join'));

  // the member's page: the row shows the team, no Withdraw, no more Request team (Charlie is still free but no character is)
  record = await openPerson(m, main.pid);
  html = personHtml(m);
  assert(stripTags(html).includes('Askalt') && /Askalt[\s\S]*?Bravo/.test(stripTags(html)) && !html.includes('team-request-withdraw') && !html.includes('team-request-open'));
});

check('Request team: rejecting leaves the character on no team and the row says No team again; Withdraw does the same; a lead of another team sees nothing of it', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  const [alpha, bravo] = s.tids;
  await s.lead('tla', [alpha], 'Leadalpha');
  await s.lead('tlb', [bravo], 'Leadbravo');
  await s.member('m1', 'Memberone');
  const main = await s.person({ name: 'Askmain' });
  await s.link(main.pid, 'm1');
  const altId = await s.alt(main.pid, 'Askalt');
  const m = pagesFor(s, 'm1');
  await openGuild(m);
  await openPerson(m, main.pid);
  m.G.handlers.submit['team-request-form'](form({ characterId: altId, teamId: bravo }));
  await settle();
  assert(stripTags(personHtml(m)).includes('Requested Bravo'));
  // Alpha's lead decides nothing about Bravo's request
  const other = pagesFor(s, 'tla');
  await openGuild(other);
  await other.G.pages.teamRequests.read(s.gid);
  assert.deepEqual(other.G.pages.teamRequests.pendingOf(s.gid), []);
  // Bravo's lead rejects through the Roster handler
  const lead = pagesFor(s, 'tlb');
  const leadGuild = await openGuild(lead);
  await lead.G.pages.teamRequests.read(s.gid);
  lead.state.roster = { gid: s.gid, teamId: bravo, data: { people: [], team: { id: bravo, name: 'Bravo' }, can: { edit: true } } };
  const request = lead.G.pages.teamRequests.pendingOf(s.gid, bravo)[0];
  await lead.G.handlers.click['team-request-reject'](el({ 'data-trid': request.id, 'data-gid': s.gid, 'data-ctx': 'roster' }));
  await settle();
  assert.equal(await s.teamOf(altId), null);
  assert.deepEqual(lead.G.pages.teamRequests.pendingOf(s.gid), []);
  await openPerson(m, main.pid);
  let html = personHtml(m);
  assert(stripTags(html).includes('No team') && !html.includes('Requested') && html.includes('team-request-open'), 'asking again is possible');
  // ask again, then withdraw from the page
  m.G.handlers.submit['team-request-form'](form({ characterId: altId, teamId: bravo }));
  await settle();
  const mine = m.G.pages.teamRequests.mineOf(s.gid).filter((r) => r.status === 'pending');
  assert.equal(mine.length, 1);
  await m.G.handlers.click['team-request-withdraw'](el({ 'data-trid': mine[0].id }));
  await settle();
  html = personHtml(m);
  assert(stripTags(html).includes('No team') && !html.includes('team-request-withdraw'));
  assert.equal((await s.rows("SELECT status FROM team_requests ORDER BY created_at")).map((r) => r.status).join(','), 'rejected,withdrawn');
});

check('This is me end to end: a member with no roster entry finds the unlinked record on My characters, sends it, waits, withdraws and sends again; the officer approves on Home and the record is theirs', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  const [alpha, bravo] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  const marrow = await s.person({ name: 'Marrowind', class: 'MAGE', mainSpec: 'Frost' });
  await s.person({ name: 'Marrowyn', class: 'PRIEST', mainSpec: 'Holy', teamId: bravo });
  const m = pagesFor(s, 'm1');
  const bnet = await m.G.pages.bnet.load();
  assert.equal(bnet.guilds[0].battlenetOnly, false);
  assert.equal(bnet.link, null, 'no Battle.net connected');
  await m.G.pages.thisIsMe.loadFor(bnet);
  const page = m.G.pages.bnet.charactersHtml({ data: bnet });
  assert.equal(bnet.configured, false, 'this world has no Battle.net client: the page still opens with the block');
  assert(page.includes('data-input="tim-search"') && page.includes('id="bnet-not-set-up"'), 'the block renders without Battle.net');
  // type a name: the Enter path asks at once
  m.G.handlers.submit['tim-search']({ getAttribute: () => s.gid, elements: { name: { value: 'Marrow' } } });
  await settle();
  const results = m.G.pages.thisIsMe.resultsHtml(s.gid, m.G.pages.thisIsMe.stateOf(s.gid));
  assert(stripTags(results).includes('Marrowind Frost Mage - Alpha') && stripTags(results).includes('Marrowyn Holy Priest - Bravo'), stripTags(results));
  // This is me on Marrowind
  const button = el({ 'data-gid': s.gid, 'data-name': 'Marrowind', 'data-class': 'MAGE', 'data-spec': 'Frost', 'data-realm': '' });
  await m.G.handlers.click['tim-claim'](button);
  await settle();
  assert.equal(m.state.bnet.notice, 'Marrowind is on the roster and nobody has linked it, so an officer has to confirm it is yours. Nothing changes until one does.');
  const waiting = m.G.pages.thisIsMe.stateOf(s.gid).waiting;
  assert.deepEqual(waiting.map((w) => [w.name, w.mainSpec, w.team && w.team.name]), [['Marrowind', 'Frost', 'Alpha']]);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', marrow.pid)).user_id, null, 'nothing is linked yet');
  assert(stripTags(m.G.pages.bnet.charactersHtml({ data: m.state.bnet.data })).includes('Marrowind Frost Mage - Alpha Needs an officer Withdraw'));

  // the officer's Home: the ask is a row, the count is on Home only
  const o = pagesFor(s, 'o1');
  const og = await openGuild(o);
  await o.G.pages.attention.load({ name: 'section', gid: s.gid, section: 'home' }, og);
  let home = o.G.pages.attention.main({}, og, {});
  const t = stripTags(home);
  assert(t.includes('This is me') && t.includes('Memberone says Marrowind is theirs') && t.includes('Frost Mage - Raider') && t.includes("Approving links this record to Memberone's account."), t.slice(0, 900));
  assert.equal(o.G.app.attentionCountFor(s.gid), 1);
  assert.equal(o.G.shell.badgesOf(og, alpha).attendance, 0, 'not on the Attendance badge');
  assert(!t.includes('character claim is waiting') && !t.includes('character claims are waiting'));
  // m1 withdraws; the row is gone for the officer; m1 sends again
  const claimId = waiting[0].id;
  await m.G.handlers.click['tim-withdraw'](el({ 'data-gid': s.gid, 'data-claim': claimId, 'data-name': 'Marrowind' }));
  await settle();
  assert.deepEqual(m.G.pages.thisIsMe.stateOf(s.gid).waiting, []);
  await o.G.pages.attention.load({ name: 'section', gid: s.gid, section: 'home' }, og);
  assert(!stripTags(o.G.pages.attention.main({}, og, {})).includes('says Marrowind is theirs'));
  await m.G.handlers.click['tim-claim'](el({ 'data-gid': s.gid, 'data-name': 'Marrowind', 'data-class': 'MAGE', 'data-spec': 'Frost', 'data-realm': '' }));
  await settle();
  await o.G.pages.attention.load({ name: 'section', gid: s.gid, section: 'home' }, og);
  assert(stripTags(o.G.pages.attention.main({}, og, {})).includes('Memberone says Marrowind is theirs'));
  // Approve through the page's handler
  const ask = o.G.pages.thisIsMe.asksFor(s.gid).asks[0];
  await o.G.handlers.click['this-is-me-approve'](el({ 'data-claim': ask.id, 'data-gid': s.gid }));
  await settle();
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', marrow.pid)).user_id, s.uids.m1, 'the record is theirs');
  assert.equal(o.G.app.attentionCountFor(s.gid), 0);
  assert(!stripTags(o.G.pages.attention.main({}, og, {})).includes('says Marrowind is theirs'));
  // and the member no longer finds it (it is theirs)
  await m.G.pages.thisIsMe.loadFor(await m.G.pages.bnet.load());
  assert.deepEqual(m.G.pages.thisIsMe.stateOf(s.gid).waiting, []);
  const gone = await s.call('m2', 'GET', '/roster/unlinked?q=marrowind');
  assert.deepEqual(gone.json.matches, [], 'a linked person is not offered to anyone');
});

check('This is me: a claim that needs more than one click (the member already has a person) stays a count line on Home that opens the Review queue; a refusal is said in the block', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  const own = await s.person({ name: 'Ownmain' });
  await s.link(own.pid, 'm1');
  await s.person({ name: 'Marrowind', class: 'MAGE', mainSpec: 'Frost' });
  const m = pagesFor(s, 'm1');
  const bnet = await m.G.pages.bnet.load();
  await m.G.pages.thisIsMe.loadFor(bnet);
  m.G.handlers.submit['tim-search']({ getAttribute: () => s.gid, elements: { name: { value: 'Marrowind' } } });
  await settle();
  await m.G.handlers.click['tim-claim'](el({ 'data-gid': s.gid, 'data-name': 'Marrowind', 'data-class': 'MAGE', 'data-spec': 'Frost', 'data-realm': '' }));
  await settle();
  const o = pagesFor(s, 'o1');
  const og = await openGuild(o);
  await o.G.pages.attention.load({ name: 'section', gid: s.gid, section: 'home' }, og);
  const home = stripTags(o.G.pages.attention.main({}, og, {}));
  assert(home.includes('1 character claim is waiting') && !home.includes('says Marrowind is theirs'), 'a conflict (other_person) cannot be approved in one click');
  assert.equal(o.G.app.attentionCountFor(s.gid), 1);
  // typing a name on a linked person is refused and the block says so
  await s.person({ name: 'Takenmain' });
  const owner = await s.one("SELECT id FROM players WHERE id = (SELECT player_id FROM characters WHERE name = 'Takenmain')");
  await s.member('m3', 'Memberthree');
  await s.link(owner.id, 'm3');
  const block = el({ 'data-gid': s.gid, 'data-name': 'Takenmain', 'data-class': 'MAGE', 'data-spec': '', 'data-realm': '' });
  await m.G.handlers.click['tim-claim'](block);
  await settle();
  assert.equal(block.disabled, false);
  assert(/belongs to|someone else|taken/i.test(m.G.pages.thisIsMe.stateOf(s.gid).error), m.G.pages.thisIsMe.stateOf(s.gid).error);
});

runChecks(checks);
