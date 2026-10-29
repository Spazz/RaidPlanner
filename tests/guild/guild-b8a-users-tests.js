/**
 * Raidsmith guild app - lane B8a-users: the Users page (list, user page, Manage users, Block, Add to a person, Edit permission with the Owner seat's hand-over) and the retirement of
 * Settings > Accounts.
 * Run: node tests/guild/guild-b8a-users-tests.js [name filter]
 *
 *   list ............ four segments with their counts, A-Z by default, four sortable heads (the Worker sorts: GET /users?sort=&dir=), the rank filter from the mapped core ranks, the Needs you
 *                     strip, phone rows, Show all, an error and an empty state
 *   user page ....... characters with rank, core rank and team; Permission with where each role comes from; the Keep / Restore decision of a block that waits for review; the More items
 *   Edit permission . pin true only for a ticked role the rank gives; the Owner seat section; the hand-over (fresh sign-in step, recipient_not_live, { handedOver: true }, the repeat)
 *   Manage users .... selection mode (no box on your own row), Block in chunks of 25 with a result dialog of messages, Unblock, Add to a person (hand-set guilds only, a class per name)
 *   Accounts ........ both old addresses land on Users; the Accounts page is gone
 *   Worker .......... personId, battlenetOnly, ownerSeat and coreRanks, the skip messages, the block_review link; the real answers drive the real renderers
 * The UI half loads the shared guild script list into a vm with fake documents (as the other UI suites); the Worker half drives worker/index.js over the D1 stand-in.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runChecks, scenario: baseScenario } = require('../guild-b3-world');
const { ingameize } = require('../guild-ingame');
const { rowsOf, addRaid, addLoot, addPresence, pendingBlock } = require('../guild-evidence');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const checks = [];
const filter = process.argv[2];
function check(name, fn) { if (!filter || name.includes(filter)) checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// The browser half

const timers = [];
const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, URL, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} };
vm.createContext(sandbox);
for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
const G = sandbox.Guild;
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 16; i++) await tick(); };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const count = (html, pattern) => (html.match(pattern) || []).length;

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}

const TEAMS = [{ id: 't1', name: 'Team KJ', size: 25, archived: false }, { id: 't2', name: 'Sunday Alts', size: 25, archived: false }];
const GM_ROLES = [{ role: 'guild_master' }];
const OFFICER_CAN = { 'guild.access': 'guild', 'guild.roles': 'guild', 'guild.teams': 'guild', 'roster.view': 'guild', 'roster.edit': 'guild' };
function gdOf(can, extra) {
  return Object.assign({ guild: { id: 'g1', name: 'Vindicated', realm: 'Dreamscythe', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'dreamscythe', createdAt: 1 },
    teams: TEAMS.map((t) => Object.assign({ players: 0, leads: [] }, t)), me: { roles: [{ role: 'officer' }], can: can || OFFICER_CAN, personId: null },
    rosterOptions: null }, extra || {});
}

// ── the stand-ins: the API, the app, the dialogs and the page's own elements ──
let calls;
function useApi(fn) {
  calls = [];
  const wrap = (method) => (urlPath, body) => {
    calls.push({ method, path: urlPath, body: body === undefined ? undefined : plain(body) });
    try { return Promise.resolve(fn(method, urlPath, body)); } catch (error) { return Promise.reject(error); }
  };
  G.api.get = wrap('GET'); G.api.post = wrap('POST'); G.api.put = wrap('PUT'); G.api.del = wrap('DELETE');
}
const refuse = (status, body) => new G.api.ApiError(status, body);
let renders; let goes; let opened; let elements; let signins;
function resetBrowser() {
  renders = 0; goes = []; opened = []; elements = {}; signins = 0; timers.length = 0;
  G.pages.users.reset();
  G.app.render = () => { renders++; };
  G.app.go = (hash) => goes.push(hash);
  G.app.refreshGuild = () => Promise.resolve();
  G.app.fetchGuild = (gid) => Promise.resolve(G.app.state.guilds[gid]);
  G.app.ensureAttention = () => Promise.resolve(null);
  G.app.requireSignin = () => { signins++; };
  G.app.showFailure = () => {};
  G.ui.openDialog = (html) => { opened.push(html); return { open: true }; };
  G.app.state.me = { user: { id: 'u_me', displayName: 'Me' } };
  G.app.state.attention = {};
  G.app.state.notice = '';
  G.app.state.rolesList = {};
  sandbox.window = { sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { hash: '' } };
  sandbox.document = { getElementById: (id) => elements[id] || null, querySelector: () => null, querySelectorAll: () => [] };
}
const element = (id, props) => (elements[id] = Object.assign({ id, innerHTML: '', textContent: '', hidden: true }, props || {}));
const el = (attrs, props) => Object.assign({ disabled: false, hidden: false, checked: false, getAttribute: (k) => (attrs || {})[k], closest: () => null, focus() {} }, props || {});
// A form inside a dialog: the named elements, the lists a handler asks for, and the dialog it closes or swaps.
function formIn(attrs, extra) {
  const dlg = { open: true, innerHTML: '', closed: 0, close() { this.closed++; this.open = false; }, querySelector: () => null };
  const form = Object.assign({ getAttribute: (k) => (attrs || {})[k], elements: {}, querySelectorAll: () => [], querySelector: () => null, closest: (sel) => (sel === 'dialog' ? dlg : null), disabled: false }, extra || {});
  return { form, dlg };
}

const ME = 'u_me';
const key = (n) => `u_${String(n).padStart(22, 'k')}`;
const main = (name, cls) => ({ name, class: cls, realm: 'Dreamscythe' });
function row(n, over) {
  return Object.assign({ key: key(n), kind: 'account', name: `User${n}`, main: main(`Main${n}`, 'MAGE'), permission: null, lastSeen: '2026-10-26', tags: [], flags: {} }, over || {});
}
const COUNTS = { members: 53, former: 7, nonmembers: 204, blocked: 2 };
function listOf(rows, over) {
  return Object.assign({ gid: 'g1', segment: 'members', rows, more: false, counts: COUNTS, battlenetOnly: true, coreRanks: ['raider', 'trial', 'social'], error: '' }, over || {});
}
function viewOf(over) { return Object.assign({ gid: 'g1', segment: 'members', q: '', rank: '', from: '', sort: 'user', dir: 'asc', all: false }, over || {}); }
const listHtml = (rows, over, opts) => G.pages.users.listHtml(Object.assign({ guildData: gdOf(), route: { name: 'users', gid: 'g1', segment: null }, view: viewOf(), list: listOf(rows, over), manage: null, pending: 0, meId: ME, flash: null, notice: '', sync: null }, opts || {}));

// The page's own read through load(): the list reply of the stand-in API.
function listReply(rows, over) { return Object.assign({ segment: 'members', rows, more: false, counts: COUNTS, sort: 'user', dir: 'asc', battlenetOnly: true, coreRanks: ['raider', 'trial', 'social'] }, over || {}); }
async function openList(rows, over, can) {
  const gd = gdOf(can);
  G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1';
  useApi((method, urlPath) => { if (method === 'GET' && /\/users\?/.test(urlPath)) return listReply(rows, over); throw refuse(404, {}); });
  await G.pages.users.load({ name: 'users', gid: 'g1', segment: (over && over.segment) || null }, gd);
  return gd;
}
const pageHtml = (gd, segment) => G.pages.users.main({ name: 'users', gid: 'g1', segment: segment || null }, gd);

// ---------------------------------------------------------------------------
// 1. The list

check('list: four segments with their counts, the current one pressed, the context line counts every user, the first rows say how many there are', () => {
  resetBrowser();
  const html = listHtml([row(1), row(2)]);
  assert(/<h1[^>]*>Users<\/h1>/.test(html) && html.includes('266 users'));
  const segs = [...html.matchAll(/class="gs-fg-seg" data-action="users-seg" data-seg="(\w+)" data-key="[^"]*" aria-pressed="(\w+)">([^<]*) <span class="gs-fg-segn">(\d+)<\/span>/g)].map((m) => [m[1], m[2], m[3], m[4]]);
  assert.deepEqual(segs, [['members', 'true', 'Members', '53'], ['former', 'false', 'Former', '7'], ['nonmembers', 'false', 'Non-members', '204'], ['blocked', 'false', 'Blocked', '2']]);
  assert.equal(count(html, /class="gs-fg-pill" data-action="users-seg"/g), 4, 'the phone has the same four');
  assert(text(html).includes('Showing 2 members') && !html.includes('data-action="users-all"'), 'no more rows than the two: nothing to show all of');
  const more = listHtml([row(1), row(2)], { more: true });
  assert(text(more).includes('Showing 2 of 53 members') && more.includes('data-action="users-all"') && text(more).includes('Show all 53'));
  const searched = listHtml([row(1)], { more: true }, { view: viewOf({ q: 'ash' }) });
  assert(text(searched).includes('Showing 1 members') && !text(searched).includes('of 53') && text(searched).includes('Show all') && !text(searched).includes('Show all 53'), 'with a search the total is not known');
  assert(html.includes('Members come from the in-game guild roster.') && !listHtml([row(1)], { battlenetOnly: false }).includes('in-game guild roster'));
  for (const [segment, line] of [['former', 'People whose characters have all left the guild.'], ['nonmembers', 'People Raidsmith has seen without a character on the guild roster.'], ['blocked', 'Blocked users cannot sign in to Vindicated.']]) {
    assert(text(listHtml([row(1)], { segment }, { view: viewOf({ segment }) })).includes(line), segment);
  }
});

check('list: the columns are User, Main character, Permission and Last seen, each head a sort button that reads the Worker, A-Z by default; no sign-in line and no count the API lacks', () => {
  resetBrowser();
  const html = listHtml([row(1)]);
  const heads = [...html.matchAll(/<th scope="col" class="" aria-sort="(\w+)"><button type="button" class="gs-sort" data-action="users-sort" data-table="users-members" data-sort="(\w+)" data-key="users-sort-\w+"(?: data-dir="(\w+)")?>([^<]*)</g)].map((m) => [m[2], m[4], m[1], m[3] || '']);
  assert.deepEqual(heads, [['user', 'User', 'ascending', 'asc'], ['main', 'Main character', 'none', ''], ['permission', 'Permission', 'none', ''], ['lastSeen', 'Last seen', 'none', '']]);
  const sorted = listHtml([row(1)], {}, { view: viewOf({ sort: 'permission', dir: 'desc' }) });
  assert(sorted.includes('aria-sort="descending"><button type="button" class="gs-sort" data-action="users-sort" data-table="users-members" data-sort="permission"') && count(sorted, /aria-sort="ascending"/g) === 0);
  for (const gone of ['Signed in', 'Not signed in', 'signed in', 'Trial chip']) assert(!text(html).includes(gone), gone);
});

check('list: a row is the user (avatar, name, a second line), the Main in its class colour or a dash, the permission or None with the Owner seat under it, the last seen day', () => {
  resetBrowser();
  const rows = [
    row(1, { name: 'Ashgrove', main: main('Ashgrove', 'DRUID'), permission: 'Officer' }),
    row(2, { name: 'Bramblewick', kind: 'person', main: main('Bramblewick', 'ROGUE') }),
    row(3, { name: 'Brandon', key: ME, main: main('Thornwick', 'DRUID'), permission: 'Guild Master', flags: { owner: true }, lastSeen: '2024-03-09' }),
    row(4, { name: 'Cindervale', kind: 'account', main: null, tags: ['discord_signin', 'raid_log'], lastSeen: null }),
    row(5, { name: 'Crowfell', flags: { pendingReview: true }, permission: null }),
    row(6, { name: 'Kaelen', permission: 'Officer', flags: { suspended: true } }),
  ];
  const html = listHtml(rows);
  assert(html.includes(`<a class="gs-person gs-us-user" href="#/g/g1/users/u/${key(1)}">`) && html.includes('<span class="gs-person-name">Ashgrove</span>'));
  assert(html.includes('<span class="gs-char-name gs-class-druid">Ashgrove</span>') && html.includes('<span class="gs-char-name gs-class-rogue">Bramblewick</span>'));
  assert(text(html).includes('Bramblewick No account yet'), 'a person without an account says so');
  assert(text(html).includes('Cindervale Discord sign-in · Raid log'), 'a non-member says where it was seen');
  assert(html.includes('<span class="gs-muted" aria-label="No main character">—</span>'), 'a dash for no Main');
  assert(html.includes('Guild Master<span class="gs-fine gs-us-sub">Owner seat</span>') && html.includes('Officer<span class="gs-fine gs-us-sub">Owner seat</span>'), 'the Owner and the suspended seat holder');
  assert(html.includes('<span class="gs-muted">None</span>'));
  assert(count(html, /gs-hd-chip is-rose">Needs review</g) === 2 && html.includes('gs-hd-chip is-rose">Suspended<'), 'the chips (desktop and phone)');
  assert(html.includes('<span class="gs-you">You</span>') && html.includes('class="gs-dtable-row is-you"'), 'your own row keeps its place, tinted and tagged');
  assert(html.includes('>Mar 9, 2024<'), 'a day of another year carries the year');
  assert(/>Oct 26</.test(html));
  assertNoRawAttrs(html);
  // The rows of every segment are A-Z as the Worker sends them: the page never moves the viewer's own row.
  const order = [...html.matchAll(/<span class="gs-person-name">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 6), ['Ashgrove', 'Bramblewick', 'Brandon', 'Cindervale', 'Crowfell', 'Kaelen']);
});

function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

check('list (R4 F6): an unknown tag string with markup is escaped in the phone row and the table cell', () => {
  resetBrowser();
  const html = listHtml([row(1, { name: 'Dawn', main: null, tags: ['loot', HOSTILE + QUOTES], lastSeen: null }), row(2, { kind: 'name', name: 'Gus', main: null, tags: [HOSTILE] })]);
  assertEscaped(html, 'tags');
  const phone = html.slice(html.indexOf('class="gs-rs-phone"'));
  assert(phone.includes('Loot, &lt;img src=x onerror=1&gt;'), 'the phone row reads the tag as text, after the known tag');
  assert(!/<img\b/i.test(html), 'no element was created from a tag');
});

check('list: the phone shows slim rows (name, You, No account yet, the Main on line 1; permission or sources and the day on line 2)', () => {
  resetBrowser();
  const html = listHtml([row(1, { name: 'Brandon', key: ME, permission: 'Guild Master', flags: { owner: true } }), row(2, { name: 'Ellie', kind: 'person' }), row(3, { name: 'Dawn', main: null, tags: ['loot'], lastSeen: null })]);
  const phone = html.slice(html.indexOf('class="gs-rs-phone"'));
  assert(phone.includes('class="gs-hd-panel gs-rs-plist"') && count(phone, /class="gs-rs-row gs-us-urow/g) === 3);
  assert(phone.includes('<span class="gs-rs-name">Brandon</span><span class="gs-you">You</span>'));
  assert(phone.includes('Guild Master, Owner seat · Oct 26'));
  assert(phone.includes('<span class="gs-us-urow-note">No account yet</span>'));
  assert(phone.includes('Loot · <span class="gs-muted">—</span>'), 'a name: where it was seen, then a dash for no day');
  assert(phone.includes('href="#/g/g1/users/u/'), 'every row is a link');
});

check('list: the rank filter lists only the core ranks the guild maps (no Reserve here), non-members filter by where they were seen, Blocked has no filter', () => {
  resetBrowser();
  const options = (html, id) => [...html.slice(html.indexOf(`id="${id}"`)).split('</select>')[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
  const members = listHtml([row(1)]);
  assert.deepEqual(options(members, 'users-rank'), [['', 'All ranks'], ['raider', 'Raider'], ['trial', 'Trial'], ['social', 'Social']]);
  assert.deepEqual(options(listHtml([row(1)], { coreRanks: ['raider', 'trial', 'reserve', 'social'] }), 'users-rank').map((o) => o[1]), ['All ranks', 'Raider', 'Trial', 'Reserve', 'Social'], 'a guild that maps Reserve gets it');
  assert(listHtml([row(1)], { segment: 'former' }, { view: viewOf({ segment: 'former' }) }).includes('id="users-rank"'));
  const non = listHtml([row(1)], { segment: 'nonmembers' }, { view: viewOf({ segment: 'nonmembers' }) });
  assert.deepEqual(options(non, 'users-from'), [['', 'All sources'], ['discord_signin', 'Discord sign-in'], ['application', 'Application'], ['guest_signup', 'Guest sign-up'], ['raid_helper', 'Raid-Helper'], ['raid_log', 'Raid log'], ['loot', 'Loot'], ['ingame_roster', 'In-game roster']]);
  assert(!non.includes('id="users-rank"'));
  const blocked = listHtml([row(1)], { segment: 'blocked' }, { view: viewOf({ segment: 'blocked' }) });
  assert(!blocked.includes('id="users-rank"') && !blocked.includes('id="users-from"'));
  assert(listHtml([row(1)], {}, { view: viewOf({ rank: 'trial' }) }).includes('<option value="trial" selected>Trial'));
});

check('list: load() reads the first ten rows of the segment (and the attention list); the sort, the search, the filters and Show all read the Worker again and draw the results in place', async () => {
  resetBrowser();
  const gd = await openList([row(1), row(2)], { more: true });
  assert.equal(calls.filter((c) => /\/users\?/.test(c.path)).length, 1);
  assert.equal(calls[0].path, '/api/guild/g1/users?segment=members&sort=user&dir=asc&offset=0&limit=10');
  assert(/<h1[^>]*>Users<\/h1>/.test(pageHtml(gd)) && pageHtml(gd).includes('User1'));
  const results = element('users-results');
  G.app.state.guilds.g1 = gd;
  // sort: a new column starts ascending, the same column flips
  G.handlers.click['users-sort'](el({ 'data-sort': 'main' }));
  await settle();
  G.handlers.click['users-sort'](el({ 'data-sort': 'main' }));
  await settle();
  G.handlers.click['users-sort'](el({ 'data-sort': 'lastSeen' }));
  await settle();
  const paths = calls.filter((c) => /\/users\?/.test(c.path)).map((c) => c.path.replace('/api/guild/g1/users?segment=members&', ''));
  assert.deepEqual(paths.slice(1), ['sort=main&dir=asc&offset=0&limit=10', 'sort=main&dir=desc&offset=0&limit=10', 'sort=lastSeen&dir=asc&offset=0&limit=10']);
  assert(results.innerHTML.includes('User1') && results.innerHTML.includes('aria-sort="ascending"><button type="button" class="gs-sort" data-action="users-sort" data-table="users-members" data-sort="lastSeen"'), 'the results are drawn in place');
  assert.equal(renders, 0, 'the page is not drawn again: the focus stays where it was');
  G.handlers.click['users-sort'](el({ 'data-sort': 'bogus' }));
  await settle();
  assert.equal(calls.filter((c) => /\/users\?/.test(c.path)).length, 4, 'a column the Worker does not sort by asks nothing');
  // search: debounced, trimmed
  const before = calls.length;
  G.handlers.input['users-search'](el({}, { value: ' Ash ' }));
  assert.equal(calls.length, before, 'nothing is asked while typing');
  timers.splice(0).forEach((fn) => fn());
  await settle();
  assert(calls[calls.length - 1].path.includes('&q=Ash&') || calls[calls.length - 1].path.includes('&q=Ash'), calls[calls.length - 1].path);
  // filters: rank on members, from on non-members; a filter of the other segment is not sent
  G.handlers.change['users-filter'](el({ 'data-filter': 'rank' }, { value: 'raider' }));
  await settle();
  assert(calls[calls.length - 1].path.includes('&rank=raider'));
  G.handlers.change['users-filter'](el({ 'data-filter': 'from' }, { value: 'loot' }));
  await settle();
  assert(!calls[calls.length - 1].path.includes('from='), 'from belongs to Non-members');
  // Show all: pages of 100 until there is no more or 500 rows are on screen
  G.pages.users.reset();
  const big = (n) => Array.from({ length: 100 }, (_, i) => row(n * 100 + i));
  let page = 0;
  useApi((method, urlPath) => { const offset = Number(/offset=(\d+)/.exec(urlPath)[1]); return listReply(big(offset / 100), { more: true }); });
  await G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gd);
  G.handlers.click['users-all'](el({}));
  await settle();
  const offsets = calls.map((c) => /offset=(\d+)&limit=(\d+)/.exec(c.path).slice(1).join('/'));
  assert.deepEqual(offsets, ['0/10', '0/100', '100/100', '200/100', '300/100', '400/100'], 'five pages of 100');
  const state = G.pages.users.state();
  assert.equal(state.list.rows.length, 500);
  assert(text(pageHtml(gd)).includes('Showing 500 of 53') || text(pageHtml(gd)).includes('Search or filter to narrow the list.'));
  void page;
});

check('list: a failed read is an error region with Try again (the page stays), a signed-out or refused read goes to the app, the empty states say why', async () => {
  resetBrowser();
  const gd = gdOf();
  G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1';
  useApi(() => { throw refuse(0, null); });
  await G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gd);
  const html = pageHtml(gd);
  assert(text(html).includes('We couldn\'t load the users.') && html.includes('data-action="users-retry"') && text(html).includes('Nothing you saved was lost.') && /<h1[^>]*>Users<\/h1>/.test(html));
  useApi(() => { throw refuse(429, { error: 'rate_limited', message: 'Too many reads.', retryAfter: 20 }); });
  await G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gd);
  assert(text(pageHtml(gd)).includes('Too many reads. Try again in 20 seconds.'));
  for (const [status, error] of [[401, 'signed_out'], [403, 'forbidden']]) {
    useApi(() => { throw refuse(status, { error, message: 'No.' }); });
    let rejected = null;
    try { await G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gd); } catch (e) { rejected = e; }
    assert(rejected && rejected.status === status, `${status} goes to the app`);
  }
  useApi((method, urlPath) => listReply([]));
  await G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gd);
  assert(text(pageHtml(gd)).includes('No members to show.') && !pageHtml(gd).includes('<table'));
  assert(text(listHtml([], {}, { view: viewOf({ q: 'zzz' }) })).includes('No users match.') && listHtml([], {}, { view: viewOf({ q: 'zzz' }) }).includes('data-action="users-clear"'));
  assertEscaped(listHtml([row(1, { name: HOSTILE + QUOTES, main: main(HOSTILE + QUOTES, 'MAGE'), tags: ['loot'] })], {}, { notice: HOSTILE + QUOTES, flash: { tone: 'success', title: HOSTILE + QUOTES, text: HOSTILE } }), 'list');
});

check('Needs you: the one item of the list is the blocks that wait for review (from the attention list); one is named on Blocked, the strip is gone when nothing waits and in selection mode', () => {
  resetBrowser();
  const strip = (html) => (html.match(/<section class="gs-hd-panel gs-rs-needs"[\s\S]*?<\/section>/) || [''])[0];
  assert.equal(strip(listHtml([row(1)], {}, { pending: 0 })), '');
  const two = strip(listHtml([row(1)], {}, { pending: 2 }));
  assert(two.includes('aria-label="Needs you"') && text(two).includes('2 blocks matched an earlier one and wait for your review') && two.includes('href="#/g/g1/users/blocked"'));
  assert(text(strip(listHtml([row(1)], {}, { pending: 1 }))).includes('1 block matched an earlier one and waits for your review'));
  const blocked = listHtml([row(1, { name: 'Crowfell', flags: { pendingReview: true } }), row(2, { name: 'Vexmoor' })], { segment: 'blocked' }, { pending: 1, view: viewOf({ segment: 'blocked' }) });
  assert(text(strip(blocked)).replace(" 's", "'s").includes('Crowfell\'s block matched an earlier one and waits for your review') && strip(blocked).includes(`href="#/g/g1/users/u/${key(1)}"`));
  assert.equal(strip(listHtml([row(1)], {}, { pending: 1, manage: { picked: {} } })), '', 'in selection mode the hint takes its place');
  // the number comes from the attention list the app already holds
  G.app.state.attention.g1 = { data: { items: [{ kind: 'block_review', pending: 3, held: 1, count: 4 }] }, at: Date.now() };
  G.app.state.guilds.g1 = gdOf(); G.app.state.currentGid = 'g1';
  return G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gdOf()).then(() => undefined, () => undefined).then(() => {
    useApi(() => listReply([row(1)]));
    return G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gdOf());
  }).then(() => {
    assert(text(strip(pageHtml(gdOf()))).includes('3 blocks matched'), 'pending only: the held matches have nothing to decide here');
  });
});

// ---------------------------------------------------------------------------
// 2. Manage users

check('Manage users: the head More offers it to guild.access only; the mode draws a box per row but not on your own, the hint, and a bar with Block and Done (Unblock on Blocked)', async () => {
  resetBrowser();
  const html = listHtml([row(1)]);
  assert(html.includes('data-action="users-manage"') && html.includes('>Manage users<'));
  assert(!listHtml([row(1)], {}, { guildData: gdOf({ 'guild.roles': 'guild' }) }).includes('Manage users'), 'a viewer who may only read the list cannot manage it');
  const gd = await openList([row(1, { name: 'Ashgrove' }), row(2, { name: 'Brandon', key: ME }), row(3, { name: 'Cinder' })]);
  G.handlers.click['users-manage'](el({}));
  assert.equal(renders, 1);
  const mode = pageHtml(gd);
  assert(text(mode).includes('Tick the users to block.') && !mode.includes('Needs you'));
  assert.equal(count(mode, /class="gs-us-chk"/g), 4, 'two other rows, in the table and on the phone');
  assert(mode.includes('aria-label="Select Ashgrove"') && !mode.includes('aria-label="Select Brandon"') && count(mode, /gs-us-chkbox is-off/g) === 2, 'no box on your own row');
  assert(mode.includes('id="users-selbar"') && text(mode).includes('0 selected') && mode.includes('data-action="users-block-open"') && mode.includes('data-action="users-done"') && !mode.includes('users-unblock'));
  assert(/<button type="button" class="gs-btn gs-btn-sm" disabled data-action="users-block-open"/.test(mode), 'Block waits for a tick');
  assert(!/class="gs-dtable-row[^"]*"[^>]*><th scope="row" class="gs-dtable-primary"><a /.test(mode), 'rows stop being links');
  assert(mode.includes('data-pick="' + key(1) + '"'));
  const bar = element('users-selbar');
  G.handlers.change['users-pick'](el({ 'data-pick': key(1) }, { checked: true }));
  G.handlers.change['users-pick'](el({ 'data-pick': key(3) }, { checked: true }));
  assert(text(bar.innerHTML).includes('2 selected') && !/disabled data-action="users-block-open"/.test(bar.innerHTML));
  G.handlers.change['users-pick'](el({ 'data-pick': key(3) }, { checked: false }));
  assert(text(bar.innerHTML).includes('1 selected'));
  G.handlers.click['users-done'](el({}));
  assert.equal(G.pages.users.state().manage, null);
  // Blocked: Unblock
  const blockedGd = await openList([row(1, { name: 'Crowfell' })], { segment: 'blocked' });
  G.handlers.click['users-manage'](el({}));
  const blockedMode = pageHtml(blockedGd, 'blocked');
  assert(text(blockedMode).includes('Tick the users to unblock.') && blockedMode.includes('data-action="users-unblock"') && !blockedMode.includes('users-block-open'));
});

check('Add to a person: only on Non-members of a guild whose ranks are set by hand, for roster.edit, and enabled when every ticked row is a name', async () => {
  resetBrowser();
  const names = [row(1, { kind: 'name', name: 'Alderwood', main: null, tags: ['raid_log'] }), row(2, { kind: 'name', name: 'Ashdown', main: null, tags: ['loot'] }), row(3, { kind: 'account', name: 'Brightmane', main: null, tags: ['discord_signin'] })];
  const barOf = async (over, can) => {
    const gd = await openList(names, Object.assign({ segment: 'nonmembers' }, over), can);
    G.handlers.click['users-manage'](el({}));
    return { gd, html: pageHtml(gd, 'nonmembers') };
  };
  const inGame = await barOf({ battlenetOnly: true });
  assert(!inGame.html.includes('users-add-open') && inGame.html.includes('users-block-open'), 'Vindicated: Block only');
  const hand = await barOf({ battlenetOnly: false });
  assert(hand.html.includes('data-action="users-add-open"') && /disabled data-action="users-add-open"/.test(hand.html), 'drawn, waiting for a tick');
  assert(!(await barOf({ battlenetOnly: false }, { 'guild.access': 'guild' })).html.includes('users-add-open'), 'it writes the roster: roster.edit');
  await barOf({ battlenetOnly: false });
  const bar = element('users-selbar');
  const enabled = () => !/disabled data-action="users-add-open"/.test(bar.innerHTML);
  G.handlers.change['users-pick'](el({ 'data-pick': key(1) }, { checked: true }));
  assert(enabled(), 'a name');
  G.handlers.change['users-pick'](el({ 'data-pick': key(3) }, { checked: true }));
  assert(!enabled(), 'an account row is no name');
  G.handlers.change['users-pick'](el({ 'data-pick': key(3) }, { checked: false }));
  assert(enabled());
});

check('Block: the confirm lists the users and what blocking does; more than 25 go in chunks; the result dialog lists done and skipped names with the API\'s message each; skipped users stay ticked', async () => {
  resetBrowser();
  const total = 60;
  const rows = Array.from({ length: total }, (_, i) => row(i + 1, { name: `Name${i + 1}` }));
  const gd = await openList(rows, { more: false });
  G.handlers.click['users-manage'](el({}));
  for (let i = 1; i <= total; i++) G.handlers.change['users-pick'](el({ 'data-pick': key(i) }, { checked: true }));
  G.handlers.click['users-block-open'](el({}));
  const confirm = opened[0];
  assert(/<h2[^>]*id="dlg-title">Block 60 users\?<\/h2>/.test(confirm) && confirm.includes('You can unblock them any time on Users, Blocked.') && confirm.includes('gs-btn gs-btn-danger') && confirm.includes('Block 60 users</span>'));
  assert(text(confirm).includes('and 50 more') && text(confirm).includes('Name1') && !text(confirm).includes('Name11 '), 'ten names, then "and N more"');
  for (const [k, v] of [['Sign-in', 'They can no longer sign in to Vindicated'], ['Teams', 'Taken off every team'], ['Sign-ups', 'Upcoming sign-ups withdrawn'], ['History', 'Characters, attendance and loot stay']]) assert(text(confirm).includes(`${k} ${v}`), k);
  assert(confirm.includes('data-submit="users-block-form"') && confirm.includes('gs-forge'));
  // the API: 25 names a request; the 37th is not found, the 3rd is the Owner, a failing second chunk is not sent through
  const sentKeys = [];
  useApi((method, urlPath, body) => {
    assert.equal(urlPath, '/api/guild/g1/users/block');
    sentKeys.push(body.keys.length);
    const skipped = [];
    const done = [];
    for (const k of body.keys) {
      const n = Number(k.replace(/^u_k+/, ''));
      if (n === 3) skipped.push({ key: k, name: 'Name3', reason: 'owner', message: 'The Owner of the guild cannot be removed.' });
      else if (n === 37) skipped.push({ key: k, name: null, reason: 'not_found', message: 'That user was not found.' });
      else done.push({ key: k, kind: 'account', name: `Name${n}` });
    }
    return { action: 'block', done, skipped, cap: 25 };
  });
  const { form, dlg } = formIn({});
  G.handlers.submit['users-block-form'](form);
  await settle();
  assert.deepEqual(sentKeys, [25, 25, 10], 'chunks of 25 in the order of the list');
  const result = dlg.innerHTML;
  assert(/<h2[^>]*id="dlg-title">Blocked 58 of 60 users<\/h2>/.test(result) && text(result).includes('2 users were skipped.'));
  assert(text(result).includes('Name3 The Owner of the guild cannot be removed.') && text(result).includes('Unknown user That user was not found.') || text(result).includes('Name37 That user was not found.'));
  assert(text(result).includes('Name1 Blocked') && text(result).includes('Name60 Blocked'));
  assert(result.includes('data-submit="users-result-done"') && !result.includes('data-action="dialog-cancel"'));
  const picked = Object.keys(G.pages.users.state().manage.picked);
  assert.deepEqual(picked.sort(), [key(3), key(37)].sort(), 'the skipped users stay ticked, the blocked ones leave the selection');
  assert(renders >= 1, 'the list is read again');
  G.handlers.submit['users-result-done'](formIn({}).form);
});

check('Block: a request that fails after the first marks its names skipped with the reason; one that fails first stays in the dialog; a single user is blocked from the user page', async () => {
  resetBrowser();
  const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, { name: `Name${i + 1}` }));
  const gd = await openList(rows);
  G.handlers.click['users-manage'](el({}));
  for (let i = 1; i <= 30; i++) G.handlers.change['users-pick'](el({ 'data-pick': key(i) }, { checked: true }));
  G.handlers.click['users-block-open'](el({}));
  let n = 0;
  useApi((method, urlPath, body) => {
    n++;
    if (n === 2) throw refuse(429, { error: 'rate_limited', message: 'Too many changes.', retryAfter: 30 });
    return { action: 'block', done: body.keys.map((k) => ({ key: k, kind: 'account', name: 'x' })), skipped: [], cap: 25 };
  });
  const later = formIn({});
  G.handlers.submit['users-block-form'](later.form);
  await settle();
  assert(/Blocked 25 of 30 users/.test(later.dlg.innerHTML) && text(later.dlg.innerHTML).includes('Too many changes. Try again in 30 seconds.'), text(later.dlg.innerHTML));
  assert.equal(Object.keys(G.pages.users.state().manage.picked).length, 5, 'the five that were not sent stay ticked');
  // the first request fails: the dialog says why
  G.handlers.click['users-block-open'](el({}));
  useApi(() => { throw refuse(500, { error: 'server', message: 'It broke.' }); });
  const err = element('dlg-error');
  const first = formIn({});
  G.handlers.submit['users-block-form'](first.form);
  await settle();
  assert.equal(err.textContent, 'It broke.');
  assert.equal(first.dlg.closed, 0, 'the dialog stays open on a failed first request');
  // one user from the user page
  resetBrowser();
  const page = { key: key(9), kind: 'account', segment: 'members', name: 'Ashgrove', identity: { account: { displayName: 'Ashgrove' }, battlenet: false, signInMethods: [] }, main: main('Ashgrove', 'DRUID'), characters: [], permission: null, permissions: [], lastSeen: null, block: { blocked: false, pendingReview: false, blockedOn: null }, flags: {}, tags: [], sightings: [] };
  const g2 = gdOf(); G.app.state.guilds.g1 = g2; G.app.state.currentGid = 'g1';
  useApi((method, urlPath) => { if (method === 'GET') return page; throw refuse(500, {}); });
  await G.pages.user.load({ name: 'user', gid: 'g1', key: page.key }, g2);
  G.handlers.click['users-user-block'](el({}));
  assert(/<h2[^>]*id="dlg-title">Block Ashgrove\?<\/h2>/.test(opened[0]));
  const bodies = [];
  useApi((method, urlPath, body) => {
    if (method === 'POST') { bodies.push([urlPath, plain(body)]); return { action: 'block', done: [{ key: page.key, kind: 'account', name: 'Ashgrove' }], skipped: [], cap: 25 }; }
    return Object.assign({}, page, { segment: 'blocked', block: { blocked: true, pendingReview: false, blockedOn: '2026-10-27' } });
  });
  const single = formIn({});
  G.handlers.submit['users-block-form'](single.form);
  await settle();
  assert.deepEqual(bodies, [['/api/guild/g1/users/block', { keys: [page.key] }]]);
  assert.equal(single.dlg.closed, 1);
  assert(G.pages.users.state().flash.title === 'Blocked Ashgrove.' && G.pages.users.state().user.data.block.blocked === true);
  // refused: the API's own sentence stays in the dialog
  G.handlers.click['users-user-block'](el({}));
  useApi(() => ({ action: 'block', done: [], skipped: [{ key: page.key, name: 'Ashgrove', reason: 'outranks', message: 'That person ranks the same as you or above you, so only someone more senior can change their access.' }], cap: 25 }));
  const refused = formIn({});
  const dlgErr = element('dlg-error');
  G.handlers.submit['users-block-form'](refused.form);
  await settle();
  assert(dlgErr.textContent.startsWith('That person ranks the same as you'));
  assert.equal(refused.dlg.closed, 0);
});

check('Unblock: from Blocked with ticked users, the same result dialog says "Restored access"; a refusal is a skipped name', async () => {
  resetBrowser();
  const gd = await openList([row(1, { name: 'Crowfell' }), row(2, { name: 'Vexmoor' })], { segment: 'blocked' });
  G.handlers.click['users-manage'](el({}));
  G.handlers.change['users-pick'](el({ 'data-pick': key(1) }, { checked: true }));
  G.handlers.change['users-pick'](el({ 'data-pick': key(2) }, { checked: true }));
  useApi((method, urlPath, body) => {
    if (method === 'POST') {
      assert.equal(urlPath, '/api/guild/g1/users/unblock');
      return { action: 'unblock', done: [{ key: key(1), kind: 'account', name: 'Crowfell' }], skipped: [{ key: key(2), name: 'Vexmoor', reason: 'not_blocked', message: 'Their access is not removed.' }], cap: 25 };
    }
    return listReply([], { segment: 'blocked' });
  });
  G.handlers.click['users-unblock'](el({}));
  await settle();
  const html = opened[0];
  assert(/Restored access for 1 of 2 users/.test(html) && text(html).includes('Crowfell Access restored') && text(html).includes('Vexmoor Their access is not removed.'));
  assert.deepEqual(Object.keys(G.pages.users.state().manage.picked), [key(2)]);
  void gd;
});

check('Add to a person: the person is picked from the members (search), each name has a Class select (From the log), the answer is per name - a name that needs a class comes back with its select required', async () => {
  resetBrowser();
  const names = [row(1, { kind: 'name', name: 'Alderwood', main: null, tags: ['raid_log'] }), row(2, { kind: 'name', name: 'Ashdown', main: null, tags: ['raid_log', 'loot'] }), row(3, { kind: 'name', name: 'Cedarwick', main: null, tags: ['guest_signup'] })];
  const gd = await openList(names, { segment: 'nonmembers', battlenetOnly: false });
  gd.rosterOptions = { classes: [{ id: 'DRUID', name: 'Druid' }, { id: 'MAGE', name: 'Mage' }], specs: {}, roles: {} };
  G.handlers.click['users-manage'](el({}));
  for (const i of [1, 2, 3]) G.handlers.change['users-pick'](el({ 'data-pick': key(i) }, { checked: true }));
  const people = [row(11, { name: 'Cinderlow', main: main('Cinderlow', 'MAGE') }), row(12, { name: 'Aldrenn', main: main('Aldrenn', 'WARRIOR') })];
  useApi((method, urlPath) => {
    assert(/segment=members&sort=user&dir=asc&offset=0&limit=5/.test(urlPath));
    return listReply(people, { more: true });
  });
  G.handlers.click['users-add-open'](el({}));
  await settle();
  const dialog = opened[0];
  assert(/<h2[^>]*id="dlg-title">Add 3 names to a person<\/h2>/.test(dialog) && text(dialog).includes('Pick one person. All 3 names become their alts. Their history lines up by name and realm.'));
  assert(dialog.includes('type="search" id="users-add-search"') && count(dialog, /name="person"/g) === 2 && text(dialog).includes('Showing 2 of 53. Search to narrow the list.'));
  assert(text(dialog).includes('Cinderlow') && dialog.includes('<span class="gs-char-name gs-class-mage">Cinderlow</span>'));
  assert.equal(count(dialog, /<select class="gs-input gs-us-classsel"/g), 3);
  assert(dialog.includes('<option value="">From the log</option><option value="DRUID">Druid</option><option value="MAGE">Mage</option>'));
  assert(text(dialog).includes('Alderwood Raid log') && text(dialog).includes('Ashdown Raid log · Loot') && dialog.includes('Add to a person</span>'));
  // search narrows the list
  const people2 = element('users-add-people');
  const more = element('users-add-more');
  useApi((method, urlPath) => { assert(urlPath.includes('&q=Cin')); return listReply([people[0]], { more: false }); });
  G.handlers.input['users-add-search'](el({}, { value: 'Cin' }));
  timers.splice(0).forEach((fn) => fn());
  await settle();
  assert(people2.innerHTML.includes('Cinderlow') && !people2.innerHTML.includes('Aldrenn') && more.textContent === '');
  // submit without a person
  const dlgErr = element('dlg-error');
  const sels = { Alderwood: 'MAGE', Ashdown: '', Cedarwick: '' };
  const selectFor = (name) => ({ value: sels[name] });
  const makeForm = () => formIn({}, { querySelector: (sel) => { const m = /data-name-key="([^"]+)"/.exec(sel); const row0 = names.find((n) => n.key === (m && m[1])); return row0 ? selectFor(row0.name) : null; } });
  G.handlers.submit['users-add-form'](makeForm().form);
  assert.equal(dlgErr.textContent, 'Pick the person to add the names to.');
  // pick Cinderlow (the radio carries the key and the name)
  const radio = el({ 'data-person-name': 'Cinderlow' }, { value: key(11), closest: () => null });
  G.handlers.change['users-add-pick'](radio);
  const bodies = [];
  useApi((method, urlPath, body) => {
    bodies.push([urlPath, plain(body)]);
    if (method === 'POST') {
      return { person: { key: key(11), name: 'Cinderlow' }, done: [{ key: key(1), name: 'Alderwood', characterId: 'c1' }, { key: key(2), name: 'Ashdown', characterId: 'c2' }], skipped: [{ key: key(3), name: 'Cedarwick', reason: 'class_needed', message: 'Pick this character\'s class.' }], cap: 10 };
    }
    return listReply([]);
  });
  const first = makeForm();
  G.handlers.submit['users-add-form'](first.form);
  await settle();
  assert.deepEqual(bodies[0], ['/api/guild/g1/users/add-to-person', { person: key(11), names: [{ key: key(1), class: 'MAGE' }, { key: key(2) }, { key: key(3) }] }], 'the class goes along only for the name that was given one');
  const second = first.dlg.innerHTML;
  assert(/<h2[^>]*id="dlg-title">Add Cedarwick to Cinderlow<\/h2>/.test(second) && text(second).includes('Added Alderwood, Ashdown to Cinderlow.') && text(second).includes('Still to add') && text(second).includes('Cedarwick has no class in the log or the sign-up. Pick one.'));
  assert(/<select class="gs-input gs-us-classsel is-needed"[^>]*required>/.test(second) && second.includes('Pick a class</option>') && second.includes('Add Cedarwick</span>'));
  assert(!second.includes('name="person"'), 'the person stays');
  assert.deepEqual(Object.keys(G.pages.users.state().manage.picked), [key(3)]);
  // the class is required now; then the last name goes and the dialog closes with the banner on the page
  sels.Cedarwick = '';
  const noClass = makeForm();
  G.handlers.submit['users-add-form'](noClass.form);
  assert.equal(dlgErr.textContent, 'Pick a class for Cedarwick.');
  sels.Cedarwick = 'DRUID';
  useApi((method) => (method === 'POST' ? { person: { key: key(11), name: 'Cinderlow' }, done: [{ key: key(3), name: 'Cedarwick', characterId: 'c3' }], skipped: [], cap: 10 } : listReply([])));
  const last = makeForm();
  G.handlers.submit['users-add-form'](last.form);
  await settle();
  assert.equal(last.dlg.closed, 1);
  const flash = G.pages.users.state().flash;
  assert(flash.title === 'Added Alderwood, Ashdown, Cedarwick to Cinderlow.' && flash.tone === 'success');
  assert.equal(G.pages.users.state().manage, null, 'nothing left ticked: the mode ends');
});

check('Add to a person: the API\'s refusal (an in-game guild answers battlenet_only) is said in the dialog and nothing leaves the selection; more than 10 names go in chunks', async () => {
  resetBrowser();
  const names = Array.from({ length: 23 }, (_, i) => row(i + 1, { kind: 'name', name: `Name${i + 1}`, main: null, tags: ['loot'] }));
  const gd = await openList(names, { segment: 'nonmembers', battlenetOnly: false });
  G.handlers.click['users-manage'](el({}));
  for (let i = 1; i <= 23; i++) G.handlers.change['users-pick'](el({ 'data-pick': key(i) }, { checked: true }));
  useApi(() => listReply([row(11, { name: 'Cinderlow', main: main('Cinderlow', 'MAGE') })]));
  G.handlers.click['users-add-open'](el({}));
  await settle();
  G.handlers.change['users-add-pick'](el({ 'data-person-name': 'Cinderlow' }, { value: key(11) }));
  const makeForm = () => formIn({}, { querySelector: () => ({ value: '' }) });
  const dlgErr = element('dlg-error');
  useApi(() => { throw refuse(409, { error: 'battlenet_only', message: 'Characters reach an account only through Battle.net.' }); });
  const refusedForm = makeForm();
  G.handlers.submit['users-add-form'](refusedForm.form);
  await settle();
  assert.equal(dlgErr.textContent, 'Characters reach an account only through Battle.net.');
  assert.equal(Object.keys(G.pages.users.state().manage.picked).length, 23);
  const sizes = [];
  useApi((method, urlPath, body) => {
    if (method === 'GET') return listReply([]);
    sizes.push(body.names.length);
    return { person: { key: key(11), name: 'Cinderlow' }, done: body.names.map((n) => ({ key: n.key, name: 'x', characterId: 'c' })), skipped: [], cap: 10 };
  });
  G.handlers.submit['users-add-form'](makeForm().form);
  await settle();
  assert.deepEqual(sizes, [10, 10, 3]);
  void gd;
});

// ---------------------------------------------------------------------------
// 3. The user page

const CHARS = [
  { name: 'Ashgrove', class: 'DRUID', realm: 'Dreamscythe', ingameRank: { rank: 2, label: 'Raid Leader' }, coreRank: 'raider', team: { id: 't1', name: 'Team KJ' }, isMain: true, former: false, leftOn: null },
  { name: 'Ashmend', class: 'PRIEST', realm: 'Dreamscythe', ingameRank: null, coreRank: 'social', team: null, isMain: false, former: false, leftOn: null },
];
function account(over) {
  return Object.assign({
    key: key(1), kind: 'account', segment: 'members', name: 'Ashgrove', personId: 'p_Ashgrove0000000000000', identity: { account: { displayName: 'Ashgrove' }, battlenet: true, signInMethods: ['discord', 'battlenet'] },
    main: main('Ashgrove', 'DRUID'), characters: CHARS, permission: 'Officer', permissions: [{ role: 'officer', label: 'Officer', sources: ['ingame'] }], lastSeen: '2026-10-26',
    block: { blocked: false, pendingReview: false, blockedOn: null }, flags: {}, tags: [], sightings: [], battlenetOnly: true, ownerSeat: true,
  }, over || {});
}
const userPage = (data, gd, meId) => G.pages.user.userHtml({ guildData: gd || gdOf(null, { owner: { name: 'Brandon', you: false } }), data, meId: meId === undefined ? ME : meId, flash: null });

check('user page: the head names the segment, the Main\'s in-game rank and the last seen; the characters show rank, core rank and team; Permission says where each role comes from; Identity has no id of any kind', () => {
  resetBrowser();
  const html = userPage(account());
  assert(/<h1[^>]*>Ashgrove<\/h1>/.test(html) && html.includes('Member · Raid Leader · last seen Oct 26'));
  assert(html.includes('href="#/g/g1/users"') && html.includes('gs-back-link'), 'back to Users');
  const rows = [...html.matchAll(/<div class="gs-pr-row gs-pr-char">[\s\S]*?<\/div>/g)].map((m) => text(m[0]).trim());
  assert.deepEqual(rows, ['Ashgrove Druid Raid Leader Raider Team KJ Main', 'Ashmend Priest Not on the roster Social No team Alt']);
  assert(text(html).includes('Rank comes from the in-game guild roster'));
  assert(!userPage(account({ battlenetOnly: false })).includes('Not on the roster') && !userPage(account({ battlenetOnly: false })).includes('Rank comes from'), 'in a guild with hand-set ranks the roster says nothing');
  assert(text(html).includes('Officer From the in-game rank'));
  assert(text(userPage(account({ permissions: [{ role: 'officer', label: 'Officer', sources: ['manual'] }, { role: 'team_lead', label: 'Team Lead', teamId: 't1', teamName: 'Team KJ', sources: ['manual', 'discord'] }] }))).includes('Officer Set by hand Team Lead: Team KJ Set by hand, From Discord'));
  assert(text(userPage(account({ permissions: [] }))).includes('Permission None'));
  const identity = text(html.slice(html.indexOf('id="identity"')));
  assert(identity.includes('Account Ashgrove') && identity.includes('Battle.net Linked') && identity.includes('Sign-in Battle.net, Discord') && identity.includes('Last seen Oct 26'));
  assert(text(userPage(account({ identity: { account: { displayName: 'Ashgrove' }, battlenet: false, signInMethods: [] } }))).includes('Battle.net Not linked Sign-in None'));
  assertNoRawAttrs(html);
  assertEscaped(userPage(account({ name: HOSTILE + QUOTES, characters: [Object.assign({}, CHARS[0], { name: HOSTILE + QUOTES, team: { id: 't1', name: HOSTILE + QUOTES } })], permissions: [{ role: 'cr_x', label: HOSTILE + QUOTES, teamId: 't1', teamName: HOSTILE, sources: ['manual'] }], flags: { suspended: true } })), 'user page');
});

check('user page: Edit permission for guild.roles on another current member; More has Open roster record (a personId), the hand-over for the Owner and Block user; none of it on your own page or for a Guild Master', () => {
  resetBrowser();
  const owner = gdOf(null, { owner: { name: 'Me', you: true } });
  const html = userPage(account(), owner);
  assert(html.includes('data-action="users-roles-open"') && html.includes('>Edit permission<'));
  const more = html.slice(html.indexOf('id="user-more-list"'), html.indexOf('</header>'));
  assert(more.includes('href="#/g/g1/roster/p/p_Ashgrove0000000000000"') && more.includes('>Open roster record<') && more.includes('data-action="users-handover-open"') && more.includes('Hand over the Owner seat') && more.includes('is-danger') && more.includes('>Block user<'));
  assert(more.indexOf('Open roster record') < more.indexOf('Hand over') && more.indexOf('Hand over') < more.indexOf('role="separator"') && more.indexOf('role="separator"') < more.indexOf('Block user'));
  const notOwner = userPage(account(), gdOf(null, { owner: { name: 'Brandon', you: false } }));
  assert(!notOwner.includes('users-handover-open') && notOwner.includes('Block user'));
  const noRecord = userPage(account({ personId: undefined }), owner);
  assert(!noRecord.includes('Open roster record'), 'no person id from the API: no link');
  const mine = userPage(account({ key: ME }), owner);
  assert(!mine.includes('users-roles-open') && !mine.includes('Block user') && !mine.includes('users-handover-open') && mine.includes('gs-hd-chip is-grey">You<'), 'not on your own page');
  const master = userPage(account({ permission: 'Guild Master', permissions: [{ role: 'guild_master', label: 'Guild Master', sources: ['ingame'] }] }), owner);
  assert(!master.includes('users-roles-open') && master.includes('users-handover-open'), 'a Guild Master has no roles to edit, but can receive the seat');
  const theOwner = userPage(account({ flags: { owner: true }, permission: 'Guild Master' }), gdOf(null, { owner: { name: 'Ashgrove', you: false } }));
  assert(!theOwner.includes('Block user') && !theOwner.includes('users-roles-open'), 'the Owner cannot be blocked or edited');
  const rolesOnly = userPage(account(), gdOf({ 'guild.roles': 'guild', 'roster.view': 'guild' }, { owner: { name: 'Brandon', you: false } }));
  assert(rolesOnly.includes('users-roles-open') && !rolesOnly.includes('Block user'), 'guild.roles edits, guild.access blocks');
  const accessOnly = userPage(account(), gdOf({ 'guild.access': 'guild' }));
  assert(!accessOnly.includes('users-roles-open') && accessOnly.includes('Block user') && !accessOnly.includes('Open roster record'));
  const former = userPage(account({ segment: 'former' }), owner);
  assert(!former.includes('users-roles-open') && !former.includes('users-handover-open'), 'a former member holds no permission and cannot take the seat');
});

check('user page: a block that waits for review is a decision (Keep block / Restore access) with the reason and no blocker; Keep and Restore call the Worker and read the page again', async () => {
  resetBrowser();
  const blocked = account({ name: 'Crowfell', segment: 'blocked', permission: null, permissions: [], characters: [CHARS[1]], flags: { pendingReview: true }, block: { blocked: true, pendingReview: true, blockedOn: '2026-10-03', reason: 'Matched an earlier block of the same person' } });
  const html = userPage(blocked);
  assert(html.includes('class="gs-nextstep"') && text(html).includes('Crowfell matched an earlier block') && text(html).includes('Keep the block, or restore access.'));
  assert(html.includes('data-action="users-keep"') && html.includes('data-action="users-restore"') && html.includes('gs-btn gs-btn-molten'), 'Keep block is the primary');
  assert(html.includes('gs-hd-chip is-rose">Needs review<') && text(html).includes('Blocked · last seen Oct 26'));
  const panel = text(html.slice(html.indexOf('id="block"')));
  assert(panel.includes('Blocked on Oct 3 Reason') && panel.includes('Reason Matched an earlier block of the same person') && !panel.includes('Blocked by'));
  assert(!html.includes('Block user'), 'already blocked');
  assert(!userPage(blocked, gdOf({ 'guild.roles': 'guild' })).includes('gs-nextstep'), 'a viewer who cannot decide does not see the bar');
  assert(text(userPage(account({ segment: 'blocked', block: { blocked: true, pendingReview: false, blockedOn: '2026-10-03', blockedBy: 'Officer', reason: 'Rude' } }))).includes('Blocked by Officer'));
  // Keep
  const gd = gdOf(); G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1';
  useApi((method, urlPath) => { if (method === 'GET') return blocked; return {}; });
  await G.pages.user.load({ name: 'user', gid: 'g1', key: blocked.key }, gd);
  const keep = el({});
  G.handlers.click['users-keep'](keep);
  await settle();
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path]), [['POST', `/api/guild/g1/people/${blocked.key}/block/keep`]]);
  assert.equal(keep.disabled, true);
  assert(renders >= 1);
  // Restore (a pending block: DELETE .../block)
  useApi((method) => (method === 'GET' ? Object.assign({}, blocked, { segment: 'members', block: { blocked: false, pendingReview: false, blockedOn: null }, flags: {} }) : {}));
  G.handlers.click['users-restore'](el({}));
  await settle();
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path]), [['DELETE', `/api/guild/g1/people/${blocked.key}/block`]]);
  assert.equal(G.pages.users.state().flash.title, 'Restored access for Crowfell.');
  // a plain block is restored from More with the bulk route; a refusal is said on the page
  const plain1 = account({ segment: 'blocked', block: { blocked: true, pendingReview: false, blockedOn: '2026-10-03' } });
  assert(userPage(plain1).includes('data-action="users-restore"') && !userPage(plain1).includes('gs-nextstep'));
  useApi((method) => (method === 'GET' ? plain1 : { action: 'unblock', done: [], skipped: [{ key: plain1.key, name: 'Ashgrove', reason: 'outranks', message: 'That person ranks the same as you or above you, so only someone more senior can change their access.' }], cap: 25 }));
  await G.pages.user.load({ name: 'user', gid: 'g1', key: plain1.key }, gd);
  G.handlers.click['users-restore'](el({}));
  await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body]), [['/api/guild/g1/users/unblock', { keys: [plain1.key] }]]);
  assert(G.pages.users.state().flash.tone === 'warning' && G.pages.users.state().flash.text.startsWith('That person ranks the same as you'));
});

check('user page: a person without an account says so, a name shows where it was seen and has neither characters nor a menu, a missing user is a message, a failed read has Try again', async () => {
  resetBrowser();
  const person = account({ kind: 'person', name: 'Bramblewick', identity: { account: null, battlenet: false, signInMethods: [] }, permission: null, permissions: [] });
  const html = userPage(person);
  assert(text(html).includes('Account No account yet') && !html.includes('id="permission"') && html.includes('id="characters"'));
  const named = { key: 'n_616c6465', kind: 'name', segment: 'nonmembers', name: 'Alderwood', identity: { account: null, battlenet: false, signInMethods: [] }, main: null, characters: [], permission: null, permissions: [], lastSeen: '2026-10-12',
    block: { blocked: false, pendingReview: false, blockedOn: null }, flags: {}, tags: ['raid_log', 'loot'], sightings: [{ source: 'loot', date: '2026-10-09', detail: 'Sword of Doom' }, { source: 'raid_log', date: '2026-10-12', detail: 'Gruul night' }] };
  const nameHtml = userPage(named);
  assert(!nameHtml.includes('id="characters"') && text(nameHtml).includes('Seen in Loot Sword of Doom · Oct 9 Raid log Gruul night · Oct 12') && text(nameHtml).includes('Seen in Raid log · Loot'));
  assert(!nameHtml.includes('user-more') && !nameHtml.includes('Block user'), 'a name has nothing to block and nowhere else to go');
  assert(nameHtml.includes('href="#/g/g1/users/non-members"'), 'back to its segment');
  const gd = gdOf(); G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1';
  useApi(() => { throw refuse(404, { error: 'not_found', message: 'That user was not found.' }); });
  await G.pages.user.load({ name: 'user', gid: 'g1', key: 'u_nobody' }, gd);
  const gone = G.pages.user.main({ name: 'user', gid: 'g1', key: 'u_nobody' }, gd);
  assert(text(gone).includes('That user was not found.') && gone.includes('href="#/g/g1/users"'));
  useApi(() => { throw refuse(0, null); });
  await G.pages.user.load({ name: 'user', gid: 'g1', key: 'u_nobody' }, gd);
  const failed = G.pages.user.main({ name: 'user', gid: 'g1', key: 'u_nobody' }, gd);
  assert(failed.includes('data-action="users-user-retry"') && text(failed).includes('We couldn\'t load this user.'));
  assert(/Loading the user/.test(G.pages.user.main({ name: 'user', gid: 'g1', key: 'u_other' }, gd)) && /<h1[^>]*>User<\/h1>/.test(G.pages.user.main({ name: 'user', gid: 'g1', key: 'u_other' }, gd)));
});

check('user page: the trail\'s last crumb is the user\'s name once the page has read them (the app\'s context carries it), nothing for another user', async () => {
  resetBrowser();
  const gd = gdOf(); G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1'; G.app.state.section = 'guild';
  const route = { name: 'user', gid: 'g1', key: key(1) };
  const crumbs = () => G.shell.breadcrumbItems(G.app.buildCtx(route)).map((crumb) => crumb.label);
  assert.equal(G.app.buildCtx(route).leafName, '', 'nothing read yet');
  assert.equal(crumbs().slice(-2).join(' / '), 'Users / User', 'until then the placeholder');
  useApi(() => account());
  await G.pages.user.load(route, gd);
  assert.equal(G.app.buildCtx(route).leafName, 'Ashgrove');
  assert.equal(crumbs().slice(-2).join(' / '), 'Users / Ashgrove');
  assert.equal(G.app.buildCtx({ name: 'user', gid: 'g1', key: key(2) }).leafName, '', 'the page holds another user');
  assert.equal(G.pages.user.nameFor({ name: 'user', gid: 'g2', key: key(1) }), '', 'another guild');
});

check('user page: Blocked on is a date like "Oct 3" and carries the year only when it is not this year', () => {
  resetBrowser();
  const year = new Date().getFullYear();
  const panelOf = (blockedOn) => text(userPage(account({ segment: 'blocked', block: { blocked: true, pendingReview: false, blockedOn, blockedBy: 'Officer', reason: 'Rude' } })).replace(/^[\s\S]*?id="block"/, ''));
  assert(panelOf(`${year}-10-03`).includes('Blocked on Oct 3 Reason Rude Blocked by Officer'), panelOf(`${year}-10-03`));
  assert(!panelOf(`${year}-10-03`).includes(String(year)), 'this year: no year');
  assert(panelOf(`${year - 1}-12-24`).includes(`Blocked on Dec 24, ${year - 1} Reason`), 'another year keeps it');
});

// The Users block of guild.css, whole and its phone parts (the phone tab bar is 64 px at 600 px and below).
const usersCss = () => {
  const css = read('guild.css');
  const block = css.slice(css.indexOf('/* Users list (T1'), css.indexOf('/* == end B8a Users == */'));
  const phone = (query) => { const at = block.indexOf(`@media (${query}) {`); return at < 0 ? '' : block.slice(at, block.indexOf('\n}\n', at)); };
  return { css, block, p760: phone('width <= 760px'), p600: phone('width <= 600px') };
};

