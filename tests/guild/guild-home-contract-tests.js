/**
 * Raidsmith guild tracker - officer Home, round 4 (lane H2) CONTRACT test (Worker <-> page)
 * Run: node tests/guild/guild-home-contract-tests.js [name-filter]
 *
 * The real Home page (tests/guild-scripts.js in a vm, no DOM) calls the real Worker (worker/index.js over the node:sqlite D1 stand-in) through G.api:
 * the page's own More -> Hide handler dismisses a to-do, the Hidden list says who did it, Restore brings it back, and the Home badge (app state) is the
 * Worker's total at every step. Same scenario as guild-wave1-contract-tests.js. Discord is faked by an injected fetch; no network, no Wrangler.
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
const SERVER = '900000000000000001';
const NOW = Date.parse('2027-01-16T12:00:00Z'); // Saturday 07:00 in New York
const TODAY = '2027-01-16';
const DAY = 86400000;
const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: 'Bob B' },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  gina: { id: '110000000000000007', username: 'gina', globalName: 'Gina G' },
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const plain = (value) => JSON.parse(JSON.stringify(value));

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
// The pages side: the real scripts with G.api routed to the Worker

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
  return G;
}

// ---------------------------------------------------------------------------
// Scenario: Alice (Guild Master), Bob (Officer), Carol (Team Lead of Alpha), Erin (Member, the person behind Eliora), Gina (Member).
// Alpha: Thoren and Kaelith (raiders), Eliora (raider, Erin), Veyla (trial, ends in 3 days). Bravo: Dorrin. Sixteen weekly Alpha raids (Kaelith has
// slipped), three recent Alpha raids by hand (one flagged, one with loot a stranger won, one with none), an upcoming raid with sign-ups.

const GUILD_BODY = { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember Guard', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };
const TUESDAYS = Array.from({ length: 16 }, (_, i) => new Date(Date.UTC(2026, 8, 29) + i * 7 * DAY).toISOString().slice(0, 10));

async function scenario() {
  const world = await makeWorld();
  const manageable = [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }];
  const member = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
  const jars = { alice: await signIn(world, PEOPLE.alice, manageable) };
  const pages = { alice: loadPages(world, jars.alice) };
  const created = await pages.alice.api.post('/api/guild', GUILD_BODY);
  const gid = created.guild.id;
  const [A, B] = created.teams.map((team) => team.id);
  const base = `/api/guild/${gid}`;
  for (const name of ['bob', 'carol', 'erin', 'gina']) {
    jars[name] = await signIn(world, PEOPLE[name], member);
    pages[name] = loadPages(world, jars[name]);
  }
  const G = pages.alice;
  const uid = {};
  for (const name of Object.keys(jars)) uid[name] = (await pages[name].api.get('/auth/me')).user.id;
  await G.api.put(`${base}/people/${uid.bob}/roles`, { officer: true, teamLeadTeamIds: [] });
  await G.api.put(`${base}/people/${uid.carol}/roles`, { officer: false, teamLeadTeamIds: [A] });
  const p = {};
  const add = async (teamId, name, cls, spec, extra = {}) => {
    const made = await pages.bob.api.post(`${base}/roster`, { teamId, name, class: cls, mainSpec: spec, offSpec: null, status: 'raider', joinedOn: '2026-09-01', ...extra });
    p[name] = made.person.id;
  };
  await add(A, 'Thoren', 'PALADIN', 'Protection');
  await add(A, 'Kaelith', 'ROGUE', 'Combat');
  await add(A, 'Eliora', 'PRIEST', 'Holy');
  await add(A, 'Veyla', 'MAGE', 'Fire', { status: 'trial', joinedOn: '2027-01-05', trialEnd: '2027-01-19' });
  await add(B, 'Dorrin', 'WARRIOR', 'Arms');
  world.db.sqlite.exec(`UPDATE players SET discord_user_id = '${PEOPLE.erin.id}' WHERE id = '${p.Eliora}'`);
  const raid = async (teamId, raidOn, extra = {}) => (await pages.bob.api.post(`${base}/raids`, { teamId, raidOn, ...extra })).raid.id;
  const exec = (sql) => world.db.sqlite.exec(sql);
  const attend = (raidId, teamId, who, outcome, credit) => exec(`INSERT OR REPLACE INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES ('${raidId}', '${gid}', '${teamId}', '${p[who]}', '${outcome}', ${credit}, ${credit > 0 ? 1 : 0})`);
  for (let i = 0; i < TUESDAYS.length; i++) {
    const id = await raid(A, TUESDAYS[i]);
    attend(id, A, 'Thoren', 'present', 1);
    const came = i < 9;
    attend(id, A, 'Kaelith', came ? 'present' : 'missed', came ? 1 : 0);
  }
  const r = {
    flag: await raid(A, '2027-01-13'),
    loot: await raid(A, '2027-01-14'),
    noLoot: await raid(A, '2027-01-15'),
    soon: await raid(A, '2027-01-19', { startTime: '20:00', zone: 'Black Temple', title: 'Night 3' }),
  };
  for (const key of ['flag', 'loot', 'noLoot']) await pages.bob.api.put(`${base}/raids/${r[key]}/manual`, { reason: 'No log kept', presentPlayerIds: [p.Thoren] });
  attend(r.noLoot, A, 'Veyla', 'late', 0.5);
  exec(`UPDATE raids SET open_flags = 3 WHERE id = '${r.flag}'`);
  const realmKey = world.db.sqlite.prepare('SELECT realm_key FROM characters WHERE player_id = ?').get(p.Thoren).realm_key;
  [['Girdle of Mighty Resolve', 'Veyla', 'MS'], ['Boots of the Unjust', 'Stranger', 'MS']].forEach(([item, winner, tag], i) => exec(
    `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, tag, created_at, updated_at)
     VALUES ('lo_${String(i + 1).padStart(22, 'k')}', '${gid}', '${r.loot}', '${A}', 'contract${i}0000', ${31000 + i}, '${item}', ${NOW}, '${winner}', '${winner.toLowerCase()}', '${realmKey}', '${tag}', ${NOW}, ${NOW})`,
  ));
  await pages.erin.api.put(`${base}/raids/${r.soon}/signup`, { kind: 'late' });
  exec(`INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${r.soon}', 'raid_helper', 90, 'signed', 90, '${gid}', '${p.Thoren}')`);
  exec(`INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES ('${r.soon}', 'raid_helper', 91, 'signed', 91, '${gid}', NULL)`);
  const s = { world, jars, pages, gid, A, B, base, uid, p, r, exec };
  s.guildData = async (who) => pages[who].api.get(base);
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// The state bag the pages keep, reset for a fresh render.
function pageState(s, G, gd, teamId = s.A) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: gd };
  S.currentGid = s.gid;
  S.pageAlert = '';
  G.app.teamFor = () => teamId;
  return S;
}

const frame = (gd) => ({ guildData: gd });
const stubEl = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null) }, extra || {});

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------

const desk = (html) => html.slice(html.indexOf('class="gs-hd-desk"'), html.indexOf('class="gs-hd-phone"'));

check('Home: Hide on a to-do (no_loot), the Hidden list says who hid it, Restore brings it back, and the badge is the Worker\'s total at every step', async () => {
  const s = await scenario();
  const G = s.pages.alice;
  const gd = await s.guildData('alice');
  const S = pageState(s, G, gd);
  const view = { name: 'section', gid: s.gid, section: 'home' };
  const itemId = `no_loot:${s.r.noLoot}`;
  const badge = () => G.app.attentionCountFor(s.gid);
  G.app.render = () => {};
  G.ui.announce = () => {};
  G.ui.focusByKey = () => true;

  await G.pages.attention.load(view, gd);
  const x = S.att.attention;
  assert(x.data.items.some((i) => i.id === itemId), 'the Worker sends the no_loot to-do');
  const before = x.data.total;
  assert(before > 0 && badge() === before, 'the badge is total');
  let html = G.pages.attention.main(view, gd, frame(gd));
  assert(desk(html).includes('Hidden (0)'), 'nothing hidden yet');

  // More -> Hide for all officers
  await G.handlers.click['home-hide'](stubEl({ 'data-item': itemId }));
  assert.equal(x.error, '', x.error);
  assert(!x.data.items.some((i) => i.id === itemId), 'gone from the to-dos');
  assert.equal(x.data.total, before - 1);
  assert.equal(badge(), x.data.total, 'the badge follows total');
  assert(x.toast && x.toast.itemId === itemId, 'the undo toast is armed');
  assert.equal(x.data.hidden.length, 1);
  x.hiddenOpen = true;
  html = G.pages.attention.main(view, gd, frame(gd));
  const text = stripTags(desk(html));
  assert(text.includes('Hidden (1)'), text.slice(0, 300));
  assert(/Hidden by Alice A, [A-Z][a-z]{2} \d+/.test(text), 'who hid it and when: ' + text.slice(text.indexOf('Hidden (1)'), text.indexOf('Hidden (1)') + 200));
  assert(text.includes('Restore'));
  assert(html.includes('Hidden for everyone'));

  // a second officer sees it hidden too (shared)
  const bob = await s.guildData('bob');
  const gb = s.pages.bob;
  pageState(s, gb, bob);
  await gb.pages.attention.load(view, bob);
  assert(!gb.app.state.att.attention.data.items.some((i) => i.id === itemId), 'hidden for every officer');
  assert.equal(gb.app.state.att.attention.data.hidden[0].by.name, 'Alice A');

  // Restore (the Hidden list's button)
  await G.handlers.click['home-restore'](stubEl({ 'data-item': itemId }));
  assert.equal(x.error, '', x.error);
  assert(x.data.items.some((i) => i.id === itemId), 'back');
  assert.equal(x.data.total, before);
  assert.equal(badge(), before, 'the badge is total again');
  assert.equal(x.data.hidden.length, 0);
  assert(stripTags(desk(G.pages.attention.main(view, gd, frame(gd)))).includes('Hidden (0)'));

  // Hide again, then the toast's Undo
  await G.handlers.click['home-hide'](stubEl({ 'data-item': itemId }));
  assert.equal(badge(), before - 1);
  await G.handlers.click['home-undo'](stubEl({}));
  assert.equal(x.error, '', x.error);
  assert.equal(badge(), before);
  assert.equal(x.toast, null);

  // a kind that clears when handled is refused by the Worker and the page shows it
  const handled = x.data.items.find((i) => ['applications', 'claims', 'review'].includes(i.kind));
  if (handled) {
    await G.handlers.click['home-hide'](stubEl({ 'data-item': handled.id }));
    assert(x.error, 'the Worker said 400 not_dismissable and the page shows it');
    assert(G.pages.attention.main(view, gd, frame(gd)).includes('Could not hide that to-do'));
    assert.equal(badge(), before, 'nothing changed');
  }
});

check('Home: the week block draws the strip, the selected day and the Briefing from the real answer; the Attendance Reviewed / Undo round trip', async () => {
  const s = await scenario();
  const G = s.pages.alice;
  const gd = await s.guildData('alice');
  const S = pageState(s, G, gd);
  const view = { name: 'section', gid: s.gid, section: 'home' };
  G.app.render = () => {};
  G.ui.announce = () => {};
  G.ui.focusByKey = () => true;
  await G.pages.attention.load(view, gd);
  const html = G.pages.attention.main(view, gd, frame(gd));
  const d = desk(html);
  assert.equal((d.match(/class="gs-hd-day[ "]/g) || []).length, 7);
  assert(stripTags(d).includes('Tue Jan 19, 2027, 8:00 PM ET'), 'the selected day is the next upcoming raid, in the guild zone (the year joins because the test clock is another year): ' + stripTags(d).slice(0, 600));
  assert(/\d+ of \d+ signed\./.test(stripTags(d)), 'the sentence comes from the facts');
  assert.equal((html.match(/gs-btn-molten/g) || []).length, 2, 'one primary per variant');
  const p = html.slice(html.indexOf('class="gs-hd-phone"'));
  assert(p.indexOf('Next raid') < p.indexOf('aria-label="To do"') && p.indexOf('aria-label="To do"') < p.indexOf('aria-label="Coming up"'));

  // Attendance: the watch entry carries its itemId; Reviewed lists it as reviewed (with who); Undo opens it again
  const A = G.pages.attendance;
  G.app.teamFor = () => s.A;
  const getTeam = async () => (await G.api.get(`${s.base}/attendance/team?team=${s.A}`)).watch.entries.find((e) => e.name === 'Kaelith');
  const entry = await getTeam();
  assert(entry && entry.itemId && entry.reviewed === null, JSON.stringify(entry));
  let routed = 0;
  G.app.routeAll = () => { routed++; return Promise.resolve(); };
  await G.handlers.click['att-watch-review'](stubEl({ 'data-item': entry.itemId }));
  const reviewed = await getTeam();
  assert(reviewed && reviewed.reviewed && reviewed.reviewed.by.name === 'Alice A', 'listed, with who reviewed it');
  const card = stripTags(G.pages.attendancePeople.watchHtml(s.gid, { below: 0.75, dropBy: 0.15, window: 8, entries: [reviewed] }));
  assert(card.includes('Reviewed by Alice A,') && card.includes('Comes back if attendance drops 5 more points or a raid is missed.') && card.includes('Undo'), card);
  await G.handlers.click['att-watch-undo'](stubEl({ 'data-item': entry.itemId }));
  assert.equal((await getTeam()).reviewed, null);
  assert.equal(routed, 2);
});

check('Home round 6: the Roles grid draws the real `people` of the selected raid; the arrows read the real /attention/week route (Last week, Next week, Back) and keep the old week on a bad offset', async () => {
  const s = await scenario();
  const G = s.pages.alice;
  const gd = await s.guildData('alice');
  pageState(s, G, gd);
  const view = { name: 'section', gid: s.gid, section: 'home' };
  G.app.render = () => {};
  G.ui.announce = () => {};
  G.ui.focusByKey = () => true;
  await G.pages.attention.load(view, gd);
  const x = G.app.state.att.attention;
  let html = G.pages.attention.main(view, gd, frame(gd));
  // the test clock is Saturday noon and the week's last raid is behind it: the Worker jumps to the next reset week on its own
  assert(x.data.week.autoAdvanced === true && x.data.week.offset === 1, JSON.stringify(x.data.week).slice(0, 200));
  assert(html.includes('>Next week</h1>') && html.includes('Resets Tue') && html.includes('Back to this week'), 'the title, the reset day and Back come from the real week block');
  const raids = x.data.week.raids;
  assert(raids.length && raids.every((w) => Array.isArray(w.people) && typeof w.openSeats === 'number'), 'every raid carries people + openSeats');
  const withPeople = raids.filter((w) => w.people.length);
  assert(withPeople.length, 'the scenario has sign-ups: ' + JSON.stringify(raids.map((w) => [w.raidId, w.people.length])));
  html = G.pages.attention.main(view, gd, frame(gd));
  const panel = desk(html).slice(desk(html).indexOf('aria-label="Selected day"'), desk(html).indexOf('aria-label="Guild"'));
  const shown = x.data.week.raids.filter((w) => panel.includes(`data-key="home-pick-d-${w.raidId}-0"`))[0] || withPeople[0];
  for (const person of shown.people) assert(panel.includes('>' + person.name + '</span>'), 'the grid names ' + person.name);

  // the arrows: the real route
  const click = (offset, key) => G.handlers.click['home-week'](stubEl({ 'data-offset': String(offset), 'data-key': key }));
  await click(0, 'home-week-back');
  assert.equal(x.weekOverride.offset, 0);
  html = G.pages.attention.main(view, gd, frame(gd));
  assert(html.includes('>This week</h1>') && !html.includes('Back to this week') && !html.includes('role="alert"'));
  assert.equal(x.weekOverride.end, new Date(Date.parse(x.data.week.start) - DAY).toISOString().slice(0, 10), 'this week ends the day before the auto-advanced week starts');
  await click(-1, 'home-week-prev');
  assert.equal(x.weekOverride.offset, -1);
  html = G.pages.attention.main(view, gd, frame(gd));
  assert(html.includes('>Last week</h1>') && html.includes('Back to this week') && !html.includes('role="alert"'));
  await click(2, 'home-week-next');
  assert.equal(x.weekOverride.offset, 2);
  assert(G.pages.attention.main(view, gd, frame(gd)).includes('In 2 weeks</h1>'));
  // a bad offset never leaves the page (the page refuses it before the call); the Worker's own refusal is the same
  const bad = await G.api.get(`${s.base}/attention/week?offset=99`).then(() => null, (error) => error);
  assert(bad && bad.status === 400, 'the Worker answers 400 for an offset out of range');
});

// ---------------------------------------------------------------------------

async function main() {
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
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
