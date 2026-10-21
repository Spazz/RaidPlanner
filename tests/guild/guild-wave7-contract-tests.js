/**
 * Raidsmith guild tracker - PM wave 7 CONTRACT tests (Worker <-> pages): read-only API keys, the team progress board and the rank ladder
 * Run: node tests/guild/guild-wave7-contract-tests.js [name-filter]
 *
 * guild-wave7-worker-tests.js and guild-wave7-ui-tests.js each work with hand-made data on the other side. This suite joins them, the way
 * guild-wave5-contract-tests.js does: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1
 * stand-in) through G.api, their real handlers run, and what they draw from the real answers is checked next to what the Worker stored. Discord is never called.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = require('path').join(__dirname, '..', '..');
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000071';
const PEOPLE = {
  alice: { id: '110000000000000701', username: 'alice', globalName: 'Alice A' },
  erin: { id: '110000000000000705', username: 'erin', globalName: 'Erin E' },
};
const NOW = Date.parse('2027-01-15T13:00:00Z');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const ctrl = (value, extra) => Object.assign({ value, checked: false, focus() {}, setAttribute() {} }, extra || {});
const el = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

// ---------------------------------------------------------------------------
// The Worker side

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0 };
  const fakeFetch = async (url, init = {}) => {
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
  const app = createApp({ db, env, fetch: fakeFetch, now: () => clock.now, randomBytes, log: () => {} });
  return { db, clock, discord, app, env };
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
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, Uint8Array, atob, TextDecoder, DecompressionStream };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  G.sandbox = sandbox;
  const f = fetchFor(world, jar);
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  G.texts = {};
  G.errors = [];
  G.dialogs = [];
  G.ui.setText = (id, text) => { G.texts[id] = text; };
  G.ui.setBusy = () => {};
  G.ui.openDialog = (html) => { G.dialogs.push(html); return {}; };
  G.app.render = () => {};
  G.app.handleError = (err) => { G.errors.push(err); };
  G.app.go = () => {};
  return G;
}

const MEMBER_SERVER = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
const OFFICER_SERVER = [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }];
const SPEC_OF = { WARRIOR: 'Arms', MAGE: 'Fire', PRIEST: 'Holy' };

async function scenario() {
  const world = await makeWorld();
  const A = loadPages(world, await signIn(world, PEOPLE.alice, OFFICER_SERVER));
  const created = await A.api.post('/api/guild', { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false });
  const gid = created.guild.id;
  const teamId = created.teams[0].id;
  const base = `/api/guild/${gid}`;
  const E = loadPages(world, await signIn(world, PEOPLE.erin, MEMBER_SERVER));
  const erinUser = (await E.api.get('/auth/me')).user.id;
  const s = { world, A, E, gid, teamId, base };
  s.person = async (name, cls = 'WARRIOR', link = null) => {
    const res = await A.api.post(`${base}/roster`, { teamId, name, class: cls, mainSpec: SPEC_OF[cls], offSpec: null, status: 'raider', ...(link ? { linkUserId: link } : {}) });
    return res.person.id;
  };
  s.erinUser = erinUser;
  s.rows = (sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results);
  s.refresh = async () => { for (const G of [A, E]) G.guildData = await G.api.get(base); };
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function pageState(s, G) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: G.guildData };
  S.currentGid = s.gid;
  S.pageAlert = '';
  G.app.teamFor = () => s.teamId;
  return S;
}

// ---------------------------------------------------------------------------

const exec = (s, sql, ...values) => s.world.db.prepare(sql).bind(...values).run();
const getCsv = async (world, url) => world.app.handle(new Request(url));
const urlsIn = (html) => [...html.matchAll(/value="(https:\/\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

check('Data access: an officer makes a key through the real dialog, the link in it opens the real CSV, the list shows the key, turning it off closes the link; a member cannot even list', async () => {
  const s = await scenario();
  const { A, E } = s;
  await s.person('Aldric');
  await s.person('Brindle', 'MAGE', s.erinUser);
  await s.refresh();
  const S = pageState(s, A);
  A.ui.pageOrigin = () => ORIGIN;
  await A.pages.settingsDataKeys.load(s.gid);
  assert(stripTags(A.pages.settingsDataKeys.settingsHtml({ guildData: A.guildData, data: S.dataKeySettings.data })).includes('No data keys yet.'));
  // The create dialog is drawn from the real answer: every dataset is on offer to a stock guild.
  const dialog = A.pages.settingsDataKeys.createDialogHtml(S.dataKeySettings.data, A.guildData);
  assert.equal((dialog.match(/name="datasets" value="[a-z]+" checked/g) || []).length, 4, dialog.slice(0, 300));
  const form = {
    elements: { name: ctrl('Roster sheet'), teamId: ctrl(''), expiresIn: ctrl('90d') },
    querySelectorAll: (sel) => (sel === 'input[name="datasets"]' ? ['roster', 'attendance'].map((id) => ctrl(id, { checked: true })) : []),
    closest: () => null,
  };
  A.handlers.submit['dkey-form'](form);
  await settle();
  assert.equal(A.dialogs.length, 1, JSON.stringify(A.errors));
  const [csv, attendanceCsv] = urlsIn(A.dialogs[0]).filter((url) => url.includes('.csv?key='));
  assert(csv.startsWith(`${ORIGIN}/api/v1/roster.csv?key=rsk_`) && attendanceCsv.startsWith(`${ORIGIN}/api/v1/attendance.csv?key=rsk_`), A.dialogs[0].slice(0, 400));
  const token = new URL(csv).searchParams.get('key');
  assert(!JSON.stringify(plain(S.dataKeySettings)).includes(token), 'the page keeps no token');
  // The link works for a spreadsheet: no cookie, plain text/csv, the roster.
  const fetched = await getCsv(s.world, csv);
  assert.equal(fetched.status, 200);
  assert.match(fetched.headers.get('content-type'), /text\/csv/);
  const body = await fetched.text();
  assert(body.startsWith('team,character,realm,class,role,main_spec,off_spec,main,status,joined_on\r\n') && body.includes('Aldric') && body.includes('Brindle'), body);
  assert.equal((await getCsv(s.world, `${ORIGIN}/api/v1/loot.csv?key=${token}`)).status, 403, 'it was not made for loot');
  // The list now has the key (and the use).
  await A.pages.settingsDataKeys.load(s.gid);
  const listed = stripTags(A.pages.settingsDataKeys.settingsHtml({ guildData: A.guildData, data: S.dataKeySettings.data }));
  assert(listed.includes('Roster sheet') && listed.includes('Whole guild') && listed.includes('Roster, Attendance') && listed.includes('Used 1 time') && listed.includes('Active'), listed);
  assert(!listed.includes(token));
  // A member sees nothing of it.
  await assert.rejects(E.api.dataKeys.list(s.gid), (error) => error.status === 403);
  // Turn it off through the real dialog: the link stops at once.
  const id = S.dataKeySettings.data.keys[0].id;
  A.handlers.click['dkey-revoke'](el({ 'data-key-id': id }));
  assert(stripTags(A.dialogs[A.dialogs.length - 1]).includes('Turn off this key?'));
  A.handlers.submit['dkey-revoke-form']({ getAttribute: (k) => (k === 'data-key-id' ? id : null), elements: {}, querySelectorAll: () => [], closest: () => null });
  await settle();
  assert.equal(S.dataKeySettings.data.keys[0].status, 'revoked');
  assert.equal((await getCsv(s.world, csv)).status, 401);
});

const T0 = Date.parse('2026-12-01T01:00:00Z');
const MIN = 60 * 1000;

check('Progress: the Raids tab draws the board from the stored pulls (first kill, wipes before it, kills since, best clear); the public page shows it once ticked, with no raid link', async () => {
  const s = await scenario();
  const { A } = s;
  await s.person('Aldric');
  await s.refresh();
  const mk = async (raidOn) => (await A.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn, startTime: '20:00', zone: "Gruul's Lair" })).raid.id;
  const r1 = await mk('2026-12-01');
  const r2 = await mk('2026-12-08');
  const report = (raid, code) => exec(s, "INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES (?, ?, ?, 'fresh', 1, 2, 'up', 1)", raid, s.gid, code);
  const pull = (raid, code, fight, enc, name, kill, start, end) => exec(s, 'INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', raid, code, fight, enc, name, kill, start, end);
  await report(r1, 'ReportCodeAAAA01');
  await report(r2, 'ReportCodeBBBB02');
  await pull(r1, 'ReportCodeAAAA01', 1, 649, 'High King Maulgar', 0, T0, T0 + 4 * MIN);
  await pull(r1, 'ReportCodeAAAA01', 2, 649, 'High King Maulgar', 0, T0 + 10 * MIN, T0 + 14 * MIN);
  await pull(r1, 'ReportCodeAAAA01', 3, 649, 'High King Maulgar', 1, T0 + 20 * MIN, T0 + 28 * MIN);
  await pull(r2, 'ReportCodeBBBB02', 1, 649, 'High King Maulgar', 1, T0 + 7 * 86400000, T0 + 7 * 86400000 + 6 * MIN);
  await pull(r2, 'ReportCodeBBBB02', 2, 650, 'Gruul the Dragonkiller', 1, T0 + 7 * 86400000 + 10 * MIN, T0 + 7 * 86400000 + 19 * MIN);
  const S = pageState(s, A);
  const x = { gid: s.gid, teamId: s.teamId, tab: 'progress' };
  await A.pages.progress.load(x);
  const html = A.pages.progress.tabHtml(x);
  const t = stripTags(html);
  assert(t.includes("Gruul's Lair") && t.includes('2 of 2 bosses down') && t.includes('High King Maulgar') && t.includes('Gruul the Dragonkiller'), t);
  assert(t.includes('Best clear: 2 bosses in 19m on'), t);
  const maulgar = x.progress.data.zones[0].bosses[0];
  assert.deepEqual([maulgar.wipesBeforeKill, maulgar.kills, maulgar.killsSince, maulgar.firstKillOn], [2, 2, 1, '2026-12-01']);
  assert(html.includes(`#/g/${s.gid}/raids/r/${r2}`), 'a night links to its raid');
  assert(!html.includes('ReportCode'), 'no report code on the page');
  // The raid list shows the third tab with the real answer.
  A.guildData = await A.api.get(s.base);
  S.guilds = { [s.gid]: A.guildData };
  const list = await A.api.get(`${s.base}/raids?team=${s.teamId}`);
  const page = A.pages.raids.raidsHtml({ guildData: A.guildData, teamId: s.teamId, data: list, tab: 'progress', progressHtml: html });
  assert(/aria-pressed="true" data-action="raids-tab" data-value="progress"/.test(page) && stripTags(page).includes('Boss progress from the logged raids'));
  // The public page: off until ticked; then the board, without raid ids and report codes.
  const visitor = loadPages(s.world, {});
  await assert.rejects(visitor.api.get(`/api/public/${s.gid}`), (error) => error.status === 404);
  await A.api.put(`${s.base}/public`, { enabled: true, sections: ['progress'] });
  const view = await visitor.pages.view.load({ name: 'public', gid: s.gid });
  assert.equal(view.error, null);
  const publicHtml = visitor.pages.view.viewHtml({ data: view.data, kind: 'public' });
  const pt = stripTags(publicHtml);
  assert(pt.includes('Progress') && pt.includes("Gruul's Lair") && pt.includes('High King Maulgar') && pt.includes('Best clear'), pt);
  assert(!publicHtml.includes(r1) && !publicHtml.includes(r2) && !publicHtml.includes('ReportCode') && !/href="#\/g\//.test(publicHtml));
});

check('Rank ladder: saved in the attendance settings, drawn on the Attendance page, accepted with one click through the real handler, listed on Home, set by hand on the person page', async () => {
  const s = await scenario();
  const { A } = s;
  const aldric = await s.person('Aldric');
  const brindle = await s.person('Brindle', 'MAGE');
  await s.refresh();
  const dates = ['2026-12-29', '2027-01-05', '2027-01-12'];
  const raids = [];
  for (const raidOn of dates) raids.push((await A.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn, startTime: '20:00', zone: "Gruul's Lair" })).raid.id);
  const attend = (raid, pid, outcome, credit) => exec(s, 'INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, ?, ?)', raid, s.gid, s.teamId, pid, outcome, credit, credit > 0 ? 1 : 0);
  for (const raid of raids) await attend(raid, aldric, 'present', 1);
  await attend(raids[0], brindle, 'present', 1);
  await attend(raids[1], brindle, 'missed', 0);
  await attend(raids[2], brindle, 'missed', 0);
  await exec(s, "UPDATE players SET joined_on = '2026-09-01', rank = 'raider', rank_on = '2026-10-01' WHERE id = ?", brindle);
  await exec(s, "UPDATE players SET joined_on = '2026-09-01' WHERE id = ?", aldric);
  const ladder = [{ id: 'member', name: 'Member', rules: {} }, { id: 'raider', name: 'Raider', rules: { minAttendance: 0.75, minWeeksAttended: 2, since: 'join' } }];
  // The settings page saves the ladder with the rest of the policy.
  const S = pageState(s, A);
  const route = { name: 'settings', gid: s.gid, tab: 'attendance' };
  await A.pages.settingsAtt.load(route, A.guildData);
  assert(A.pages.settingsAtt.main(route, A.guildData, { guildData: A.guildData }).includes('data-action="pol-rank-start"'), 'no ladder yet');
  A.app.render = () => {};
  A.handlers.click['pol-rank-start'](el({}));
  const settingsForm = { querySelectorAll: () => [], closest: () => null };
  A.ui.setBusy = () => {};
  A.handlers.submit['pol-form'](settingsForm);
  await settle();
  const saved = await A.api.get(`${s.base}/attendance/policy`);
  assert.deepEqual(plain(saved.resolved[s.teamId].ladder.ranks.map((r) => r.id)), ['member', 'raider'], JSON.stringify(A.errors) + JSON.stringify(S.att.settingsAtt && S.att.settingsAtt.view && null));
  assert.equal(saved.guild.ladder.ranks[1].rules.minAttendance, 0.75);
  // Attendance page: Aldric (no rank yet) is asked about Raider, Brindle (a Raider at 33%) about a review.
  const teamRoute = { name: 'section', gid: s.gid, section: 'attendance' };
  S.att = {};
  await A.pages.attendance.load(teamRoute, A.guildData);
  let page = A.pages.attendance.main(teamRoute, A.guildData);
  let t = stripTags(page);
  assert(t.includes('Suggested: promote to Raider') && t.includes('Suggested: review (below Raider)'), t.slice(0, 1500));
  // Accept Aldric's through the real handler, with the attributes the page drew.
  const accept = [...page.matchAll(/<button[^>]*data-action="rank-accept"([^>]*)>/g)].map((m) => m[1]).find((attrs) => attrs.includes(`data-pid="${aldric}"`));
  assert(accept, 'Aldric\'s Accept button');
  const attrOf = (name) => new RegExp(`${name}="([^"]*)"`).exec(accept)[1];
  const routed = [];
  A.app.routeAll = (o) => { routed.push(o); return Promise.resolve(); };
  A.handlers.click['rank-accept'](el({ 'data-pid': attrOf('data-pid'), 'data-team': attrOf('data-team'), 'data-kind': attrOf('data-kind'), 'data-to': attrOf('data-to'), 'data-from': attrOf('data-from') }));
  await settle();
  assert.deepEqual(plain(routed), [{ force: true }], JSON.stringify(A.errors));
  const row = (await s.rows('SELECT rank, rank_on FROM players WHERE id = ?', aldric))[0];
  assert.equal(row.rank, 'raider');
  assert.match(row.rank_on, /^2027-01-15$/);
  const audit = await s.rows("SELECT action FROM audit_log WHERE action = 'person.rank'");
  assert.equal(audit.length, 1);
  // The page, read again: Aldric is a Raider, his suggestion is gone; Brindle still has hers.
  await A.pages.attendance.load(teamRoute, A.guildData);
  page = A.pages.attendance.main(teamRoute, A.guildData);
  t = stripTags(page);
  assert(!t.includes('Suggested: promote to Raider') && t.includes('Suggested: review (below Raider)'), t.slice(0, 1200));
  // Home no longer lists rank suggestions (round 2: they live on the Ranks page); it only counts what is left for the Guild box.
  const home = { name: 'section', gid: s.gid, section: 'home' };
  await A.pages.attention.load(home, A.guildData);
  const homeHtml = A.pages.attention.main(home, A.guildData);
  assert(!stripTags(homeHtml).includes('Brindle'), stripTags(homeHtml).slice(0, 800));
  assert.equal(A.app.state.att.attention.data.counts[s.teamId].rankOpen, 1);
  // The person's page: set a rank by hand.
  const personRoute = { name: 'personatt', gid: s.gid, pid: brindle };
  await A.pages.personAtt.load(personRoute, A.guildData);
  const personHtml = A.pages.personAtt.main(personRoute, A.guildData);
  assert(personHtml.includes('data-action="rank-set"') && stripTags(personHtml).includes('Suggested: review (below Raider)'));
  A.sandbox.document.getElementById = (id) => (id === 'pa-rank' ? { value: 'member' } : null);
  A.handlers.click['rank-set'](el({ 'data-pid': brindle, 'data-team': s.teamId, 'data-from': 'raider' }));
  await settle();
  assert.equal((await s.rows('SELECT rank FROM players WHERE id = ?', brindle))[0].rank, 'member');
  // A member is refused the team page (the officers-only decision of 2026-10-21).
  const E = s.E;
  await E.api.get(s.base);
  await exec(s, "UPDATE players SET user_id = ? WHERE id = ?", s.erinUser, aldric);
  await assert.rejects(E.api.get(`${s.base}/attendance/team?team=${s.teamId}`), (err) => err.status === 403);
});


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