check('phone: the selection bar sits above the 64 px tab bar (bottom: 64px at 600 px and below), the desktop bar stays at the bottom', () => {
  resetBrowser();
  const { css, block, p600 } = usersCss();
  assert(/\.gs-tabs \{ display: block; position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; height: 64px/.test(css), 'the tab bar is 64 px and fixed to the bottom');
  assert(/\n\.gs-us-selbar \{ position: sticky; bottom: 0;/.test(block), 'desktop: bottom 0');
  assert(/\n  \.gs-us-selbar \{ bottom: 64px; \}/.test(p600), 'phone: above the tab bar, like the other sticky bars');
  assert(/\.gs-savebar, \.gs-commitbar \{ bottom: 64px;/.test(css), 'the same offset the Save bar uses');
});

check('phone: "Show all N" is a 44 px target, and so is every row of Edit permission (one label over the whole row, box included)', () => {
  resetBrowser();
  const { block, p600, p760 } = usersCss();
  const more = listHtml([row(1), row(2)], { more: true });
  assert(/<p class="gs-fine gs-us-pfoot">[^<]*<button type="button" class="gs-linkbtn" data-action="users-all"[^>]*>Show all 53<\/button><\/p>/.test(more.replace(/\n/g, '')), 'the phone foot holds the button');
  assert(/\.gs-us-pfoot \.gs-linkbtn \{ min-height: 44px; display: inline-flex; align-items: center; \}/.test(p600), 'Show all: 44 px high');
  const html = G.pages.user.editPermissionDialogHtml({ guildData: gdOf(), data: account(), customRoles: [], meId: ME });
  assert(/^<form class="gs-dialog-form gs-forge gs-dialog-settings gs-us-perm"/.test(html), 'the dialog is the scope of the rule');
  const boxes = [...html.matchAll(/<div class="gs-check"><input type="checkbox" id="([^"]+)"[^>]*><label for="\1">/g)];
  assert(boxes.length >= 2 && boxes.length === count(html, /class="gs-check"/g), `every tick row is a box with its own label (${boxes.length})`);
  assert(/\.gs-us-perm \.gs-check \{ position: relative; min-height: 44px; \}/.test(p760), 'the row is 44 px and the anchor of the label');
  assert(/\.gs-us-perm \.gs-check label \{ flex: 1 1 auto; \}/.test(p760) && /\.gs-us-perm \.gs-check label::after \{ content: ""; position: absolute; inset: 0; \}/.test(p760), 'the label stretches over the whole row');
  assert(!block.replace(p760, '').includes('.gs-us-perm'), 'only on the phone');
});

// ---------------------------------------------------------------------------
// 4. The hand-over

check('hand-over: the confirm says what moves (a guild with a seat only moves the seat; one without makes the previous Owner an Officer); the Owner is asked for the sign-in as step 2 with the person kept for the repeat', async () => {
  resetBrowser();
  const seat = G.pages.user.handOverDialogHtml({ name: 'Ashgrove', ownerSeat: true });
  assert(/<h2[^>]*id="dlg-title">Hand over the Owner seat to Ashgrove\?<\/h2>/.test(seat) && text(seat).includes('Setup, ranks and hand-overs are the Owner\'s alone. Nobody is made Officer by this.'));
  assert(text(seat).includes('What moves Owner seat From you to Ashgrove You Stay a member with the powers of your in-game rank and your hand-set roles Ashgrove Keeps their own rank powers and roles, and gains the Owner powers'));
  assert(seat.includes('data-submit="users-handover-form"') && seat.includes('data-action="dialog-cancel"') && seat.includes('autofocus') && seat.includes('>Hand over</span>'));
  const legacy = G.pages.user.handOverDialogHtml({ name: 'Ashgrove', ownerSeat: false });
  assert(text(legacy).includes('You Become an Officer') && !legacy.includes('Nobody is made Officer'));
  assertEscaped(G.pages.user.handOverDialogHtml({ name: HOSTILE + QUOTES, ownerSeat: true }), 'hand-over');
  // opening it
  const gd = gdOf(null, { owner: { name: 'Me', you: true } }); G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1';
  const data = account();
  useApi(() => data);
  await G.pages.user.load({ name: 'user', gid: 'g1', key: data.key }, gd);
  G.handlers.click['users-handover-open'](el({}));
  assert(opened[0].includes('Hand over the Owner seat to Ashgrove?') && opened[0].includes('Nobody is made Officer'));
  // the step: 403 fresh_required with the purpose and the person
  const steps = [];
  const realToStep = G.fresh.toStep;
  G.fresh.toStep = (o) => { steps.push(o); return true; };
  useApi(() => { throw refuse(403, { error: 'fresh_required', message: 'Confirm it is you first.', purpose: 'handover', params: { targetUserId: data.key } }); });
  const { form } = formIn({});
  G.handlers.submit['users-handover-form'](form);
  await settle();
  G.fresh.toStep = realToStep;
  assert.equal(steps.length, 1);
  assert.deepEqual(plain(steps[0].act), { kind: 'handover', data: { targetUserId: data.key, name: 'Ashgrove' } });
  assert.equal(steps[0].stepLabel, 'Hand over the Owner seat - step 2 of 2');
  assert.equal(steps[0].primaryLabel, 'Sign in and hand over');
  assert.equal(steps[0].returnTo, `#/g/g1/users/u/${data.key}`);
  assert.equal(steps[0].gid, 'g1');
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['POST', `/api/guild/g1/people/${data.key}/guild-master`]]);
});

check('hand-over: recipient_not_live names the person in the dialog, a lost race is the app\'s conflict, { handedOver: true } goes Home, a full answer reads the page again, the repeat after the sign-in does the same', async () => {
  resetBrowser();
  const gd = gdOf(null, { owner: { name: 'Me', you: true } }); G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1';
  const data = account();
  useApi(() => data);
  await G.pages.user.load({ name: 'user', gid: 'g1', key: data.key }, gd);
  const dlgErr = element('dlg-error');
  useApi(() => { throw refuse(409, { error: 'recipient_not_live', message: 'That person has no character proved by Battle.net on the in-game roster, so they could not hold the guild.', field: 'uid' }); });
  const refused = formIn({});
  G.handlers.submit['users-handover-form'](refused.form);
  await settle();
  assert.equal(dlgErr.textContent, 'Ashgrove has no character on the guild roster that Battle.net has confirmed for their account, so they cannot take the seat. Ask them to sign in with Battle.net first.');
  assert.equal(refused.dlg.closed, 0, 'nothing is written, the dialog stays');
  // the previous Owner may not read the list any more: the bare answer
  const refreshed = [];
  G.app.refreshGuild = (gid) => { refreshed.push(gid); return Promise.resolve(); };
  useApi(() => ({ handedOver: true }));
  const bare = formIn({});
  G.handlers.submit['users-handover-form'](bare.form);
  await settle();
  assert.deepEqual(refreshed, ['g1']);
  assert.deepEqual(goes, ['#/g/g1']);
  assert.equal(bare.dlg.closed, 1);
  // a full answer: the guild is read again and the page too, with a banner
  goes.length = 0;
  G.app.state.guilds.g1 = gd;
  useApi((method) => (method === 'POST' ? { people: [], removed: [] } : Object.assign({}, data, { permissions: [{ role: 'guild_master', label: 'Guild Master', sources: ['owner'] }], flags: { owner: true } })));
  const full = formIn({});
  G.handlers.submit['users-handover-form'](full.form);
  await settle();
  assert.deepEqual(goes, []);
  assert.equal(G.pages.users.state().flash.title, 'Ashgrove now holds the Owner seat.');
  // the repeat after #/fresh?done=handover
  assert(G.fresh.hasAct('handover'));
  useApi(() => ({ handedOver: true }));
  const home = await G.fresh.repeat({ kind: 'handover', gid: 'g1', purpose: 'handover', params: { targetUserId: data.key }, data: { targetUserId: data.key, name: 'Ashgrove' }, provider: 'bnet', returnTo: '', at: Date.now() });
  assert.equal(home, '#/g/g1');
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['POST', `/api/guild/g1/people/${data.key}/guild-master`]]);
  useApi(() => ({ people: [], removed: [] }));
  assert.equal(await G.fresh.repeat({ kind: 'handover', gid: 'g1', purpose: 'handover', params: {}, data: { targetUserId: data.key, name: 'Ashgrove' }, provider: null, returnTo: '', at: Date.now() }), `#/g/g1/users/u/${data.key}`);
  useApi(() => { throw refuse(409, { error: 'recipient_not_live', message: 'x' }); });
  let failure = null;
  try { await G.fresh.repeat({ kind: 'handover', gid: 'g1', purpose: 'handover', params: {}, data: { targetUserId: data.key, name: 'Ashgrove' }, provider: null, returnTo: '', at: Date.now() }); } catch (e) { failure = e; }
  assert(failure && failure.message.startsWith('Ashgrove has no character on the guild roster'), 'the repeat names the person too');
  const noData = await G.fresh.repeat({ kind: 'handover', gid: 'g1', purpose: 'handover', params: {}, data: null, provider: null, returnTo: '', at: Date.now() });
  assert.equal(noData, null, 'no person to hand over to: nothing is run');
});

