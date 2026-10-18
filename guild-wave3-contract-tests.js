/**
 * Raidsmith guild tracker - PM wave 3 CONTRACT tests (Worker <-> pages)
 * Run: node guild-wave3-contract-tests.js [name-filter]
 *
 * guild-wave3-worker-tests.js and guild-wave3-ui-tests.js each work from the spec with hand-made data on the other side. This suite joins them, the way
 * guild-wave2-contract-tests.js does: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite
 * D1 stand-in) through G.api, their real click / change / submit handlers run, and what they draw from the real answers is checked next to what the
 * Worker stored. The buff coverage on the intent and recruiting pages comes from the Planner's own rosterBuffCoverage (tests/load-app.js), wired in
 * as the page would find it. One check per thing a person can see: the default team size, the intent board (officer, member), recruitment needs and
 * the post, the apply form (signed out and signed in) with the inbox, Accept and the Home line, the CSV import.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const planner = require('./tests/load-app');

const ROOT = __dirname;
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000001';
const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  hank: { id: '110000000000000008', username: 'hank', globalName: 'Hank H' },
};
const NOW = Date.parse('2026-10-17T16:00:00Z'); // Saturday 12:00 in New York
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const el = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const ctrl = (value, extra) => Object.assign({ value, checked: false, focus() {}, setAttribute() {} }, extra || {});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

// The Planner, loaded the way its own suites load it: the page finds rosterBuffCoverage as a global.
const plannerApi = planner.sandbox(['rosterBuffCoverage']).api;

// ---------------------------------------------------------------------------
// The Worker side

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0 };
  const discordFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    discord.calls++;
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${discord.calls}`;
      discord.tokens.set(token, discord.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec((init.headers && init.headers.Authorization) || '');
    const session = bearer && discord.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  const clock = { now: NOW };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = { DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`, GUILD_CREATOR_ALLOWLIST: PEOPLE.alice.id };
  const app = createApp({ db, env, fetch: discordFetch, now: () => clock.now, randomBytes, log: () => {} });
  return { db, clock, discord, app };
}

function absorb(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[pair.slice(0, index)];
    else jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

const fetchFor = (world, jar) => async (urlPath, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await world.app.handle(new Request(`${ORIGIN}${urlPath}`, { method: init.method, headers, body: init.body }));
  absorb(jar, response);
  return response;
};

async function signIn(world, person, servers) {
  const jar = {};
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await fetchFor(world, jar)('/auth/login', { method: 'GET' });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await fetchFor(world, jar)(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { method: 'GET' });
  return jar;
}

// ---------------------------------------------------------------------------
// The pages side

function loadPages(world, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  sandbox.rosterBuffCoverage = plannerApi.rosterBuffCoverage;
  const G = sandbox.Guild;
  const f = fetchFor(world, jar);
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  G.jar = jar;
  G.dialogs = [];
  G.texts = {};
  G.errors = [];
  G.ui.openDialog = (html) => { G.dialogs.push(html); return null; };
  G.ui.runDialog = (form, promise, onOk) => promise.then(onOk);
  G.ui.setText = (id, text) => { G.texts[id] = text; };
  G.ui.setBusy = () => {};
  G.ui.closeDialogOf = () => {};
  G.ui.focusByKey = () => false;
  G.app.handleError = (err) => { G.errors.push(err); };
  G.app.go = (hash) => { G.went = hash; };
  G.app.refreshGuild = () => {};
  return G;
}

const MEMBER_SERVER = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
const ROSTER = [
  ['Thoren', 'PALADIN', 'Protection', 'raider', 'erin'],
  ['Gorrim', 'PRIEST', 'Holy', 'raider', null],
  ['Kaelith', 'ROGUE', 'Combat', 'trial', null],
  ['Mirabel', 'HUNTER', 'Marksmanship', 'raider', null],
];

async function scenario({ version = 'forever', teams = ['Alpha'] } = {}) {
  const world = await makeWorld();
  const aliceJar = await signIn(world, PEOPLE.alice, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const A = loadPages(world, aliceJar);
  const body = { serverId: SERVER, gameVersion: version, region: 'US', realm: version === 'forever' ? 'Normal' : 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: teams.length > 1 };
  if (teams.length > 1) body.teamNames = teams;
  const created = await A.api.post('/api/guild', body);
  const gid = created.guild.id;
  const teamIds = created.teams.map((team) => team.id);
  const base = `/api/guild/${gid}`;
  const people = {};
  for (const [name, cls, main, status, who] of ROSTER) {
    const made = await A.api.post(`${base}/roster`, { teamId: teamIds[0], name, class: cls, mainSpec: main, offSpec: null, status });
    people[name] = made.person.id;
    if (who) world.db.sqlite.exec(`UPDATE players SET discord_user_id = '${PEOPLE[who].id}' WHERE id = '${made.person.id}'`);
  }
  const E = loadPages(world, await signIn(world, PEOPLE.erin, MEMBER_SERVER));
  const s = { world, A, E, gid, teamId: teamIds[0], teamIds, base, people, version };
  for (const G of [A, E]) G.guildData = await G.api.get(base);
  s.rows = (sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results);
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// The state bag the pages keep, reset for a fresh page.
function pageState(s, G, teamId) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: G.guildData };
  S.currentGid = s.gid;
  S.pageAlert = '';
  S.imports = {};
  S.roster = null;
  G.app.teamFor = () => teamId || s.teamId;
  return S;
}
const open = async (s, G, name, extra) => {
  pageState(s, G);
  const route = Object.assign({ name, gid: s.gid }, extra || {});
  await G.pages[name].load(route, G.guildData);
  return () => G.pages[name].main(route, G.guildData, { guildData: G.guildData });
};

// ---------------------------------------------------------------------------

check('default team size: a WoW Forever guild\'s team is 20-man on Team settings, and the Add team dialog starts at 20 and creates a 20-man team', async () => {
  const s = await scenario({ version: 'forever' });
  const { A } = s;
  pageState(s, A);
  assert(/20-man/.test(stripTags(A.pages.teams.teamsHtml({ guildData: A.guildData }))));
  A.ui.openDialog = (html) => { A.dialogs.push(html); return null; };
  A.handlers.click['team-add'](el({}));
  assert(/<option value="20" selected>/.test(A.dialogs[0]), A.dialogs[0].slice(0, 400));
  await A.handlers.submit['team-form'](el({ 'data-gid': s.gid, 'data-mode': 'add' }, { elements: { name: ctrl('Weekend'), size: ctrl('20') }, querySelector: () => null }));
  await settle();
  assert.equal((await s.rows("SELECT size FROM teams WHERE name = 'Weekend'"))[0].size, 20);
  const tbc = await scenario({ version: 'tbc' });
  assert.equal((await tbc.rows('SELECT size FROM teams'))[0].size, 25);
});

check('intent board: an officer opens a round, a member picks (main and alt) with their own page, the board and its buff coverage - the Planner\'s own - follow for everyone', async () => {
  const s = await scenario({ version: 'forever' });
  const { A, E } = s;
  // Nothing yet: the officer is offered the first round, the member is told to wait.
  let page = await open(s, A, 'intent');
  assert(stripTags(page()).includes('No spec poll yet') && page().includes('data-action="intent-open"'));
  let member = await open(s, E, 'intent');
  assert(stripTags(member()).includes('Your officers have not opened a spec poll'));
  // The officer opens the WoW Forever launch round.
  A.handlers.click['intent-open'](el({}));
  assert(A.dialogs[0].includes('value="WoW Forever launch"'));
  await A.handlers.submit['intent-open-form']({ elements: { title: ctrl('WoW Forever launch'), closesOn: ctrl('') } });
  await settle();
  const round = (await s.rows('SELECT id, title, status, closes_on FROM intent_rounds'))[0];
  assert.deepEqual([round.title, round.status, round.closes_on], ['WoW Forever launch', 'open', null]);
  // Erin (Thoren) sees the open round and picks: a Prot Warrior main and a Fire Mage alt.
  member = await open(s, E, 'intent');
  let text = stripTags(member());
  assert(text.includes('WoW Forever launch') && text.includes('Set my pick') && text.includes('Not picked yet (4)'), text.slice(0, 700));
  E.handlers.click['intent-edit'](el({ 'data-pid': s.people.Thoren }));
  const dialog = E.dialogs[E.dialogs.length - 1];
  assert(dialog.includes('Your pick for WoW Forever launch'));
  const form = { getAttribute: () => s.people.Thoren, elements: {
    mainClass: ctrl('WARRIOR'), mainSpec: ctrl('Protection'), mainNote: ctrl('Tanking at launch'), altClass: ctrl('MAGE'), altSpec: ctrl('Fire'), altNote: ctrl('') } };
  await E.handlers.submit['intent-pick-form'](form);
  await settle();
  const picks = await s.rows('SELECT kind, class, spec, role, note FROM intent_picks ORDER BY kind');
  assert.deepEqual(plain(picks), [{ kind: 'alt', class: 'MAGE', spec: 'Fire', role: 'ranged', note: null }, { kind: 'main', class: 'WARRIOR', spec: 'Protection', role: 'tank', note: 'Tanking at launch' }]);
  // The officer sets Gorrim's pick for her, then reads the board.
  A.handlers.click['intent-edit'](el({ 'data-pid': s.people.Gorrim }));
  await A.handlers.submit['intent-pick-form']({ getAttribute: () => s.people.Gorrim, elements: {
    mainClass: ctrl('PRIEST'), mainSpec: ctrl('Holy'), mainNote: ctrl(''), altClass: ctrl(''), altSpec: ctrl(''), altNote: ctrl('') } });
  await settle();
  page = await open(s, A, 'intent');
  const out = page();
  text = stripTags(out);
  assert(text.includes('2 of 20 spots picked') && text.includes('Against a 20-man raid') && text.includes('Not picked yet (2)'), text.slice(0, 900));
  const rows = [...out.matchAll(/<tr><th scope="row" class="gs-cell-strong">([^<]+)<\/th><td class="gs-num" data-label="Picked">(\d+)<\/td><td class="gs-num" data-label="Target">(\d+)<\/td><td data-label="Gap">([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], +m[2], +m[3], m[4]]);
  assert.deepEqual(rows, [['Tanks', 1, 2, 'Need 1'], ['Healers', 1, 5, 'Need 4'], ['Melee DPS', 0, 7, 'Need 7'], ['Ranged DPS', 0, 6, 'Need 6']], 'forever 20-man defaults');
  assert(text.includes('Tanking at launch') && text.includes('Warrior Protection') && text.includes('Mage Fire') && text.includes('Priest Holy'));
  // The coverage panel is the Planner's own answer for the two main picks.
  const expected = plannerApi.rosterBuffCoverage([{ class: 'WARRIOR', spec: 'Protection' }, { class: 'PRIEST', spec: 'Holy' }], 'forever', 20);
  const covered = (entries) => entries.filter((e) => e.covered).map((e) => e.name);
  for (const name of covered(expected.buffs).concat(covered(expected.debuffs))) assert(text.includes(name), `${name} should be listed`);
  assert(text.includes(`${covered(expected.buffs).length} of ${expected.buffs.length} buffs, ${covered(expected.debuffs).length} of ${expected.debuffs.length} debuffs`), text.slice(0, 1500));
  assert(covered(expected.debuffs).length > 0 && covered(expected.buffs).length > 0, 'the picks cover something, so the check above means something');
  // Close: asks, then the round is closed and stays readable; the member can no longer pick.
  A.handlers.click['intent-close'](el({}));
  assert(A.dialogs[A.dialogs.length - 1].includes('Close this round?'));
  await A.handlers.submit['intent-close-form']({});
  await settle();
  assert.equal((await s.rows('SELECT status FROM intent_rounds'))[0].status, 'closed');
  member = await open(s, E, 'intent');
  text = stripTags(member());
  assert(text.includes('Closed') && !text.includes('Set my pick') && text.includes('Tanking at launch'), text.slice(0, 500));
  assert.equal(E.errors.length + A.errors.length, 0);
});

check('recruitment needs: the counts from the real roster, the targets saved and reset, the spec poll laid over, and the recruiting post with the schedule and the apply link', async () => {
  const s = await scenario({ version: 'tbc' });
  const { A, E } = s;
  await A.api.put(`${s.base}/teams/${s.teamId}/schedule`, { slots: [{ weekday: 2, startTime: '20:00', zone: 'Karazhan' }, { weekday: 4, startTime: '20:30' }], weeks: 2, auto: false });
  const page = await open(s, A, 'recruiting');
  let out = page();
  let text = stripTags(out);
  assert(text.includes('Roles against the targets') && text.includes('Main team') && text.includes('Recruiting'));
  // Thoren is the tank, Gorrim a healer, Kaelith (Trial) melee, Mirabel ranged: gaps against the 25-man defaults 3 / 6 / 8 / 8.
  const rows = [...out.matchAll(/<tr><th scope="row" class="gs-cell-strong">([^<]+)<\/th><td class="gs-num" data-label="On the roster">(\d+)<\/td>/g)].map((m) => [m[1], +m[2]]);
  assert.deepEqual(rows, [['Tanks', 1], ['Healers', 1], ['Melee DPS', 1], ['Ranged DPS', 1]]);
  const post = out.match(/<textarea[^>]*id="rt-post"[^>]*>([\s\S]*?)<\/textarea>/)[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert(post.startsWith('Ember is recruiting for Main team!\nTBC Anniversary - Nightslayer (US)\nRaid days: Tue 8:00 PM, Thu 8:30 PM (America/New_York)\nLooking for: 2 Tanks, 5 Healers, 7 Melee DPS, 7 Ranged DPS\n'), post);
  assert(post.includes('To apply, message an officer on Discord.'), 'applications are off');
  // Applications on: the post gets the address.
  await A.api.put(`${s.base}/applications/settings`, { enabled: true, questions: [] });
  const again = await open(s, A, 'recruiting');
  assert(again().match(/<textarea[^>]*id="rt-post"[^>]*>([\s\S]*?)<\/textarea>/)[1].includes(`Apply: /#/apply/${s.gid}`));
  // Targets: save, see the new gap, reset.
  await A.handlers.submit['recruiting-form']({ elements: { tank: ctrl('1'), healer: ctrl('1'), melee: ctrl('1'), ranged: ctrl('1') } });
  await settle();
  assert.equal((await s.rows('SELECT recruit_targets AS t FROM teams'))[0].t, '{"tank":1,"healer":1,"melee":1,"ranged":1}');
  out = A.pages.recruiting.main({ name: 'recruiting', gid: s.gid }, A.guildData);
  assert(stripTags(out).includes('Targets saved.') && out.includes('data-action="recruiting-reset"') && !stripTags(out).includes('against the usual targets'));
  await A.handlers.click['recruiting-reset']();
  await settle();
  assert.equal((await s.rows('SELECT recruit_targets AS t FROM teams'))[0].t, null);
  // A plain member cannot open it: the Worker refuses the load.
  pageState(s, E);
  await assert.rejects(E.pages.recruiting.load({ name: 'recruiting', gid: s.gid }, E.guildData), (error) => error.status === 403);
  assert(!E.pages.rosterTabs.html(E.guildData, 'roster').includes('Recruiting'), 'and the tab is not offered');
});

check('applications: a signed-out and a signed-in applicant use the apply form, the officer sees both in the inbox and on Home, Accept makes a Trial with the account linked, and the settings page edits the questions', async () => {
  const s = await scenario({ version: 'forever' });
  const { A } = s;
  const H = loadPages(s.world, await signIn(s.world, PEOPLE.hank, []));
  const V = loadPages(s.world, {});
  // Settings: the officer turns it on with two questions (the real form handler reads the page's draft).
  A.app.state.att = {}; A.app.state.guilds = { [s.gid]: A.guildData }; A.app.state.currentGid = s.gid;
  await A.pages.settingsApply.load({ name: 'settings', gid: s.gid, tab: 'applications' }, A.guildData);
  const x = A.app.state.att.settingsApply;
  assert(stripTags(A.pages.settingsApply.main({}, A.guildData, { guildData: A.guildData })).includes('Your questions (0 of 8)'));
  x.draft.enabled = true;
  x.draft.questions.push({ id: '', label: 'Why Ember?', type: 'long', options: '', required: true }, { id: '', label: 'Raid experience', type: 'choice', options: 'New\nVeteran', required: false });
  A.handlers.submit['apply-settings-form']();
  await settle();
  assert.equal(x.note, 'Applications are on.');
  const questions = JSON.parse((await s.rows('SELECT apply_questions AS q FROM guilds'))[0].q);
  assert.deepEqual(questions.map((q) => [q.label, q.type, q.required]), [['Why Ember?', 'long', true], ['Raid experience', 'choice', false]]);
  assert(A.pages.settingsApply.main({}, A.guildData, { guildData: A.guildData }).includes(`/#/apply/${s.gid}`));
  // The signed-out applicant opens the form, sees the questions and sends.
  await V.pages.apply.load({ name: 'apply', gid: s.gid });
  let page = V.pages.apply.applyHtml({ state: V.app.state.apply });
  let text = stripTags(page);
  assert(text.includes('Apply to Ember') && text.includes('Why Ember?') && text.includes('Raid experience') && text.includes('You can apply without an account'), text.slice(0, 500));
  const values = (over) => Object.assign({ name: 'Walkin', class: 'ROGUE', spec: 'Combat', contact: 'Walkin#1', teamId: '', website: '', ['q:' + questions[0].id]: 'We raid late', ['q:' + questions[1].id]: 'Veteran' }, over || {});
  const formOf = (v) => ({ elements: Object.fromEntries(Object.entries(v).map(([k, val]) => [k, ctrl(val)])), querySelectorAll: () => [] });
  await V.handlers.submit['apply-form'](formOf(values()));
  await settle();
  assert.equal(V.app.state.apply.done, true);
  assert(stripTags(V.pages.apply.applyHtml({ state: V.app.state.apply })).includes('Application sent'));
  // Hank, signed in, applies too; the Worker keeps his account.
  await H.pages.apply.load({ name: 'apply', gid: s.gid });
  assert(stripTags(H.pages.apply.applyHtml({ state: H.app.state.apply })).includes('Signed in as Hank H'));
  await H.handlers.submit['apply-form'](formOf(values({ name: 'Hopeful', class: 'MAGE', spec: 'Frost', contact: '' })));
  await settle();
  assert.equal(H.app.state.apply.done, true);
  const stored = await s.rows('SELECT char_name, user_id, status FROM applications ORDER BY created_at, id');
  assert.deepEqual(stored.map((r) => [r.char_name, r.user_id !== null]), [['Walkin', false], ['Hopeful', true]]);
  // The officer: Home lists them, the inbox shows the answers and the account.
  A.app.state.att = {}; A.app.state.guilds = { [s.gid]: A.guildData };
  await A.pages.attention.load({ name: 'section', gid: s.gid, section: 'home' }, A.guildData);
  const home = stripTags(A.pages.attention.main({}, A.guildData));
  assert(home.includes('2 new applications waiting') && home.includes('Review'), home.slice(0, 500));
  const inbox = await open(s, A, 'applications');
  page = inbox();
  text = stripTags(page);
  assert(text.includes('Walkin') && text.includes('Hopeful') && text.includes('We raid late') && text.includes('Veteran') && text.includes('Signed in as Hank H') && text.includes('Contact: Walkin#1'), text.slice(0, 900));
  // Accept Hopeful (signed in): the dialog, then a Trial person with the account linked.
  const hopeful = (await A.api.get(`${s.base}/applications`)).applications.find((a) => a.name === 'Hopeful');
  A.handlers.click['app-accept'](el({ 'data-apid': hopeful.id }));
  assert(A.dialogs[A.dialogs.length - 1].includes('Accept Hopeful'));
  await A.handlers.submit['app-accept-form']({ getAttribute: () => hopeful.id, elements: { teamId: ctrl(s.teamId), trialDays: ctrl('14') } });
  await settle();
  const person = (await s.rows("SELECT p.status, p.trial_end, p.user_id, c.team_id, c.is_main FROM players p JOIN characters c ON c.player_id = p.id WHERE c.name = 'Hopeful'"))[0];
  assert.deepEqual([person.status, person.trial_end, person.user_id !== null, person.team_id, person.is_main], ['trial', '2026-10-31', true, s.teamId, 1]);
  assert(A.app.state.att.applications.note.includes('joined on Trial until') && A.app.state.att.applications.note.includes('Their account is linked.'));
  // Hank is a member now: his account belongs to the new person.
  assert.equal((await H.api.get(s.base)).guild.id, s.gid);
  // The Roster page lists the new Trial; the Home line counts one application now.
  const roster = await A.api.get(`${s.base}/roster?team=${s.teamId}`);
  assert(roster.people.some((p) => p.main && p.main.name === 'Hopeful' && p.status === 'trial'));
  A.app.state.att = {};
  await A.pages.attention.load({ name: 'section', gid: s.gid, section: 'home' }, A.guildData);
  assert(stripTags(A.pages.attention.main({}, A.guildData)).includes('1 new application waiting'));
  // Turn applications off: the form says so.
  A.app.state.att = {};
  await A.pages.settingsApply.load({ name: 'settings', gid: s.gid, tab: 'applications' }, A.guildData);
  A.app.state.att.settingsApply.draft.enabled = false;
  A.handlers.submit['apply-settings-form']();
  await settle();
  await V.pages.apply.load({ name: 'apply', gid: s.gid });
  assert.equal(V.app.state.apply.status, 'closed');
  assert(stripTags(V.pages.apply.applyHtml({ state: V.app.state.apply })).includes('Not taking applications'));
});

check('CSV import: the page previews a pasted file against the real roster, asks about the alt with no main, and saves people, alts, teams and dates', async () => {
  const s = await scenario({ version: 'tbc', teams: ['Alpha', 'Bravo'] });
  const { A } = s;
  pageState(s, A);
  const route = { name: 'import', gid: s.gid, source: 'csv' };
  A.pages.importCsv.ensureState(s.gid, s.teamId);
  A.app.state.roster = { gid: s.gid, teamId: s.teamId, data: await A.api.get(`${s.base}/roster?team=${s.teamId}`) };
  const csv = A.app.state.imports.csv;
  A.handlers.input['csv-text']({ value: [
    'name,class,spec,team,main/alt,status,joined,owner',
    'Newwarr,Warrior,Prot,Alpha,main,trial,2026-10-01,Pat',
    'Newmage,Mage,Fire,Bravo,alt,,,Pat',
    'Thoren,Paladin,Protection,,,,,',
    'Lonelyalt,Rogue,Sub,,alt,,,Thoren',
    'Broken,Dragon,,,,,,',
  ].join('\n') });
  await A.handlers.submit['csv-load']();
  await settle();
  assert.equal(csv.status, 'ready', csv.error);
  let page = A.pages.importCsv.csvHtml({ guildData: A.guildData, csv, people: A.app.state.roster.data.people });
  let text = stripTags(page);
  assert(text.includes('5 rows read') && text.includes('Alt of Newwarr') && text.includes('On the roster') && text.includes('is not a class'), text.slice(0, 900));
  // The alt of "Thoren" is a question with Thoren suggested; the page preselected it.
  assert.deepEqual(plain(csv.choices[5]), { ticked: true, pick: 'alt', personId: s.people.Thoren });
  assert(/data-action="csv-commit"[^>]*><span>Save 3 changes<\/span><\/button>/.test(page));
  await A.handlers.click['csv-commit']();
  await settle();
  assert.equal(A.went, undefined, 'the officer stays on the import page');
  assert.equal(A.app.state.imports.csv.result.title, 'Added 1 person and 3 characters from the CSV file.');
  const chars = await s.rows("SELECT c.name, c.team_id, c.is_main, c.player_id, p.status, p.joined_on FROM characters c JOIN players p ON p.id = c.player_id WHERE c.name IN ('Newwarr', 'Newmage', 'Lonelyalt') ORDER BY c.name");
  const by = Object.fromEntries(chars.map((c) => [c.name, c]));
  assert.deepEqual([by.Newwarr.team_id, by.Newwarr.status, by.Newwarr.joined_on, by.Newwarr.is_main], [s.teamId, 'trial', '2026-10-01', 1]);
  assert.deepEqual([by.Newmage.team_id, by.Newmage.player_id === by.Newwarr.player_id, by.Newmage.is_main], [s.teamIds[1], true, 0]);
  assert.deepEqual([by.Lonelyalt.player_id === s.people.Thoren, by.Lonelyalt.is_main], [true, 0]);
  const audit = (await s.rows("SELECT after FROM audit_log WHERE action = 'roster.import'"))[0];
  assert.equal(JSON.parse(audit.after).source, 'csv');
  // The import menu offers the page, and the router knows its address.
  assert(A.pages.roster.importMenuHtml(s.gid).includes(`#/g/${s.gid}/roster/import/csv`));
  assert.deepEqual(plain(A.router.parse(`#/g/${s.gid}/roster/import/csv`)), route);
});

// ---------------------------------------------------------------------------

async function main() {
  const filter = process.argv[2] || '';
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 10).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
