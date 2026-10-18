/**
 * Raidsmith guild tracker - PM wave 2 CONTRACT tests (Worker <-> pages)
 * Run: node guild-wave2-contract-tests.js [name-filter]
 *
 * guild-wave2-worker-tests.js and guild-wave2-ui-tests.js each work from the contract in tasks/guild-pm-wave2-spec.md with hand-made data on the
 * other side. This suite joins them, the way guild-wave1-contract-tests.js and guild-signups-contract-tests.js do: the real pages
 * (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in) through G.api, their real
 * click / change / submit handlers run, and what they draw from the real answers is checked next to what the Worker stored. A field one side
 * names differently, nests differently or leaves out shows up here as a missing word, a blank cell or a thrown error. One check per thing a
 * user can see: team and raid sizes, the sign-up deadline, date-only raids and the calendar feed, away notices (page, cards, attendance),
 * the Planner seed (size, zone, markers) read by the Planner's own importer, Standby, standing sign-ups and the published roster.
 * Discord and Raid-Helper are faked by an injected fetch and the clock is injected: no network, no Wrangler, no credentials, no real time.
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
  gina: { id: '110000000000000007', username: 'gina', globalName: 'Gina G' },
  hank: { id: '110000000000000008', username: 'hank', globalName: 'Hank H' },
};
const NOW = Date.parse('2026-10-17T16:00:00Z'); // Saturday 12:00 in New York
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// Newer ICU writes a narrow no-break space before AM / PM.
const ws = (text) => String(text).split(String.fromCharCode(0x202f)).join(' ').split(String.fromCharCode(0xa0)).join(' ');
const el = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const ctrl = (value, extra) => Object.assign({ value, checked: false, focus() {}, setAttribute() {} }, extra || {});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

// ---------------------------------------------------------------------------
// The Worker side: one app over one D1, a cookie jar per signed-in person

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
  const env = {
    DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    GUILD_CREATOR_ALLOWLIST: PEOPLE.alice.id,
  };
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

// A fetch the page's G.api.request can use: the Worker answers, the jar carries the session.
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
// The pages side: the real scripts with G.api routed to the Worker, one set per signed-in person

function loadPages(world, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  const f = fetchFor(world, jar);
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  // The dialog shell needs a DOM: the dialogs' HTML is kept for the checks, the text a handler writes to a field is kept by id, and the
  // requests run as they do.
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
  return G;
}

// ---------------------------------------------------------------------------
// Scenario: Alice (Guild Master) runs the guild; Erin is the member behind Thoren (a Paladin with a Mage alt Thorenmage), Gina behind Gorrim
// (a Priest); Kaelith (Rogue) and Mirabel (Hunter) have no Discord link; Hank has no character. Teams: Alpha first, then the others asked for.

const GUILDS = {
  tbc: { gameVersion: 'tbc', region: 'US', realm: 'Nightslayer' },
  forever: { gameVersion: 'forever', region: 'US', realm: 'Normal' },
};
const ROSTER = [
  ['Thoren', 'PALADIN', 'Protection', 'Holy', 0, 'erin'],
  ['Gorrim', 'PRIEST', 'Holy', 'Discipline', 0, 'gina'],
  ['Kaelith', 'ROGUE', 'Combat', null, 0, null],
  ['Mirabel', 'HUNTER', 'Marksmanship', null, 0, null],
];

async function scenario({ version = 'tbc', teams = ['Alpha'], roster = ROSTER } = {}) {
  const world = await makeWorld();
  const aliceJar = await signIn(world, PEOPLE.alice, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const A = loadPages(world, aliceJar);
  const body = { serverId: SERVER, ...GUILDS[version], name: 'Ember', timeZone: 'America/New_York', multipleTeams: teams.length > 1 };
  if (teams.length > 1) body.teamNames = teams;
  const created = await A.api.post('/api/guild', body);
  const gid = created.guild.id;
  const teamIds = created.teams.map((team) => team.id);
  const base = `/api/guild/${gid}`;
  const people = {};
  for (const [name, cls, main, off, teamIndex, who] of roster) {
    const made = await A.api.post(`${base}/roster`, { teamId: teamIds[teamIndex], name, class: cls, mainSpec: main, offSpec: off, status: 'raider' });
    people[name] = made.person.id;
    if (who) world.db.sqlite.exec(`UPDATE players SET discord_user_id = '${PEOPLE[who].id}' WHERE id = '${made.person.id}'`);
  }
  const member = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
  const E = loadPages(world, await signIn(world, PEOPLE.erin, member));
  const N = loadPages(world, await signIn(world, PEOPLE.gina, member));
  const H = loadPages(world, await signIn(world, PEOPLE.hank, member));
  const s = { world, A, E, N, H, gid, teamId: teamIds[0], teamIds, base, people, version };
  for (const G of [A, E, N, H]) G.guildData = await G.api.get(base);
  s.refresh = async (...pages) => { for (const G of pages) G.guildData = await G.api.get(base); };
  s.exec = (sql) => world.db.sqlite.exec(sql);
  s.rows = (sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results);
  // A raid of a team (hand-made): -> its id.
  s.raid = async (body) => (await A.api.post(`${base}/raids`, { teamId: s.teamId, ...body })).raid.id;
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// The state bag the pages keep, reset for a fresh page, with the guild payload this person got.
function pageState(s, G, teamId) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: G.guildData };
  S.currentGid = s.gid;
  S.pageAlert = '';
  G.app.teamFor = () => teamId || s.teamId;
  return S;
}

// Opens the raid page the way the router does: the detail, then the panel's data; -> a function drawing the page.
async function openRaid(s, G, rid, teamId) {
  pageState(s, G, teamId);
  const route = { name: 'raid', gid: s.gid, rid };
  await G.pages.raid.load(route, G.guildData);
  return () => G.pages.raid.main(route, G.guildData);
}

// The Raids list (the section page): -> a function drawing it.
async function openList(s, G, teamId) {
  pageState(s, G, teamId);
  const route = { name: 'section', gid: s.gid, section: 'raids' };
  await G.pages.raids.load(route, G.guildData);
  return () => G.pages.raids.main(route, G.guildData);
}

// ---------------------------------------------------------------------------

check('sizes: Team settings sets the team size (PATCH); the Raids list counts against the zone\'s size (Hyjal 20, Barrow Deeps 10) or, with no zone, the team\'s', async () => {
  const s = await scenario({ version: 'forever' });
  const { A, E } = s;
  // Team settings: a WoW Forever team starts at 20-man (the version's usual size); the Size dialog is built from the real team, its submit is one PATCH, the list then says 40-man.
  pageState(s, A);
  let text = stripTags(A.pages.teams.teamsHtml({ guildData: A.guildData }));
  assert(/20-man/.test(text), text);
  A.handlers.click['team-size'](el({ 'data-team': s.teamId }));
  assert(/Raid size of /.test(A.dialogs[0]) && /<option value="20" selected>/.test(A.dialogs[0]), A.dialogs[0].slice(0, 300));
  await A.handlers.submit['team-form'](el({ 'data-gid': s.gid, 'data-mode': 'size', 'data-team': s.teamId }, { elements: { size: ctrl('40') } }));
  await settle();
  assert.equal((await s.rows('SELECT size FROM teams WHERE id = ?', s.teamId))[0].size, 40, 'stored');
  text = stripTags(A.pages.teams.teamsHtml({ guildData: A.guildData }));
  assert(/40-man/.test(text) && !/20-man/.test(text), text);

  // Three upcoming raids: Hyjal Summit (zone size 20), Barrow Deeps (10), and one with no zone (the team's 40). Erin signs up to each.
  const hyjal = await s.raid({ raidOn: '2026-10-24', startTime: '20:00', zone: 'Hyjal Summit' });
  const barrow = await s.raid({ raidOn: '2026-10-25', startTime: '20:00', zone: 'Barrow Deeps' });
  const open = await s.raid({ raidOn: '2026-10-26', startTime: '20:00' });
  await s.refresh(A, E);
  for (const rid of [hyjal, barrow, open]) await E.api.signups.save(s.gid, rid, { kind: 'signed' });
  const list = await openList(s, E);
  text = ws(stripTags(list()));
  assert(text.includes('Hyjal Summit - 20 1 / 20 signed up'), text.slice(0, 900));
  assert(text.includes('Barrow Deeps - 10 1 / 10 signed up'), text.slice(0, 900));
  assert(text.includes('Mon Oct 26, 8:00 PM ET 40-player 1 / 40 signed up'), 'no zone: the team\'s 40: ' + text.slice(0, 900));
});

check('raid settings: the officer\'s card sets a raid\'s own size and sign-up deadline (one PATCH), the page, the list and the member\'s panel follow, and Automatic / Team default clear them', async () => {
  const s = await scenario({ version: 'forever' });
  const { A, E } = s;
  const hyjal = await s.raid({ raidOn: '2026-10-24', startTime: '20:00', zone: 'Hyjal Summit' });
  await s.refresh(A, E);
  await E.api.signups.save(s.gid, hyjal, { kind: 'signed' });
  const page = await openRaid(s, A, hyjal);
  let text = ws(stripTags(page()));
  assert(text.includes('Raid settings') && text.includes('In effect: 20 players, picked from the zone'), text.slice(0, 700));
  assert(text.includes('Sat Oct 24 - Hyjal Summit - 20') && text.includes('Starts Sat Oct 24'), 'the title carries zone and size');
  const form = (size, mode, hours) => ({ elements: { size: ctrl(size), hoursMode: ctrl(mode), hours: ctrl(hours) } });
  await A.handlers.submit['raid-settings-form'](form('40', 'custom', '12'));
  await settle();
  assert.deepEqual((await s.rows('SELECT size, signup_close_hours FROM raids WHERE id = ?', hyjal))[0], { size: 40, signup_close_hours: 12 }, 'one PATCH stored both');
  text = ws(stripTags(page()));
  assert(text.includes('In effect: 40 players, set for this raid.') && text.includes('12 hours before the start') && text.includes('Raid settings saved.'), text.slice(0, 900));
  assert(ws(stripTags((await openList(s, E))())).includes('Hyjal Summit - 40 1 / 40 signed up'), 'the list follows the raid\'s own size');
  const panel = ws(stripTags((await openRaid(s, E, hyjal))()));
  assert(panel.includes('Open until Sat Oct 24, 8:00 AM ET (sign-ups close 12 hours before the start)') && panel.includes('Expected 1 / 40'), panel.slice(0, 700));

  await openRaid(s, A, hyjal);
  await A.handlers.submit['raid-settings-form'](form('', '', ''));
  await settle();
  assert.deepEqual((await s.rows('SELECT size, signup_close_hours FROM raids WHERE id = ?', hyjal))[0], { size: null, signup_close_hours: null }, 'Automatic and Team default clear them');
  text = ws(stripTags(page()));
  assert(text.includes('In effect: 20 players, picked from the zone') && text.includes('the team\'s setting'), text.slice(0, 900));
  assert(ws(stripTags((await openRaid(s, E, hyjal))())).includes('Expected 1 / 20'));
});

// The Planner's own reader (js/livesync.js RaidLink, js/import.js Import, js/state.js State) in a vm, on a fresh plan of a game version.
const PLANNER_PARTS = ['State', 'Config', 'Import', 'Optimizer', 'SignupMarker', 'SignupStatus', 'PlanStore', 'PlanSession', 'LocalPicks', 'nextUid', 'RaidLink', 'GameVersions'];
function plannerFor(version) {
  const ctx = planner.sandbox(PLANNER_PARTS);
  const { State } = ctx.api;
  State.gameVersion = version;
  State.selectedRaid = ctx.api.GameVersions[version].defaultRaid;
  State.roster = []; State.groups = []; State.bench = []; State.unplaced = []; State.buffOverrides = {};
  State.rosterName = 'Contract'; State.planId = null; State.notes = '';
  return ctx.api;
}
const everyone = (State) => [...State.groups.flat(), ...State.bench, ...State.unplaced];

check('planner seed: a Forever Hyjal Summit raid carries size 20 and its zone, and the Planner\'s reader opens the Hyjal template (a raid size of 40 opens a 40-player template instead)', async () => {
  const s = await scenario({ version: 'forever' });
  const { A, E } = s;
  const rid = await s.raid({ raidOn: '2026-10-24', startTime: '20:00', zone: 'Hyjal Summit' });
  await E.api.signups.save(s.gid, rid, { kind: 'signed' });
  await A.api.signups.savePerson(s.gid, rid, s.people.Kaelith, { kind: 'late' });
  await A.api.signups.savePerson(s.gid, rid, s.people.Mirabel, { kind: 'bench' });
  const seed = await A.api.get(`${s.base}/raids/${rid}/planner`);
  assert.deepEqual([seed.raid.size, seed.raid.zone, seed.raid.gameVersion, seed.raid.teamId], [20, 'Hyjal Summit', 'forever', s.teamId]);
  assert.deepEqual(seed.signups.map((x) => x.name), ['Thoren', 'Kaelith', 'Mirabel']);

  const api = plannerFor('forever');
  const raidKey = api.RaidLink.raidKeyFor(seed.raid, seed.raid.gameVersion);
  assert.equal(raidKey, 'f_hyjal');
  api.State.selectedRaid = raidKey;
  const result = api.Import.importRaidHelper(api.RaidLink.seedToRaidHelper(seed), { fixedRaid: true });
  assert(result.success, JSON.stringify(result));
  assert.equal(api.State.selectedRaid, 'f_hyjal', 'a fixed raid stays');
  assert.equal(api.Config.Raids[api.State.selectedRaid].size, 20);
  assert.deepEqual(everyone(api.State).map((p) => p.name).sort(), ['Kaelith', 'Mirabel', 'Thoren']);

  // An officer's own size for this raid wins over the zone's, and the Worker's seed says so; the Planner then opens a template of that size.
  await A.api.patch(`${s.base}/raids/${rid}`, { size: 40 });
  const bigger = await A.api.get(`${s.base}/raids/${rid}/planner`);
  assert.deepEqual([bigger.raid.size, bigger.raid.zone], [40, 'Hyjal Summit']);
  const key40 = api.RaidLink.raidKeyFor(bigger.raid, 'forever');
  assert(key40 && key40 !== 'f_hyjal' && api.Config.Raids[key40].size === 40, String(key40));
});

// ---------------------------------------------------------------------------

check('deadline: Settings > Raid schedule saves "close sign-ups N hours before"; the member\'s panel shows the pill, then the closed sentence, the Worker answers 409 reason deadline, and an officer still edits', async () => {
  const s = await scenario();
  const { A, E } = s;
  pageState(s, A);
  const route = { name: 'settings', gid: s.gid, tab: 'schedule' };
  await A.pages.settingsSchedule.load(route, A.guildData);
  let text = stripTags(A.pages.settingsSchedule.main(route, A.guildData, { guildData: A.guildData }));
  assert(/Close sign-ups/.test(text) && /hours before the start/.test(text), text.slice(0, 600));
  A.handlers.click['sched-add'](el({}));                  // Tuesday 20:00 (the first free day after the US reset)
  A.handlers.input['sched-close'](ctrl('6'));
  await A.handlers.submit['sched-form']();
  assert.equal(A.app.state.att.settingsSchedule.note, '', 'the page head says Saved at; there is no banner');
  assert.equal(A.app.state.settingsSaved && A.app.state.settingsSaved.tab, 'schedule');
  assert.equal((await s.rows('SELECT signup_close_hours FROM teams WHERE id = ?', s.teamId))[0].signup_close_hours, 6, 'stored on the team');
  assert.equal(A.app.state.att.settingsSchedule.data.signupCloseHours, 6, 'the page shows what the Worker answered');
  await A.handlers.click['sched-fill'](el({}));            // Tue Oct 20 and Tue Oct 27, 8:00 PM New York
  const raids = await s.rows('SELECT id, raid_on, starts_at FROM raids ORDER BY raid_on');
  assert.deepEqual(raids.map((r) => r.raid_on), ['2026-10-20', '2026-10-27']);
  const rid = raids[0].id;
  await s.refresh(A, E);

  // Before the deadline (Tue 2:00 PM): the pill names it, and a sign-up works.
  const stale = await openRaid(s, E, rid);
  text = ws(stripTags(stale()));
  assert(text.includes('Open until Tue Oct 20, 2:00 PM ET (sign-ups close 6 hours before the start)'), text.slice(0, 600));
  await E.handlers.click['su-kind'](el({ 'data-kind': 'signed' }));
  assert.equal((await s.rows("SELECT kind FROM raid_signups WHERE source = 'raidsmith'"))[0].kind, 'signed');

  // After it: a fresh page says closed, the buttons are off; the stale page's click is the Worker's 409 and the panel then shows the closed state.
  s.world.clock.now = Date.parse('2026-10-20T18:30:00Z');
  const closed = await openRaid(s, E, rid);
  text = ws(stripTags(closed()));
  assert(text.includes('Closed Tue Oct 20, 2:00 PM ET') && text.includes('Sign-ups closed 6 hours before the start. Ask an officer if you need to change yours.'), text.slice(0, 700));
  assert(/data-kind="signed"[^>]*disabled/.test(closed()), 'the buttons are off');
  const refused = await E.api.signups.save(s.gid, rid, { kind: 'late' }).then(() => null, (e) => e);
  assert(refused && refused.status === 409 && refused.code === 'signups_closed' && refused.body.reason === 'deadline', JSON.stringify(refused && { s: refused.status, c: refused.code, body: refused.body }));
  // A page drawn before the deadline passed (open buttons) whose click comes after it.
  await openRaid(s, E, rid);
  E.app.state.att.raidSignups.data.raid.closed = null;
  E.app.state.att.raidSignups.data.me.canChange = true;
  await E.handlers.click['su-kind'](el({ 'data-kind': 'late' }));
  const x = E.app.state.att.raidSignups;
  assert(/Sign-ups closed 6 hours before the start/.test(x.ui.error), x.ui.error);
  assert.equal(x.data.raid.closed, 'deadline');
  assert.equal((await s.rows("SELECT kind FROM raid_signups WHERE source = 'raidsmith'"))[0].kind, 'signed', 'nothing changed');

  // An officer is not bound by the deadline: the panel keeps its tools and an edit goes through.
  const officer = await openRaid(s, A, rid);
  assert(/Add a sign-up/.test(stripTags(officer())));
  await A.api.signups.savePerson(s.gid, rid, s.people.Kaelith, { kind: 'signed' });
  assert.equal((await s.rows("SELECT kind FROM raid_signups WHERE player_id = ?", s.people.Kaelith))[0].kind, 'signed');
});

// ---------------------------------------------------------------------------

check('date-only raid: the raid page and the list say "Time not set"; the fetched calendar feed has an all-day event for it and a timed one for a timed raid', async () => {
  const s = await scenario();
  const { A, E } = s;
  const dateOnly = await s.raid({ raidOn: '2026-10-24', title: 'Weekend run' });
  const timed = await s.raid({ raidOn: '2026-10-25', startTime: '20:00', title: 'Night run' });
  await s.refresh(A, E);
  assert.equal((await s.rows('SELECT time_known FROM raids WHERE id = ?', dateOnly))[0].time_known, 0);
  assert.equal((await s.rows('SELECT time_known FROM raids WHERE id = ?', timed))[0].time_known, 1);

  let text = ws(stripTags((await openRaid(s, E, dateOnly))()));
  assert(text.includes('Time not set') && !/12:00/.test(text), text.slice(0, 500));
  // Wave 6: the panel does name the time its window closes at, with the reason - the team has no slot that Saturday, so 18:00 guild time (not a made-up start).
  assert(text.includes('Sign-ups Open until Sat Oct 24, 6:00 PM ET (this raid has only a date and the team has no schedule slot that day, so sign-ups close at 18:00 guild time)'), text.slice(0, 600));
  text = ws(stripTags((await openRaid(s, E, timed))()));
  assert(text.includes('Starts Sun Oct 25, 8:00 PM ET') && !text.includes('Time not set'), text.slice(0, 500));
  text = ws(stripTags((await openList(s, E))()));
  assert(/Sat Oct 24[^]*?time not set/.test(text) && text.includes('Sun Oct 25, 8:00 PM ET'), text.slice(0, 700));

  // The calendar link, fetched the way a calendar app would.
  const made = await E.api.calendar.create(s.gid, s.teamId);
  const feed = await s.world.app.handle(new Request(made.url));
  assert.equal(feed.status, 200);
  const ics = (await feed.text()).replace(/\r\n /g, '');
  const event = (rid) => {
    const at = ics.indexOf(`UID:${rid}@raidsmith`);
    assert(at >= 0, `no event for ${rid}`);
    return ics.slice(ics.lastIndexOf('BEGIN:VEVENT', at), ics.indexOf('END:VEVENT', at));
  };
  const dateEvent = event(dateOnly);
  assert(dateEvent.includes('SUMMARY:Weekend run') && dateEvent.includes('DTSTART;VALUE=DATE:20261024'), dateEvent);
  assert(!/DTSTART:/.test(dateEvent), 'an all-day event has no clock time');
  const timedEvent = event(timed);
  assert(timedEvent.includes('SUMMARY:Night run') && timedEvent.includes('DTSTART:20261026T000000Z') && !timedEvent.includes('VALUE=DATE'), timedEvent);
});

// ---------------------------------------------------------------------------

// Records the bodies a page sends through G.api.away (the Worker still answers every request).
function spyAway(G) {
  const sent = [];
  for (const name of ['add', 'save', 'remove']) {
    const real = G.api.away[name];
    G.api.away[name] = (...args) => { sent.push({ call: name, args: plain(args.slice(1)) }); return real(...args); };
  }
  return sent;
}
const dialogForm = (html, values, extra) => {
  const attrs = {};
  for (const m of html.matchAll(/data-(ctx|mode|nid|pid|gid|op|from|rid)="([^"]*)"/g)) attrs[`data-${m[1]}`] = m[2];
  return Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), elements: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, ctrl(v)])) }, extra || {});
};

check('away notices: the Away page adds a weekly and a range notice, lists them with their reasons, edits one and removes one - each a real request with only what was said', async () => {
  const s = await scenario();
  const { E } = s;
  const sent = spyAway(E);

  // The page, empty; Add opens the dialog for a date range; its submit is one POST with only what was said.
  pageState(s, E);
  const route = { name: 'away', gid: s.gid };
  await E.pages.away.load(route, E.guildData);
  assert(/You have no away notices/.test(stripTags(E.pages.away.main(route, E.guildData))));
  E.handlers.click['away-add'](el({ 'data-ctx': 'mine' }));
  assert(/Add an away notice/.test(E.dialogs[0]) && /value="2026-10-17"/.test(E.dialogs[0]), E.dialogs[0].slice(0, 300));
  await E.handlers.submit['away-form'](dialogForm(E.dialogs[0], { kind: 'away', repeat: 'range', weekday: '6', from: '2026-10-24', to: '2026-10-26', atTime: '', reason: 'Wedding' }));
  // A weekly one: every Thursday from Oct 22, no end, with a reason of its own.
  E.handlers.click['away-add'](el({ 'data-ctx': 'mine' }));
  await E.handlers.submit['away-form'](dialogForm(E.dialogs[1], { kind: 'away', repeat: 'weekly', weekday: '4', from: '2026-10-22', to: '', atTime: '', reason: 'Work shift' }));
  assert.deepEqual(sent.map((x) => [x.call, x.args]), [
    ['add', [{ kind: 'away', from: '2026-10-24', to: '2026-10-26', reason: 'Wedding' }]],
    ['add', [{ kind: 'away', from: '2026-10-22', weekday: 4, reason: 'Work shift' }]],
  ]);
  const stored = await s.rows('SELECT kind, starts_on, ends_on, weekday, reason FROM away_notices ORDER BY starts_on');
  assert.deepEqual(stored.map((r) => [r.kind, r.starts_on, r.ends_on, r.weekday, r.reason]), [['away', '2026-10-22', null, 4, 'Work shift'], ['away', '2026-10-24', '2026-10-26', null, 'Wedding']]);
  let text = stripTags(E.pages.away.main(route, E.guildData));
  assert(text.includes('Away every Thursday from Oct 22') && text.includes('Work shift') && text.includes('Away Oct 24 - Oct 26') && text.includes('Wedding') && text.includes('Notice saved.'), text);

  // Edit the range notice: the dialog starts from it; the submit is a PUT of the full body to that notice.
  const range = (await s.rows("SELECT id FROM away_notices WHERE reason = 'Wedding'"))[0].id;
  E.handlers.click['away-edit'](el({ 'data-ctx': 'mine', 'data-nid': range }));
  assert(/Change an away notice/.test(E.dialogs[2]) && /value="Wedding"/.test(E.dialogs[2]) && /value="2026-10-26"/.test(E.dialogs[2]));
  await E.handlers.submit['away-form'](dialogForm(E.dialogs[2], { kind: 'away', repeat: 'range', weekday: '6', from: '2026-10-24', to: '2026-10-25', atTime: '', reason: 'Wedding trip' }));
  assert.deepEqual(sent[2], { call: 'save', args: [range, { kind: 'away', from: '2026-10-24', to: '2026-10-25', reason: 'Wedding trip' }] });
  assert.deepEqual((await s.rows('SELECT ends_on, reason FROM away_notices WHERE id = ?', range))[0], { ends_on: '2026-10-25', reason: 'Wedding trip' });
  text = stripTags(E.pages.away.main(route, E.guildData));
  assert(text.includes('Away Oct 24 - Oct 25') && text.includes('Wedding trip'), text);

  // Remove asks first, then deletes: the list and the stored notice lose it, the weekly one stays.
  E.handlers.click['away-remove'](el({ 'data-ctx': 'mine', 'data-nid': range }));
  assert(/Remove this notice\?/.test(E.dialogs[3]) && stripTags(E.dialogs[3]).includes('Away Oct 24 - Oct 25'));
  await E.handlers.submit['away-remove-form'](dialogForm(E.dialogs[3], {}));
  assert.deepEqual(sent[3], { call: 'remove', args: [range] });
  assert.equal(await s.world.db.prepare('SELECT COUNT(*) AS n FROM away_notices').first('n'), 1);
  text = stripTags(E.pages.away.main(route, E.guildData));
  assert(!text.includes('Wedding') && text.includes('Notice removed.') && text.includes('Away every Thursday from Oct 22'), text);
});

check('away notices in the views: the officer\'s Raids card and the person section show the reasons; the members\' Sign-ups panel shows "Away (notice)" and never a reason; the officer removing it from the card removes it from the panel', async () => {
  const s = await scenario();
  const { A, E, N } = s;
  const rid = await s.raid({ raidOn: '2026-10-24', startTime: '20:00' });
  await s.refresh(A, E, N);
  await E.api.away.add(s.gid, { kind: 'away', from: '2026-10-24', to: '2026-10-25', reason: 'Wedding trip' });
  await E.api.away.add(s.gid, { kind: 'away', from: '2026-10-22', weekday: 4, reason: 'Work shift' });

  // The officer's Raids card (it loads itself after the page is drawn) and the person section, with the reasons.
  const list = await openList(s, A);
  A.pages.away.afterRender({ name: 'section', section: 'raids' });
  await settle();
  let text = stripTags(list());
  assert(/Away, next 4 weeks/.test(text) && text.includes('Thoren') && text.includes('Away Oct 24 - Oct 25') && text.includes('Reason: Wedding trip') && text.includes('Away every Thursday') && text.includes('Reason: Work shift'), text.slice(0, 1500));
  const record = await A.api.get(`${s.base}/roster/${s.people.Thoren}`);
  A.app.state.person = { gid: s.gid, pid: s.people.Thoren, record };
  A.pages.away.afterRender({ name: 'person', pid: s.people.Thoren });
  await settle();
  const section = stripTags(A.pages.away.personCardHtml({ guildData: A.guildData, record, state: A.pages.attendance.attState().awayPerson }));
  assert(section.includes('Away notices') && section.includes('Away Oct 24 - Oct 25') && section.includes('Reason: Wedding trip') && section.includes('Reason: Work shift'), section);

  // The Sign-ups panel: the member is away (notice); another member sees Thoren in Absent as "Away (notice)"; neither sees a reason.
  const mineHtml = (await openRaid(s, E, rid))();
  assert(/You are away \(notice\)/.test(stripTags(mineHtml)) && !/Wedding|Work shift/.test(mineHtml), stripTags(mineHtml).slice(0, 800));
  const otherHtml = (await openRaid(s, N, rid))();
  assert(stripTags(otherHtml).includes('Away (notice)') && /Can(&#39;|')t come 1/.test(stripTags(otherHtml)) && !/Wedding|Work shift/.test(otherHtml), stripTags(otherHtml).slice(0, 800));
  assert.equal(await s.world.db.prepare('SELECT COUNT(*) AS n FROM raid_signups').first('n'), 0, 'an away notice is not a stored sign-up');

  // The officer removes the range notice from the card (asks first); the panel no longer shows Thoren away.
  const again = await openList(s, A);
  A.pages.away.afterRender({ name: 'section', section: 'raids' });
  await settle();
  const noticeId = (await s.rows("SELECT id FROM away_notices WHERE reason = 'Wedding trip'"))[0].id;
  A.dialogs.length = 0;
  A.handlers.click['away-remove'](el({ 'data-ctx': 'team', 'data-nid': noticeId }));
  assert(/Remove this notice\?/.test(A.dialogs[0]) && stripTags(A.dialogs[0]).includes('Away Oct 24 - Oct 25 for Thoren'), stripTags(A.dialogs[0]));
  await A.handlers.submit['away-remove-form'](dialogForm(A.dialogs[0], {}));
  await settle();
  assert.equal(await s.world.db.prepare('SELECT COUNT(*) AS n FROM away_notices').first('n'), 1);
  text = stripTags(again());
  assert(!text.includes('Wedding trip') && text.includes('Reason: Work shift'), text.slice(0, 1200));
  assert(!stripTags((await openRaid(s, N, rid))()).includes('Away (notice)'), 'the panel no longer shows Thoren away');
  assert(/You have not signed up yet\./.test(stripTags((await openRaid(s, E, rid))())));
});

// ---------------------------------------------------------------------------

// The officer enters attendance by hand through the raid page's own dialog: ticks the named people, says why. -> the redrawn page.
async function enterByHand(s, G, page, names) {
  G.dialogs.length = 0;
  G.handlers.click['raid-op'](el({ 'data-op': 'manual-open' }));
  await settle();
  const html = G.dialogs[G.dialogs.length - 1];
  assert(html && /name="present"/.test(html), 'the manual dialog lists the team');
  const boxes = [...html.matchAll(/<input[^>]*name="present"[^>]*value="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  assert(boxes.includes(s.people.Thoren), 'Thoren is offered');
  const ids = names.map((name) => s.people[name]);
  await G.handlers.submit['manual-form']({ elements: { reason: ctrl('No log kept') }, querySelectorAll: () => ids.map((id) => ({ value: id })) });
  await settle();
  return page();
}

check('attendance: a covering away notice filed before the raid makes a missed raid "missed with notice"; a real Signed sign-up on the same raid is a plain "missed"', async () => {
  const s = await scenario();
  const { A, E } = s;
  const withNotice = await s.raid({ raidOn: '2026-10-24', startTime: '20:00' });
  const withSignup = await s.raid({ raidOn: '2026-10-25', startTime: '20:00' });
  await s.refresh(A, E);
  // Erin files one notice for both days, then signs up for the second raid only (her own click on the panel).
  await E.api.away.add(s.gid, { kind: 'away', from: '2026-10-24', to: '2026-10-25', reason: 'Wedding' });
  await openRaid(s, E, withSignup);
  await E.handlers.click['su-kind'](el({ 'data-kind': 'signed' }));
  s.world.clock.now = Date.parse('2026-10-26T12:00:00Z');

  // Hand-entered attendance without Thoren on both raids.
  const first = await enterByHand(s, A, await openRaid(s, A, withNotice), ['Kaelith']);
  let text = stripTags(first);
  assert(text.includes("Thoren Paladin Can't come - - N Missed with notice 0%"), text.slice(text.indexOf('Everyone'), text.indexOf('Everyone') + 500));
  let row = (await s.rows("SELECT outcome, credit, signup_kind FROM attendance WHERE raid_id = ? AND player_id = ?", withNotice, s.people.Thoren))[0];
  assert.deepEqual(row, { outcome: 'missed_notice', credit: 0, signup_kind: 'absence' });
  assert(text.includes('Kaelith Rogue No sign-up - - P Present 100%'), 'the ticked player is present');

  const second = await enterByHand(s, A, await openRaid(s, A, withSignup), ['Kaelith']);
  text = stripTags(second);
  assert(text.includes('Thoren Paladin &middot; Protection Signed up - - M Missed 0% No show') && !text.includes('Missed with notice'), text.slice(text.indexOf('Everyone'), text.indexOf('Everyone') + 500));
  row = (await s.rows("SELECT outcome, credit, signup_kind, flags FROM attendance WHERE raid_id = ? AND player_id = ?", withSignup, s.people.Thoren))[0];
  assert.deepEqual(row, { outcome: 'missed', credit: 0, signup_kind: 'signed', flags: '["no_show"]' });
});

// ---------------------------------------------------------------------------

const MARKER_ROSTER = [
  ['Thoren', 'PALADIN', 'Protection', 'Holy', 0, 'erin'],       // volunteers as Standby
  ['Gorrim', 'PRIEST', 'Holy', 'Discipline', 0, 'gina'],        // signed up for both teams' raids that night
  ['Kaelith', 'ROGUE', 'Combat', null, 0, null],                // a Late notice
  ['Mirabel', 'HUNTER', 'Marksmanship', null, 0, null],         // a Leaving early notice
  ['Vessa', 'DRUID', 'Restoration', null, 0, null],             // away by notice, no sign-up
];

check('planner seed markers: Away, Also in another raid, Late, Leaving and Standby ride the seed and become player.marker in the Planner\'s own reader', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], roster: MARKER_ROSTER });
  const { A } = s;
  const [alpha, bravo] = s.teamIds;
  const raid = await s.raid({ raidOn: '2026-10-24', startTime: '20:00' });
  const other = await A.api.post(`${s.base}/raids`, { teamId: bravo, raidOn: '2026-10-24', startTime: '21:00' }).then((r) => r.raid.id);
  const alt = await A.api.post(`${s.base}/roster/${s.people.Gorrim}/characters`, { name: 'Gorrimbear', class: 'DRUID', mainSpec: 'Restoration', offSpec: null, teamId: bravo, makeMain: false });
  assert(alt, 'the alt on Bravo was added');
  const altId = (await s.rows("SELECT id FROM characters WHERE name = 'Gorrimbear'"))[0].id;
  const put = (rid, name, body) => A.api.signups.savePerson(s.gid, rid, s.people[name], body);
  await put(raid, 'Thoren', { kind: 'standby' });
  await put(raid, 'Gorrim', { kind: 'signed' });
  await put(other, 'Gorrim', { kind: 'signed', characterId: altId });   // the same night, an hour later, on the other team
  await put(raid, 'Kaelith', { kind: 'signed' });
  await put(raid, 'Mirabel', { kind: 'signed' });
  await A.api.away.add(s.gid, { kind: 'late', from: '2026-10-24', to: '2026-10-24', atTime: '21:00', personId: s.people.Kaelith });
  await A.api.away.add(s.gid, { kind: 'leaving', from: '2026-10-24', to: '2026-10-24', atTime: '22:00', personId: s.people.Mirabel });
  await A.api.away.add(s.gid, { kind: 'away', from: '2026-10-24', to: '2026-10-25', personId: s.people.Vessa, reason: 'Private reason' });

  const seed = await A.api.get(`${s.base}/raids/${raid}/planner`);
  const markerOf = (name) => (seed.signups.find((x) => x.name === name) || {}).marker || null;
  assert.deepEqual(plain(markerOf('Vessa')), { kind: 'away', text: 'Away: notice' });
  assert.deepEqual(plain(markerOf('Gorrim')), { kind: 'also', text: 'Also in: Bravo raid' });
  assert.deepEqual(plain(markerOf('Kaelith')), { kind: 'late', text: 'Late: 21:00' });
  assert.deepEqual(plain(markerOf('Mirabel')), { kind: 'leaving', text: 'Leaves: 22:00' });
  assert.deepEqual(plain(markerOf('Thoren')), { kind: 'standby', text: 'Standby' });
  assert.equal(seed.signups.find((x) => x.name === 'Thoren').kind, 'standby');
  assert(!JSON.stringify(seed).includes('Private reason'), 'a reason never reaches the Planner');

  // The Planner's own reader (the same call the raid context makes): every marker lands on its player, and the two that act do.
  const api = plannerFor('tbc');
  const result = api.Import.importRaidHelper(api.RaidLink.seedToRaidHelper(seed), { fixedRaid: false });
  assert(result.success, JSON.stringify(result));
  const players = Object.fromEntries(everyone(api.State).map((p) => [p.name, p]));
  const seen = (name) => (players[name] && players[name].marker ? plain(players[name].marker) : null);
  assert.deepEqual(['Vessa', 'Gorrim', 'Kaelith', 'Mirabel', 'Thoren'].map(seen), [
    { kind: 'away', text: 'Away: notice' }, { kind: 'also', text: 'Also in: Bravo raid' }, { kind: 'late', text: 'Late: 21:00' },
    { kind: 'leaving', text: 'Leaves: 22:00' }, { kind: 'standby', text: 'Standby' },
  ]);
  assert.deepEqual(['Vessa', 'Gorrim', 'Kaelith', 'Mirabel', 'Thoren'].map((n) => api.SignupMarker.tagText(players[n].marker)), ['Away', 'Also in', 'Late: 21:00', 'Leaves: 22:00', 'Standby']);
  assert(api.State.unplaced.includes(players.Vessa) && players.Vessa.signupStatus === 'absent', 'an Away row arrives as Absent');
  assert(api.State.bench.includes(players.Gorrim), 'Also in another raid waits on the bench');
});

// ---------------------------------------------------------------------------

check('standby: the panel\'s Standby button is one real request; the counts say Standby 1 and expected includes it, the list says so, and the seed carries kind standby with its marker', async () => {
  const s = await scenario();
  const { A, E, N } = s;
  const rid = await s.raid({ raidOn: '2026-10-24', startTime: '20:00' });
  await s.refresh(A, E, N);
  const page = await openRaid(s, E, rid);
  assert(/data-kind="standby"/.test(page()) && /Standby/.test(stripTags(page())), 'the member has a Standby button');
  await E.handlers.click['su-kind'](el({ 'data-kind': 'standby' }));
  assert.deepEqual(await s.rows("SELECT kind, standby FROM raid_signups WHERE source = 'raidsmith'"), [{ kind: 'signed', standby: 1 }], 'stored as signed with the standby flag');
  let html = page();
  let text = stripTags(html);
  assert(/Expected 1 \/ 25/.test(text) && /Standby 1/.test(text) && /Signed 0/.test(text), text.slice(0, 700));
  assert(/data-kind="standby"[^>]*aria-pressed="true"/.test(html), 'the button shows it is pressed');
  assert(/You are down as <strong>standby<\/strong>/i.test(html) || /standby/i.test(text.slice(text.indexOf('Your sign-up'))), text.slice(0, 700));

  // Another member and the officer see Thoren in the Standby group; the Raids list counts it.
  text = stripTags((await openRaid(s, N, rid))());
  assert(/Standby 1/.test(text) && /Thoren/.test(text), text.slice(0, 700));
  const officer = stripTags((await openRaid(s, A, rid))());
  assert(/Expected 1 \/ 25/.test(officer) && /Standby 1/.test(officer) && /Thoren/.test(officer), officer.slice(0, 700));
  text = ws(stripTags((await openList(s, E))()));
  assert(text.includes('1 / 25 signed up, 1 standby'), text.slice(0, 700));

  // The Worker's own numbers agree, and the seed words it as signed (class and spec) with kind standby and the marker.
  const view = await E.api.signups.view(s.gid, rid);
  assert.deepEqual([view.counts.standby, view.counts.signed, view.counts.expected], [1, 0, 1]);
  const seed = await A.api.get(`${s.base}/raids/${rid}/planner`);
  const row = seed.signups[0];
  assert.deepEqual([row.name, row.kind, row.className, row.marker], ['Thoren', 'standby', 'Paladin', { kind: 'standby', text: 'Standby' }]);
  // Changing it to Signed takes the flag away.
  const again = await openRaid(s, E, rid);
  await E.handlers.click['su-kind'](el({ 'data-kind': 'signed' }));
  assert.deepEqual(await s.rows("SELECT kind, standby FROM raid_signups WHERE source = 'raidsmith'"), [{ kind: 'signed', standby: 0 }]);
  assert(/Standby 0/.test(stripTags(again())) && /Signed 1/.test(stripTags(again())));
});

// ---------------------------------------------------------------------------

// A team with a Tuesday 8 PM schedule and Erin's standing sign-up saved through the Raids page card (the way a member does it).
async function standingWorld() {
  const s = await scenario();
  const { A, E } = s;
  await A.api.signups.saveSchedule(s.gid, s.teamId, { slots: [{ weekday: 2, startTime: '20:00' }], weeks: 3, auto: false });
  const list = await openList(s, E);
  E.pages.standing.afterRender({ name: 'section', section: 'raids' });
  await settle();
  s.card = list;
  return s;
}

check('standing sign-ups: the Raids page card saves the days (one PUT); the schedule fill then signs the member up, the list tags it "standing" and the panel says where it comes from', async () => {
  const s = await standingWorld();
  const { A, E } = s;
  let text = ws(stripTags(s.card()));
  assert(text.includes('Standing sign-ups') && text.includes('Every Tuesday 8:00 PM') && text.includes("I'm in"), text.slice(0, 900));
  const puts = [];
  const realSave = E.api.standing.save;
  E.api.standing.save = (gid, tid, body) => { puts.push(plain(body)); return realSave(gid, tid, body); };
  E.handlers.change['st-toggle'](el({ 'data-wd': '2' }, { checked: true }));
  await E.handlers.submit['standing-form']();
  assert.deepEqual(puts, [{ slots: [{ weekday: 2, kind: 'signed' }] }]);
  assert.deepEqual(await s.rows('SELECT weekday, kind, character_id FROM standing_signups'), [{ weekday: 2, kind: 'signed', character_id: null }]);
  assert(/Standing sign-ups saved\./.test(stripTags(s.card())));
  assert.equal(await s.world.db.prepare('SELECT COUNT(*) AS n FROM raids').first('n'), 0, 'no raid yet, so nothing to sign up for');

  // The officer fills the schedule (Oct 20, Oct 27, Nov 3): every raid carries Thoren's standing sign-up.
  await A.api.signups.fill(s.gid, s.teamId);
  const raids = await s.rows('SELECT id, raid_on FROM raids ORDER BY raid_on');
  assert.deepEqual(raids.map((r) => r.raid_on), ['2026-10-20', '2026-10-27', '2026-11-03']);
  const standing = await s.rows("SELECT raid_id, kind, standing FROM raid_signups WHERE source = 'raidsmith' ORDER BY raid_id");
  assert.deepEqual(standing.map((r) => r.raid_id).sort(), raids.map((r) => r.id).sort());
  assert(standing.every((r) => r.kind === 'signed' && r.standing === 1));
  await s.refresh(A, E);
  const html = (await openList(s, E))();
  text = ws(stripTags(html));
  assert((text.match(/Signed up - Thoren/g) || []).length >= 3 && />standing</.test(html), text.slice(0, 1200));
  const panel = await openRaid(s, E, raids[0].id);
  text = stripTags(panel());
  assert(text.includes('This sign-up comes from your standing sign-up. Skip this week sets you to Can\'t come for this raid only.') && text.includes('Skip this week'), text.slice(0, 900));
});

check('standing sign-ups: an Away notice filed before the fill prevents it, one filed after takes it away; Skip this week makes the raid Absent and it stays through the next reconcile', async () => {
  const s = await standingWorld();
  const { A, E } = s;
  await E.api.standing.save(s.gid, s.teamId, { slots: [{ weekday: 2, kind: 'signed' }] });
  await E.api.away.add(s.gid, { kind: 'away', from: '2026-10-27', to: '2026-10-27', reason: 'Trip' });   // before the raids exist
  await A.api.signups.fill(s.gid, s.teamId);
  const raids = await s.rows('SELECT id, raid_on FROM raids ORDER BY raid_on');
  const [first, covered, third] = raids.map((r) => r.id);
  assert.deepEqual((await s.rows("SELECT raid_id FROM raid_signups ORDER BY raid_id")).map((r) => r.raid_id).sort(), [first, third].sort(), 'the covered raid got none');
  await s.refresh(A, E);
  assert(/You are away \(notice\)/.test(stripTags((await openRaid(s, E, covered))())));

  // A notice filed now removes the Nov 3 sign-up; the panel then shows the notice.
  await E.api.away.add(s.gid, { kind: 'away', from: '2026-11-03', to: '2026-11-03' });
  assert.equal(await s.world.db.prepare('SELECT COUNT(*) AS n FROM raid_signups WHERE raid_id = ?').bind(third).first('n'), 0, 'the notice took the standing sign-up away');
  assert(/You are away \(notice\)/.test(stripTags((await openRaid(s, E, third))())));

  // Skip this week: Absent for this raid, and it stays through the officer's next fill and the member's own re-save.
  const page = await openRaid(s, E, first);
  await E.handlers.click['su-withdraw'](el({}));
  assert.deepEqual(await s.rows('SELECT kind, standing FROM raid_signups WHERE raid_id = ?', first), [{ kind: 'absence', standing: 0 }]);
  const text = stripTags(page());
  assert(/Can(&#39;|')t come 1/.test(text) && /data-kind="absence"[^>]*aria-pressed="true"/.test(page()) && !/Skip this week/.test(text), text.slice(0, 900));
  await A.api.signups.fill(s.gid, s.teamId);
  await E.api.standing.save(s.gid, s.teamId, { slots: [{ weekday: 2, kind: 'signed' }] });
  assert.deepEqual(await s.rows('SELECT kind, standing FROM raid_signups WHERE raid_id = ?', first), [{ kind: 'absence', standing: 0 }], 'still Absent');
});

// ---------------------------------------------------------------------------

// The raid page with the published-roster piece loaded the way the app does after a draw. -> { page (draws the page), route }.
async function openRaidWithRoster(s, G, rid) {
  const page = await openRaid(s, G, rid);
  G.pages.raidRoster.afterRender({ name: 'raid', gid: s.gid, rid });
  await settle();
  return page;
}

check('late and leaving notices: the Sign-ups panel shows "Late 21:00" on the signed-up person\'s row and "Leaves 22:00" in a Notices group for someone with no sign-up, without reasons; the member\'s own notice is named', async () => {
  const s = await scenario();
  const { A, E, N } = s;
  const rid = await s.raid({ raidOn: '2026-10-24', startTime: '20:00' });
  await s.refresh(A, E, N);
  await A.api.signups.savePerson(s.gid, rid, s.people.Kaelith, { kind: 'signed' });
  await E.api.signups.save(s.gid, rid, { kind: 'signed' });
  await A.api.away.add(s.gid, { kind: 'late', from: '2026-10-24', to: '2026-10-24', atTime: '21:00', personId: s.people.Kaelith, reason: 'Night shift' });
  await A.api.away.add(s.gid, { kind: 'leaving', from: '2026-10-24', to: '2026-10-24', atTime: '22:00', personId: s.people.Mirabel, reason: 'Kid to bed' });
  await E.api.away.add(s.gid, { kind: 'late', from: '2026-10-24', to: '2026-10-24', atTime: '20:30' });

  const html = (await openRaid(s, N, rid))();
  const text = ws(stripTags(html));
  assert(text.includes('Thoren Protection Late 20:30') && text.includes('Kaelith Combat Late 21:00') && text.includes('Notices 1 Mirabel Leaves 22:00'), text.slice(0, 1200));
  assert(!/Night shift|Kid to bed/.test(html), 'a reason is for the officers');
  assert.equal(await s.world.db.prepare("SELECT COUNT(*) AS n FROM raid_signups WHERE source = 'raidsmith'").first('n'), 2, 'notices are not sign-ups');
  const mine = ws(stripTags((await openRaid(s, E, rid))()));
  assert(mine.includes('Your notice for this raid: Late 20:30.') && mine.includes('Thoren You Protection Late 20:30'), mine.slice(0, 900));
});

// An upcoming raid with Thoren (Erin) and Gorrim (Gina) signed up and a saved plan: Thoren and Gorrim in group 1, Kaelith in 2, Mirabel on the bench.
async function rosterWorld() {
  const s = await scenario();
  const { A, E, N } = s;
  s.rid = await s.raid({ raidOn: '2026-10-24', startTime: '20:00' });
  await E.api.signups.save(s.gid, s.rid, { kind: 'signed' });
  await N.api.signups.save(s.gid, s.rid, { kind: 'signed' });
  s.plan = (kaelithGroup, mirabelGroup) => A.api.put(`${s.base}/raids/${s.rid}/plan`, {
    label: 'Night 1', players: [{ name: 'Thoren', group: 1 }, { name: 'Gorrim', group: 1 }, { name: 'Kaelith', group: kaelithGroup }, { name: 'Mirabel', group: mirabelGroup }],
  });
  await s.plan(2, 0);
  await s.refresh(A, E, N);
  s.statusOf = async (name) => (await s.rows('SELECT status FROM raid_roster WHERE player_id = ?', s.people[name]))[0].status;
  // The officer's confirm dialogs: click the card's button for the operation, then submit the dialog.
  s.officerDo = async (page, op) => {
    A.dialogs.length = 0;
    A.handlers.click['roster-publish'](el({ 'data-op': op }));
    const html = A.dialogs[0];
    await A.handlers.submit['roster-confirm-form'](dialogForm(html, {}));
    return html;
  };
  return s;
}

check('published line-up: the officer publishes the plan (it asks first); a member sees Your group and the list chip, and Confirm is one request the chip follows', async () => {
  const s = await rosterWorld();
  const { A, E } = s;
  let page = await openRaidWithRoster(s, A, s.rid);
  let text = stripTags(page());
  assert(text.includes('Line-up') && text.includes('Publish line-up'), text.slice(text.indexOf('Line-up'), text.indexOf('Line-up') + 300));
  assert(/Publish the line-up\?/.test(await s.officerDo(page, 'publish')));
  text = ws(stripTags(page()));
  assert(/Published .* by Alice A\./.test(text) && text.includes('0 confirmed, 4 waiting, 0 can\'t come') && text.includes('Group 1') && text.includes('Bench'), text.slice(text.indexOf('Roster'), text.indexOf('Roster') + 700));
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_roster'))[0].n, 4, 'the plan was copied onto the roster');

  page = await openRaidWithRoster(s, E, s.rid);
  text = stripTags(page());
  assert(text.includes('Your group') && text.includes('You\'re in Group 1 as Protection Paladin (Thoren)') && text.includes('Tell the officers if you\'re coming.'), text.slice(0, 900));
  assert(stripTags((await openList(s, E))()).includes('Group 1 - confirm?'), 'the Raids list row has the chip');
  page = await openRaidWithRoster(s, E, s.rid);
  await E.handlers.click['seat-confirm'](el({}));
  await settle();
  text = stripTags(page());
  assert(text.includes('You told the officers you\'re coming.') && !/>Confirm</.test(page()), text.slice(0, 700));
  assert.equal(await s.statusOf('Thoren'), 'confirmed');
  assert(stripTags((await openList(s, E))()).includes('Group 1 - confirmed'), 'and follows the answer');
});

check('published line-up: Can\'t come asks, makes the sign-up Absent and reaches Home; Re-publish after a plan change keeps unchanged answers; Unpublish takes the line-up down', async () => {
  const s = await rosterWorld();
  const { A, E, N } = s;
  let page = await openRaidWithRoster(s, A, s.rid);
  await s.officerDo(page, 'publish');
  await E.api.raidRoster.confirm(s.gid, s.rid);

  // Gina says she cannot make it: the dialog asks, her sign-up becomes Absent, and the officer's Home says so.
  page = await openRaidWithRoster(s, N, s.rid);
  N.dialogs.length = 0;
  N.handlers.click['seat-decline'](el({}));
  assert(/Tell the officers you can&#39;t make it\?|Tell the officers you can't come\?/.test(N.dialogs[0]), N.dialogs[0]);
  await N.handlers.submit['roster-decline-form'](dialogForm(N.dialogs[0], {}));
  await settle();
  assert.deepEqual(await s.rows("SELECT kind FROM raid_signups WHERE player_id = ? AND source = 'raidsmith'", s.people.Gorrim), [{ kind: 'absence' }]);
  assert.equal(await s.statusOf('Gorrim'), 'declined');
  let text = stripTags(page());
  assert(text.includes('You told the officers you can\'t come.') && /Can(&#39;|')t come 1/.test(text), text.slice(0, 900));
  pageState(s, A);
  const home = { name: 'attention', gid: s.gid };
  await A.pages.attention.load(home, A.guildData);
  assert(stripTags(A.pages.attention.main(home, A.guildData)).includes('Sat Oct 24: 1 line-up player can\'t come'));

  // The officer's card counts the answers; the plan changes (Mirabel comes off the bench) and Re-publish keeps the answers of unchanged seats.
  page = await openRaidWithRoster(s, A, s.rid);
  assert(ws(stripTags(page())).includes('1 confirmed, 2 waiting, 1 can\'t come'));
  await s.plan(2, 2);
  page = await openRaidWithRoster(s, A, s.rid);
  assert(stripTags(page()).includes('The plan changed since you published.'));
  assert(/Publish the line-up again\?/.test(await s.officerDo(page, 'republish')));
  text = ws(stripTags(page()));
  assert(!text.includes('The plan changed since you published.') && text.includes('1 confirmed, 2 waiting, 1 can\'t come') && text.includes('Thoren Protection Confirmed Gorrim Holy Can\'t come Group 2 2 Kaelith Combat Waiting Mirabel Marksmanship Waiting'), text.slice(text.indexOf('Roster'), text.indexOf('Roster') + 600));
  assert.equal(await s.statusOf('Thoren'), 'confirmed', 'the unchanged seat keeps its answer');
  assert(stripTags((await openRaidWithRoster(s, E, s.rid))()).includes('You told the officers you\'re coming.'));

  // Unpublish: the card is back to Publish, the member's seat is gone.
  page = await openRaidWithRoster(s, A, s.rid);
  assert(/Unpublish the line-up\?/.test(await s.officerDo(page, 'unpublish')));
  text = stripTags(page());
  assert(text.includes('Publish line-up') && !text.includes('Re-publish line-up'), text.slice(text.indexOf('Roster'), text.indexOf('Roster') + 300));
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_roster'))[0].n, 0);
  assert(!stripTags((await openRaidWithRoster(s, E, s.rid))()).includes('Your group'));
});

// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  const only = process.argv[2];
  for (const { name, fn } of checks) {
    if (only && !name.includes(only)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String((error && error.stack) || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