check('Edit permission: Save closes the dialog and reads the guild and the page again; a refusal stays in the dialog', async () => {
  resetBrowser();
  const gd = gdOf(); G.app.state.guilds.g1 = gd; G.app.state.currentGid = 'g1';
  const data = account({ permissions: [{ role: 'officer', label: 'Officer', sources: ['manual'] }] });
  const refreshed = [];
  G.app.refreshGuild = (gid) => { refreshed.push(gid); return Promise.resolve(); };
  useApi(() => data);
  await G.pages.user.load({ name: 'user', gid: 'g1', key: data.key }, gd);
  useApi((method) => (method === 'PUT' ? {} : data));
  const lists = { 'input[name="teamLead"]:checked': [], 'input[name="customRole"]:checked': [] };
  const saved = formIn({}, { elements: { officer: { checked: false } }, querySelectorAll: (sel) => lists[sel] || [] });
  G.handlers.submit['users-roles-form'](saved.form);
  await settle();
  assert.deepEqual(refreshed, ['g1']);
  assert.equal(saved.dlg.closed, 1);
  assert(calls.some((c) => c.method === 'PUT' && c.path === `/api/guild/g1/people/${data.key}/roles` && c.body.officer === false));
  const err = element('dlg-error');
  useApi(() => { throw refuse(403, { error: 'forbidden', message: 'You cannot give a role more than you can do yourself.' }); });
  const refused = formIn({}, { elements: { officer: { checked: true } }, querySelectorAll: (sel) => lists[sel] || [] });
  G.handlers.submit['users-roles-form'](refused.form);
  await settle();
  assert.equal(err.textContent, 'You cannot give a role more than you can do yourself.');
  assert.equal(refused.dlg.closed, 0);
});

// ---------------------------------------------------------------------------
// 5. Sync now

check('Sync now: the Guild Master of an in-game guild sees it in More with the last check; anyone else does not; it syncs, says what happened and reads the list again', async () => {
  resetBrowser();
  const gmGd = gdOf({ 'guild.access': 'guild', 'guild.teams': 'guild' }, { me: { roles: GM_ROLES, can: { 'guild.access': 'guild', 'guild.teams': 'guild' } } });
  G.app.state.guilds.g1 = gmGd; G.app.state.currentGid = 'g1';
  useApi((method, urlPath) => {
    if (method === 'GET' && /roster-sync$/.test(urlPath)) return { pinned: true, lastGood: { fetchedAt: Date.UTC(2026, 9, 28, 12, 40) }, lastAttempt: { finishedAt: Date.UTC(2026, 9, 28, 12, 40) } };
    if (method === 'POST') return { status: 'applied', members: 64, reason: null, sync: {} };
    return listReply([row(1)]);
  });
  await G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gmGd);
  const html = pageHtml(gmGd);
  assert(html.includes('data-action="users-sync"') && /Sync now<small class="gs-menu-note">Last checked Wed Oct 28, 8:40 AM ET</.test(html), html.slice(html.indexOf('users-more-list'), html.indexOf('users-more-list') + 600));
  G.handlers.click['users-sync'](el({}));
  await settle();
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/api/guild/g1/roster-sync']);
  assert.deepEqual(plain(G.pages.users.state().flash), { tone: 'success', title: 'Synced the in-game roster.', text: '64 characters read.' });
  // an officer, a hand-set guild: nothing to sync
  const officer = gdOf();
  G.app.state.guilds.g1 = officer;
  assert(!pageHtml(officer).includes('users-sync'), 'an officer is not the Guild Master');
  useApi((method, urlPath) => listReply([row(1)], { battlenetOnly: false }));
  await G.pages.users.load({ name: 'users', gid: 'g1', segment: null }, gmGd);
  G.app.state.guilds.g1 = gmGd;
  assert(!pageHtml(gmGd).includes('users-sync'), 'a guild with hand-set ranks has no roster to sync');
  // a refusal is a banner
  useApi((method) => { if (method === 'POST') throw refuse(429, { error: 'sync_too_soon', message: 'The roster was synced less than an hour ago. Try again later.' }); return listReply([row(1)]); });
  G.handlers.click['users-sync'](el({}));
  await settle();
  assert.deepEqual(plain(G.pages.users.state().flash), { tone: 'warning', title: 'The roster was not synced.', text: 'The roster was synced less than an hour ago. Try again later.' });
});

// ---------------------------------------------------------------------------
// 6. Accounts is retired

check('Accounts: both old addresses open Users (and the address is swapped), a link that still names the tab lands on Users, the page, its manifest line and its handlers are gone', () => {
  for (const tab of ['people', 'accounts']) {
    assert.deepEqual(plain(G.router.parse(`#/g/g1/settings/${tab}`)), { name: 'users', gid: 'g1', segment: null }, tab);
    assert(G.router.isRetiredAddress(`#/g/g1/settings/${tab}`), tab);
  }
  assert(!G.router.isRetiredAddress('#/g/g1/settings/roles') && !G.router.isRetiredAddress('#/g/g1/users') && !G.router.isRetiredAddress('#/g/g1/settings/people/x'));
  assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab: 'people' }), '#/g/g1/users');
  assert(!G.router.TABS.includes('people') && !G.shell.SETTINGS_TABS.some((t) => t.tab === 'people'));
  assert.equal(G.pages.people, undefined);
  assert(!fs.existsSync(path.join(ROOT, 'js/guild/pages-settings-people.js')) && !read('js/guild/manifest.js').includes('pages-settings-people'));
  for (const gone of ['person-edit-roles', 'person-remove', 'person-restore', 'person-sync', 'people-sync-all', 'gm-ask', 'gm-confirm', 'roles-form', 'remove-form', 'people-search']) {
    assert(!G.handlers.click[gone] && !G.handlers.submit[gone] && !G.handlers.input[gone], gone);
  }
  const worker = read('worker/attention.js');
  assert(worker.includes("link: { name: 'users', segment: 'blocked' }") && !worker.includes("tab: 'people'"));
  assert.equal(G.router.format({ name: 'users', gid: 'g1', segment: 'blocked' }), '#/g/g1/users/blocked');
});

check('source hygiene: pages-users.js has no inline style or handler and no non-ASCII character outside comments; the segments and the two page keys are wired', () => {
  const src = read('js/guild/pages-users.js');
  src.split('\n').forEach((line, i) => {
    assert(!/[\s`'"]style\s*=\s*(?:["'`\\]|\$\{)/.test(line), `line ${i + 1}: inline style`);
    assert(!/[\s`'"]on[a-z]{3,}\s*=\s*(?:["'`\\]|\$\{)/i.test(line), `line ${i + 1}: inline handler`);
    if (!line.trim().startsWith('//')) assert(!/[^\x00-\x7f]/.test(line), `line ${i + 1}: non-ASCII outside a comment`);
  });
  assert(src.includes("'use strict'") && !/^\s*(import|export)\s/m.test(src));
  assert(typeof G.pages.users.load === 'function' && typeof G.pages.user.load === 'function' && typeof G.pages.users.main === 'function' && typeof G.pages.user.main === 'function');
});

// ---------------------------------------------------------------------------
// 7. Worker

const KEY = 'test-tombstone-key-0123456789abcdef';
function unlimited(s) {
  const call = s.call.bind(s);
  s.call = (who, method, tail, body) => {
    if (/\/users(\/|\?|$)/.test(tail)) s.w.db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'users%'");
    return call(who, method, tail, body);
  };
  return s;
}
async function world() {
  const s = unlimited(await baseScenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY } }));
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officer');
  s.people = {};
  for (const [k, name] of [['m1', 'Memberone'], ['m2', 'Membertwo'], ['m3', 'Memberthree']]) {
    await s.member(k, name);
    s.people[k] = await s.person({ name: `M${name.slice(6)}` });
    await s.link(s.people[k].pid, k);
  }
  s.ghost = await s.person({ name: 'Ghost' });
  s.raid = addRaid(s, '2026-12-01');
  addLoot(s, s.raid, 'Lootguy');
  addPresence(s, s.raid, 'Logguy');
  return s;
}
const keyOfName = (name) => `n_${Buffer.from(name.toLowerCase(), 'utf8').toString('hex')}`;
const rowOf = (res, name) => res.rows.find((entry) => entry.name === name);

check('worker: the user page carries the roster person (personId) of an account that has one and of an account-less person, none for a name or for an account with no person', async () => {
  const s = await world();
  const members = await s.ok('off', 'GET', '/users?segment=members&limit=100');
  const mone = rowOf(members, 'Memberone');
  const page = await s.ok('off', 'GET', `/users/${mone.key}`);
  assert.equal(page.personId, s.people.m1.pid);
  const ghost = rowOf(members, 'Ghost');
  assert.equal(ghost.kind, 'person');
  assert.equal((await s.ok('off', 'GET', `/users/${ghost.key}`)).personId, ghost.key, 'an account-less person is its own roster person');
  const name = await s.ok('off', 'GET', `/users/${keyOfName('Lootguy')}`);
  assert.equal(name.kind, 'name');
  assert(!('personId' in name), 'a name has no roster person');
  await s.outsider('out1', 'Outsiderone');
  rowsOf(s, 'SELECT 1');
  const outsiderRows = (await s.ok('off', 'GET', '/users?segment=nonmembers&limit=100')).rows.filter((entry) => entry.kind === 'account');
  for (const entry of outsiderRows) assert(!('personId' in (await s.ok('off', 'GET', `/users/${entry.key}`))), `${entry.name}: no person, no personId`);
  // another guild's person is never handed out: the key of a person of this guild only
  assert((await s.call('off', 'GET', `/users/p_${'Z'.repeat(22)}`)).status, 404);
});

check('worker: the list carries battlenetOnly, ownerSeat and the core ranks the filter offers (all four in a guild with hand-set ranks, the mapped ones and Social in an in-game guild); the user page the first two', async () => {
  const s = await world();
  const legacy = await s.ok('off', 'GET', '/users');
  assert.equal(legacy.battlenetOnly, false);
  assert.deepEqual(legacy.coreRanks, ['raider', 'trial', 'reserve', 'social']);
  assert.equal(typeof legacy.ownerSeat, 'boolean');
  const page = await s.ok('off', 'GET', `/users/${rowOf(legacy, 'Memberone').key}`);
  assert.deepEqual([page.battlenetOnly, page.ownerSeat], [false, legacy.ownerSeat]);
  const gmPerson = await s.person({ name: 'Gmchar' });
  await s.link(gmPerson.pid, 'gm');
  ingameize(s, { owner: 'gm', people: { gm: gmPerson, m1: s.people.m1, m2: s.people.m2, m3: s.people.m3 } });
  const ingame = await s.ok('gm', 'GET', '/users');
  assert.equal(ingame.battlenetOnly, true);
  assert.equal(ingame.ownerSeat, true);
  assert.deepEqual(ingame.coreRanks, ['raider', 'social'], 'the map gives Raider and Social: no Trial, no Reserve');
  const ingamePage = await s.ok('gm', 'GET', `/users/${rowOf(await s.ok('gm', 'GET', '/users?segment=members&limit=100'), 'Memberone').key}`);
  assert.deepEqual([ingamePage.battlenetOnly, ingamePage.ownerSeat], [true, true]);
  assert(!('coreRanks' in ingamePage));
  // a rank map with Trial gives it to the filter
  s.exec(`UPDATE source_rank_maps SET core_rank = 'trial' WHERE guild_id = '${s.gid}' AND source = 'ingame' AND source_key = '4'`);
  assert.deepEqual((await s.ok('gm', 'GET', '/users')).coreRanks, ['raider', 'trial', 'social']);
});

check('worker: every skip reason of Block and Unblock carries its sentence (the result dialog shows the API\'s message), and the real answers draw the result dialog and the page through the chunk runner', async () => {
  const s = await world();
  const members = (await s.ok('off', 'GET', '/users?segment=members&limit=100')).rows;
  const bySelf = (await s.ok('gm', 'GET', '/users?segment=members&limit=100')).rows;
  const entries = [{ key: bySelf.find((r) => r.name === 'Gmb3').key, name: 'Gmb3' }, ...members.filter((r) => r.name !== 'Officer').map((r) => ({ key: r.key, name: r.name })), { key: keyOfName('Lootguy'), name: 'Lootguy' }, { key: `u_${'Z'.repeat(22)}`, name: null }];
  // through the real Worker: the page's runChunks with chunks of 3 (the Worker's own cap is 25)
  G.api.post = async (urlPath, body) => s.ok('off', 'POST', urlPath, body, 200);
  const out = await G.pages.users.runChunks('/users/block', entries, 3, (chunk) => ({ keys: chunk.map((e) => e.key) }));
  assert(out.done.length >= 3, 'the names that could be blocked were');
  const byReason = Object.fromEntries(out.skipped.map((entry) => [entry.reason, entry.message]));
  assert.equal(byReason.owner, 'The Owner of the guild cannot be removed.');
  assert.equal(byReason.name_only, 'A name seen in a log has no account or roster person: nothing to block. Add it to a person or leave it.');
  assert.equal(byReason.not_found, 'That user was not found.');
  for (const entry of out.skipped) assert(typeof entry.message === 'string' && entry.message.length > 10, entry.reason);
  const html = G.pages.users.resultDialogHtml({ action: 'block', total: entries.length, done: out.done, skipped: out.skipped });
  assert(text(html).includes('The Owner of the guild cannot be removed.') && text(html).includes('Lootguy') && /Blocked \d+ of \d+ users/.test(html));
  // every other reason the Worker names has a sentence too
  const sources = read('worker/users-bulk.js');
  for (const reason of ['not_found', 'name_only', 'has_account', 'self', 'owner', 'guild_master', 'outranks', 'already_blocked', 'not_blocked', 'over_cap', 'conflict']) assert(new RegExp(`\\b${reason}: `).test(sources.slice(sources.indexOf('SKIP_MESSAGES'))), reason);
  // the second Block of the same names: already_blocked
  const again = await s.ok('off', 'POST', '/users/block', { keys: [out.done[0].key] }, 200);
  assert.equal(again.skipped[0].message, 'Their access is already removed.');
  // the real list reply and the real user page draw
  const list = await s.ok('off', 'GET', '/users?segment=blocked&limit=10');
  const html2 = G.pages.users.listHtml({ guildData: gdOf(), route: { name: 'users', gid: 'g1', segment: 'blocked' }, view: viewOf({ segment: 'blocked' }), list: Object.assign({ gid: 'g1', segment: 'blocked', error: '' }, list), manage: null, pending: 0, meId: null, flash: null, notice: '', sync: null });
  assert(/Blocked users cannot sign in to Vindicated/.test(html2) && html2.includes(list.rows[0].name));
  const user = await s.ok('off', 'GET', `/users/${list.rows[0].key}`);
  assert(text(G.pages.user.userHtml({ guildData: gdOf(), data: user, meId: null, flash: null })).includes('Blocked on'));
  G.api.post = (urlPath, body) => Promise.reject(new Error('stub'));
});

check('worker: a block that waits for review shows on the list and the page, the attention item links to the Blocked list, and Keep and Restore through the page\'s own calls end it', async () => {
  const s = await world();
  pendingBlock(s, 'm3');
  const item = (await s.ok('off', 'GET', '/attention')).items.find((entry) => entry.kind === 'block_review');
  assert.deepEqual(plain(item.link), { name: 'users', segment: 'blocked' });
  assert.equal(item.pending, 1);
  assert.equal(G.router.format(Object.assign({}, item.link, { gid: 'g1' })), '#/g/g1/users/blocked');
  const blocked = await s.ok('off', 'GET', '/users?segment=blocked&limit=10');
  const crow = rowOf(blocked, 'Memberthree');
  assert.deepEqual(plain(crow.flags), { pendingReview: true });
  const page = await s.ok('off', 'GET', `/users/${crow.key}`);
  const html = G.pages.user.userHtml({ guildData: gdOf(), data: page, meId: null, flash: null });
  assert(html.includes('data-action="users-keep"') && text(html).includes('Memberthree matched an earlier block') && text(html).includes('Matched an earlier block of the same person'));
  const strip = G.pages.users.listHtml({ guildData: gdOf(), route: { name: 'users', gid: 'g1', segment: 'blocked' }, view: viewOf({ segment: 'blocked' }), list: Object.assign({ gid: 'g1', segment: 'blocked', error: '' }, blocked), manage: null, pending: item.pending, meId: null, flash: null, notice: '', sync: null });
  assert(text(strip).replace(" 's", "'s").includes('Memberthree\'s block matched an earlier one and waits for your review'));
  await s.ok('off', 'POST', `/people/${page.key}/block/keep`, {}, 200);
  assert.equal((await s.ok('off', 'GET', '/attention')).items.filter((entry) => entry.kind === 'block_review').length, 0);
  await s.ok('off', 'DELETE', `/people/${page.key}/block`, {}, 200);
  assert.equal((await s.ok('off', 'GET', `/users/${page.key}`)).block.blocked, false);
});

check('worker: the list and the page keep to their budgets with the guild facts (one more statement) and the facts are the guild\'s own - another guild\'s rank map never reaches the filter', async () => {
  const s = await world();
  const statements = s.w.db.statementLog;
  const from = statements.length;
  await s.ok('off', 'GET', '/users');
  const used = statements.slice(from).length;
  assert(used <= 12, `${used} statements for a list`);
  // (the roster rows of the list read the map too, for their rank label and core rank; the guild facts are the one statement that lists the mapped core ranks)
  const facts = statements.slice(from).filter((entry) => /FROM source_rank_maps/.test(entry.sql) && /group_concat\(m\.core_rank\)/.test(entry.sql));
  assert(facts.length === 1, 'one statement reads the mapped core ranks');
  const plan = s.w.db.sqlite.prepare(`EXPLAIN QUERY PLAN ${facts[0].sql}`).all(...facts[0].values).map((r) => r.detail).join('\n');
  assert(!/SCAN source_rank_maps|SCAN guilds/.test(plan), plan);
  const other = await baseScenario();
  other.exec(`INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id, team_id) VALUES ('${other.gid}', 'ingame', '1', 'X', 'reserve', NULL, NULL)`);
  assert.deepEqual((await s.ok('off', 'GET', '/users')).coreRanks, ['raider', 'trial', 'reserve', 'social']);
  void rowsOf;
});

// ---------------------------------------------------------------------------
// 6. Roster rows (kind 'roster': a member of the in-game roster that no character carries; 2026-10-29)

const rosterKey = (name) => `r_${Buffer.from(`${name.toLowerCase()}/dreamscythe`, 'utf8').toString('hex')}`;
function rosterRow(name, over) {
  return Object.assign({
    key: rosterKey(name), kind: 'roster', name, main: main(name, 'MAGE'), permission: null, lastSeen: null, tags: [], flags: {},
    roster: { class: 'MAGE', level: 70, realm: 'Dreamscythe', ingameRank: { rank: 1, label: 'Officer' }, coreRank: 'raider' },
  }, over || {});
}

check('roster rows (list): the character, its in-game rank and core rank, a dash for Last seen, no box in selection mode; a pinned guild\'s row says In-game roster in the cell, the phone row and the filter', () => {
  resetBrowser();
  const html = listHtml([rosterRow('Rosteralpha'), row(1, { name: 'Zed' })]);
  assert(html.includes(`<a class="gs-person gs-us-user" href="#/g/g1/users/u/${rosterKey('Rosteralpha')}">`));
  assert(text(html).includes('Rosteralpha Officer · Raider'), 'line 2 of the cell: the in-game rank and the core rank');
  assert(html.includes('<span class="gs-char-name gs-class-mage">Rosteralpha</span>'), 'the character in its class colour');
  const mine = html.slice(html.indexOf('Rosteralpha'), html.indexOf('Zed'));
  assert(mine.includes('aria-label="No activity">—</span>') && mine.includes('<span class="gs-muted">None</span>'), 'no Last seen, no permission');
  // A pinned guild: Non-members, tagged; an unmapped rank reads "Rank 7" and Social.
  const non = rosterRow('Rosterdelta', { tags: ['ingame_roster'], roster: { class: 'PRIEST', level: 20, realm: 'Dreamscythe', ingameRank: { rank: 7, label: null }, coreRank: 'social' } });
  const pinned = listHtml([non], { segment: 'nonmembers', battlenetOnly: false }, { view: viewOf({ segment: 'nonmembers' }) });
  assert(text(pinned).includes('Rosterdelta In-game roster · Rank 7 · Social'), 'the tag, then the rank');
  const phone = pinned.slice(pinned.indexOf('class="gs-rs-phone"'));
  assert(phone.includes('In-game roster, Rank 7, Social · <span class="gs-muted">—</span>'), 'the phone row: the facts, then a dash for no day');
  const filter = pinned.slice(pinned.indexOf('id="users-from"')).split('</select>')[0];
  assert(filter.includes('<option value="ingame_roster">In-game roster</option>'));
  const picked = listHtml([rosterRow('Rosteralpha'), row(1, { name: 'Zed' })], {}, { manage: { picked: {} } });
  assert(!picked.includes(`data-pick="${rosterKey('Rosteralpha')}"`) && picked.includes(`data-pick="${key(1)}"`), 'a roster row has nothing to select, a user does');
  assertNoRawAttrs(html);
  assertNoRawAttrs(pinned);
  const hostile = listHtml([rosterRow(HOSTILE + QUOTES, { tags: ['ingame_roster'], roster: { class: 'MAGE', level: 1, realm: HOSTILE, ingameRank: { rank: 2, label: HOSTILE + QUOTES }, coreRank: HOSTILE } })]);
  assertEscaped(hostile, 'roster row');
});

check('roster rows (user page): the in-game facts as a panel (character, class, level, in-game rank, core rank, realm), no characters panel, no block, no More; the head names the segment and rank', () => {
  resetBrowser();
  const data = (over) => Object.assign({
    key: rosterKey('Rosteralpha'), kind: 'roster', segment: 'members', name: 'Rosteralpha', identity: { account: null, battlenet: false, signInMethods: [] }, main: main('Rosteralpha', 'MAGE'),
    characters: [], roster: { class: 'MAGE', level: 70, realm: 'Dreamscythe', ingameRank: { rank: 1, label: 'Officer' }, coreRank: 'raider' }, permission: null, permissions: [], lastSeen: null,
    block: { blocked: false, pendingReview: false, blockedOn: null }, flags: {}, tags: [], sightings: [], battlenetOnly: true, ownerSeat: true,
  }, over || {});
  const html = userPage(data());
  assert(/<h1[^>]*>Rosteralpha<\/h1>/.test(html) && html.includes('Member · Officer'));
  const panel = text(html.slice(html.indexOf('id="roster"'), html.indexOf('id="identity"')));
  assert(panel.includes('In-game roster') && panel.includes('Character Rosteralpha') && panel.includes('Class Mage') && panel.includes('Level 70') && panel.includes('In-game rank Officer') &&
    panel.includes('Core rank Raider') && panel.includes('Realm Dreamscythe'), panel);
  assert(!html.includes('id="characters"') && !html.includes('id="permission"') && !html.includes('id="block"') && !html.includes('user-more') && !html.includes('users-user-block'));
  const identity = text(html.slice(html.indexOf('id="identity"')));
  assert(identity.includes('Account No account yet') && identity.includes('Last seen —'));
  // A pinned guild: a Non-member tagged In-game roster; an unmapped rank reads "Rank 7".
  const pinned = userPage(data({ segment: 'nonmembers', tags: ['ingame_roster'], battlenetOnly: false, roster: { class: 'PRIEST', level: null, realm: 'Dreamscythe', ingameRank: { rank: 7, label: null }, coreRank: 'social' } }));
  assert(pinned.includes('Non-member · Rank 7') && text(pinned.slice(pinned.indexOf('id="identity"'))).includes('Seen in In-game roster'));
  const panel2 = text(pinned.slice(pinned.indexOf('id="roster"'), pinned.indexOf('id="identity"')));
  assert(panel2.includes('In-game rank Rank 7') && panel2.includes('Core rank Social') && !panel2.includes('Level') && !panel2.includes('Rank comes from'), panel2);
  assertNoRawAttrs(html);
  assertEscaped(userPage(data({ name: HOSTILE + QUOTES, roster: { class: 'MAGE', level: 70, realm: HOSTILE + QUOTES, ingameRank: { rank: 1, label: HOSTILE + QUOTES }, coreRank: 'raider' } })), 'roster page');
});


runChecks(checks);
