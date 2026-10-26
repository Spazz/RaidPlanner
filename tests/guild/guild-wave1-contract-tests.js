/**
 * Raidsmith guild tracker - PM wave 1 (officer tools) CONTRACT tests (Worker <-> pages)
 * Run: node tests/guild/guild-wave1-contract-tests.js [name-filter]
 *
 * guild-wave1-worker-tests.js and guild-wave1-ui-tests.js each work from the contract in tasks/reference/guild-pm-wave1-spec.md with hand-made data on
 * the other side. This suite joins them: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the
 * node:sqlite D1 stand-in) through G.api, and what the pages draw from the real answers is checked - the Activity log, the Watch list card and
 * its policy fields, Needs attention (and the nav that follows from the real permissions), the Trial review card and its buttons, and the
 * calendar link, including a real fetch of the ICS file. A field one side names differently, nests differently or leaves out shows up here as a
 * missing name, a blank cell or a thrown error. Discord is faked by an injected fetch; no network, no Wrangler, no credentials.
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

check('activity log: the real rows draw as sentences with who and when; filters, Older and the CSV link work against the Worker', async () => {
  const s = await scenario();
  const G = s.pages.alice;
  const gd = await s.guildData('alice');
  assert(G.shell.hasAction(gd.me.can, 'audit.view'), 'the Guild Master holds audit.view in the real payload');
  const tabs = G.shell.settingsTabs(gd.me.can).map((t) => t.tab);
  assert(tabs.includes('activity'), 'the Activity tab is offered');
  pageState(s, G, gd);
  const view = { name: 'settings', gid: s.gid, tab: 'activity' };
  await G.pages.settingsActivity.load(view, gd);
  const x = G.app.state.att.settingsActivity;
  assert(x && x.rows.length > 0 && x.types.length === 7 && x.actors.length >= 1, 'the list, the seven types and the people loaded');
  assert.equal(x.timeZone, 'America/New_York');
  const html = G.pages.settingsActivity.main(view, gd, frame(gd));
  const text = stripTags(html.replace(/<pre[\s\S]*?<\/pre>/g, ''));
  for (const wanted of ['Added Thoren to the roster as Raider', 'Created the raid on', 'Entered attendance by hand', 'Made Bob B an Officer', 'Made Carol C Team Lead of Alpha']) {
    assert(text.includes(wanted), `the page says "${wanted}"`);
  }
  assert(text.includes('Alice A') && text.includes('Bob B'), 'who did it');
  assert(!/undefined|null|\[object/.test(text), 'no leaked placeholder');
  assert(/Download CSV/.test(text) && /Older/.test(text) === !!x.next);

  // Filter by type through the page's own handler: only roster sentences come back.
  await G.handlers.change['audit-filter'](stubEl({ 'data-filter': 'type' }, { value: 'roster' }));
  const roster = G.app.state.att.settingsActivity;
  assert(roster.rows.length > 0 && roster.rows.every((row) => row.group === 'roster'), 'only roster changes');
  assert.equal(roster.filters.type, 'roster');
  const csvPath = G.api.audit.csvUrl(s.gid, roster.filters);
  assert(/\/audit\?type=roster&format=csv$/.test(csvPath), csvPath);
  const csv = await fetchFor(s.world, s.jars.alice)(csvPath, { method: 'GET' });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  const body = await csv.text();
  assert(body.split('\r\n').filter(Boolean).length === roster.rows.length + 1, 'the CSV holds the filtered rows and a header');
  assert(/Added Thoren to the roster as Raider/.test(body));

  // The person filter uses ids from the Worker's own actor list; a date range in the guild zone is accepted.
  await G.handlers.click['audit-clear']();
  const bobId = G.app.state.att.settingsActivity.actors.find((actor) => actor.displayName === 'Bob B').id;
  await G.handlers.change['audit-filter'](stubEl({ 'data-filter': 'actor' }, { value: bobId }));
  assert(G.app.state.att.settingsActivity.rows.every((row) => row.actor && row.actor.displayName === 'Bob B'));
  await G.handlers.change['audit-filter'](stubEl({ 'data-filter': 'from' }, { value: '2027-01-16' }));
  await G.handlers.change['audit-filter'](stubEl({ 'data-filter': 'to' }, { value: '2027-01-16' }));
  assert(G.app.state.att.settingsActivity.rows.length > 0 && !G.app.state.att.settingsActivity.error);

  // Older: 120 more rows, the page asks for the next 50 with the Worker's cursor and appends them once each.
  s.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120)
          INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at)
          SELECT 'al_' || printf('%022d', i), '${s.gid}', NULL, 'person.notes', 'person', NULL, NULL, NULL, ${NOW - 400 * DAY} + i FROM n`);
  await G.handlers.click['audit-clear']();
  await G.handlers.change['audit-filter'](stubEl({ 'data-filter': 'type' }, { value: 'roster' }));
  const before = G.app.state.att.settingsActivity;
  assert.equal(before.rows.length, 50);
  assert(before.next);
  await G.handlers.click['audit-older']();
  const after = G.app.state.att.settingsActivity;
  assert.equal(after.rows.length, 100);
  assert.equal(new Set(after.rows.map((row) => row.id)).size, 100, 'no row twice');
  assert(after.rows[99].at <= after.rows[0].at);
  const old = G.pages.settingsActivity.activityHtml({ guildData: gd, s: after, now: NOW });
  assert(/Dec \d+, 2025/.test(stripTags(old)), 'a row from another year shows its year');
  assert.equal(G.pages.settingsActivity.whoText({ actor: null }), 'Former member');
});

check('activity log: nobody else gets the tab or the data', async () => {
  const s = await scenario();
  for (const who of ['bob', 'carol', 'erin', 'gina']) {
    const G = s.pages[who];
    const gd = await s.guildData(who);
    assert(!G.shell.hasAction(gd.me.can, 'audit.view'), `${who} does not hold audit.view`);
    assert(!G.shell.settingsTabs(gd.me.can).some((t) => t.tab === 'activity'), `${who} is not offered the tab`);
    pageState(s, G, gd);
    let error = null;
    try { await G.pages.settingsActivity.load({ name: 'settings', gid: s.gid, tab: 'activity' }, gd); } catch (e) { error = e; }
    assert(error && error.status === 403, `${who}: the Worker refuses`);
    assert.equal(G.api.classify(error).view, 'message');
  }
});

check('watch list: the Worker\'s watch object draws the Needs a look panel (names, reason sentence with percent and was); members and "off" get none', async () => {
  const s = await scenario();
  const G = s.pages.alice;
  const gd = await s.guildData('alice');
  pageState(s, G, gd);
  const view = { name: 'section', gid: s.gid, section: 'attendance' };
  await G.pages.attendance.load(view, gd);
  const data = G.app.state.att.team.data;
  assert(data && data.watch && data.watch.entries.length >= 1, 'the Worker sent a watch list');
  const text = stripTags(G.pages.attendance.main(view, gd));
  assert(/Needs a look/.test(text), text.slice(0, 400));
  const kael = data.watch.entries.find((e) => e.name === 'Kaelith');
  assert(kael && kael.reasons.includes('below') && kael.reasons.includes('drop'));
  assert(text.includes('Kaelith') && new RegExp(`${Math.round(kael.pct)}%`).test(text) && /was 100%/.test(text), 'the entry shows its numbers');
  assert(/Below 75% and down \d+ points - \d+%, was 100%/.test(text), 'one sentence for the reasons');
  assert(!/undefined|null|NaN/.test(text));
  const href = new RegExp(`href="#/g/${s.gid}/attendance/p/${s.p.Kaelith}"`);
  assert(href.test(G.pages.attendance.main(view, gd)), 'the name links to the person\'s history');

  // A Team Lead of the team sees it; Erin (a member) gets her own record, no team page.
  const carolGd = await s.guildData('carol');
  pageState(s, s.pages.carol, carolGd);
  await s.pages.carol.pages.attendance.load(view, carolGd);
  assert(/Needs a look/.test(stripTags(s.pages.carol.pages.attendance.main(view, carolGd))));
  const erinGd = await s.guildData('erin');
  pageState(s, s.pages.erin, erinGd);
  await s.pages.erin.pages.attendance.load(view, erinGd);
  assert(!s.pages.erin.app.state.att.team, 'a member never fetches the team page');
  assert(!/Needs a look/.test(stripTags(s.pages.erin.pages.attendance.main(view, erinGd))));

  // Both thresholds off through the real policy route: no card.
  const policy = await G.api.get(`${s.base}/attendance/policy`);
  await G.api.put(`${s.base}/attendance/policy`, { policy: { watch: { below: null, dropBy: null } }, expectedVersion: policy.versions.guild });
  await G.pages.attendance.load(view, gd);
  assert.equal(G.app.state.att.team.data.watch, null);
  assert(!/Needs a look/.test(stripTags(G.pages.attendance.main(view, gd))));
});

check('watch list: the Attendance settings fields show the real thresholds as percent and save fractions the Worker accepts', async () => {
  const s = await scenario();
  const G = s.pages.alice;
  const gd = await s.guildData('alice');
  pageState(s, G, gd);
  const view = { name: 'settings', gid: s.gid, tab: 'attendance' };
  await G.pages.settingsAtt.load(view, gd);
  const text = stripTags(G.pages.settingsAtt.main(view, gd, frame(gd)));
  assert(/Watch list/.test(text) && /Flag people below \(percent\)/.test(text) && /Flag a drop of \(points\)/.test(text));
  const html = G.pages.settingsAtt.main(view, gd, frame(gd));
  assert(/data-path="watch\.below"[^>]*/.test(html) && /id="p-watch-below"[^>]*value="75"/.test(html.replace(/\s+/g, ' ')) || /value="75"[^>]*data-path="watch\.below"/.test(html), 'Flag people below shows 75');
  assert.equal(G.pages.settingsAtt.percentOf(0.755), 75.5);
  assert.equal(G.pages.settingsAtt.fractionOf('75'), 0.75);
  assert.equal(G.pages.settingsAtt.fractionOf('12.5'), 0.125);
  assert.equal(G.pages.settingsAtt.fractionOf(''), null);
  // What the page would send for "60" and a blank: the Worker takes it (and a value with too many decimals is refused with the field named).
  const view0 = await G.api.get(`${s.base}/attendance/policy`);
  const saved = await G.api.put(`${s.base}/attendance/policy`, { policy: { watch: { below: G.pages.settingsAtt.fractionOf('60'), dropBy: G.pages.settingsAtt.fractionOf('') } }, expectedVersion: view0.versions.guild });
  assert.deepEqual(plain(saved.resolved[s.A].watch), { below: 0.6, dropBy: null });
  await G.pages.settingsAtt.load(view, gd);
  assert(/value="60"/.test(G.pages.settingsAtt.main(view, gd, frame(gd))), 'the saved 60 comes back');
  let error = null;
  try { await G.api.put(`${s.base}/attendance/policy`, { policy: { watch: { below: 0.7555 } }, expectedVersion: saved.versions.guild }); } catch (e) { error = e; }
  assert(error && error.status === 400 && error.field === 'watch.below', 'the page reads err.field = watch.below');
});

check('needs attention: the real answer draws every item with a sentence and a link that parses back; the nav follows the real permissions', async () => {
  const s = await scenario();
  const G = s.pages.alice;
  const gd = await s.guildData('alice');
  pageState(s, G, gd);
  const view = { name: 'section', gid: s.gid, section: 'home' };
  assert.deepEqual(plain(G.router.parse(`#/g/${s.gid}`)), { name: 'section', gid: s.gid, section: 'home' });
  await G.pages.attention.load(view, gd);
  const data = G.app.state.att.attention.data;
  const kinds = new Set(data.items.map((item) => item.kind));
  for (const kind of ['review', 'loot_unmatched', 'signup_unmatched', 'claims', 'trial', 'no_loot', 'low_signups']) {
    if (kind === 'claims') continue; // no claim in this scenario
    assert(kinds.has(kind), `the scenario produced ${kind}`);
  }
  assert(!kinds.has('watch') && data.counts[s.A].watchOpen >= 1, 'the watch list left Home (round 2): it is only counted per team');
  // The selected day shows its raid's to-dos: draw the page once per raid that has one (and once with the default selection) and read them all.
  const raidIds = [...new Set(data.items.filter((i) => i.raidId).map((i) => i.raidId))];
  const pages = [G.pages.attention.main(view, gd)];
  for (const raidId of raidIds) { G.app.state.att.attention.sel = raidId; pages.push(G.pages.attention.main(view, gd)); }
  delete G.app.state.att.attention.sel;
  const html = pages.join(' ');
  const text = stripTags(html);
  assert(/(This|Next) week/.test(text) && !/Needs attention/.test(text));
  for (const item of data.items.filter((i) => !i.readiness)) {
    const sentence = G.pages.attention.itemText(item);
    assert(sentence && !/undefined|null|NaN/.test(sentence), `${item.kind}: ${sentence}`);
    assert(text.includes(sentence), `the page shows "${sentence}"`);
    const href = G.pages.attention.itemHref(s.gid, item);
    const parsed = G.router.parse(href);
    assert(parsed.name !== 'notfound' && parsed.gid === s.gid, `${item.kind} links to a real route: ${href}`);
    if (item.link.rid) assert.equal(parsed.rid, item.link.rid);
    if (item.link.pid) assert.equal(parsed.pid, item.link.pid);
    assert(html.includes(`href="${href}"`));
  }
  assert(/Review .* 3 to decide/.test(text) && /Veyla's trial ends in 3 days/.test(text), text.slice(0, 600));
  assert(/1 loot winner on .* matches nobody/.test(text) && /1 sign-up on .* is not linked to a person/.test(text));
  assert(/No loot imported for/.test(text) && /\d+ of 25 signed\./.test(text), 'the sign-up facts are in the week sentence');
  assert(/Alpha/.test(text), 'the team shows with several teams');

  // The Home badge is the Worker's total, and only attention viewers get the count (the same rule the Worker enforces); everyone else has a Home page without one.
  const ctx = { guildData: gd, attentionCount: data.total, teamId: s.A, page: 'app', section: 'guild' };
  assert.equal(G.shell.homeBadge(ctx), data.total);
  assert.equal(G.shell.sidebarItems(ctx)[0].key, 'home');
  assert.equal(G.shell.sidebarItems(ctx)[0].badge, data.total);
  for (const who of ['alice', 'bob', 'carol', 'erin', 'gina']) {
    const g = await s.guildData(who);
    const answer = await s.pages[who].api.get(`${s.base}/attention`).then(() => 200, (e) => e.status);
    assert.equal(s.pages[who].shell.canSeeAttention(g.me.can), answer === 200, `${who}: the nav and the Worker agree (${answer})`);
    const items = s.pages[who].shell.sidebarItems({ guildData: g, attentionCount: 3, teamId: s.A, page: 'app', section: 'guild' });
    const home = items.filter((item) => item.key === 'home');
    assert.equal(home.length, 1, `${who}: every member has a Home in the nav`);
    assert.equal(home[0].badge, answer === 200 ? 3 : 0, `${who}: only the officer Home counts open work`);
  }
  // A Team Lead sees only her team's items.
  const carolGd = await s.guildData('carol');
  const carolData = await s.pages.carol.api.attention.get(s.gid);
  assert(carolData.items.length > 0 && carolData.items.every((item) => item.teamId === s.A || item.teamId === null));
});

check('trial review: the card draws the real numbers, the buttons PATCH the person and the End note is appended to the notes', async () => {
  const s = await scenario();
  const G = s.pages.bob;
  const gd = await s.guildData('bob');
  const S = pageState(s, G, gd);
  let record = await G.api.get(`${s.base}/roster/${s.p.Veyla}`);
  S.person = { gid: s.gid, pid: s.p.Veyla, record };
  await G.pages.personTrial.loadCard(s.gid, s.p.Veyla, gd, record);
  const state = G.pages.personTrial.cardState(s.gid, s.p.Veyla);
  assert(state && state.data && !state.error, 'the card loaded');
  const text = stripTags(G.pages.personTrial.cardHtml({ guildData: gd, gid: s.gid, pid: s.p.Veyla, record, state }));
  for (const wanted of ['Trial review', 'Jan 5, 2027 - Jan 19, 2027', 'ends in 3 days', 'Raids', 'Attendance', 'Missed', 'Late or left early', 'Loot 1 MS', 'Promote to Raider', 'Extend trial', 'End trial']) {
    assert(text.includes(wanted), `the card says "${wanted}": ${text.slice(0, 300)}`);
  }
  assert(!/undefined|null|NaN/.test(text));
  assert.equal(state.data.attendance.raids, 1, 'the one raid since the trial started that she has a row on');
  assert.equal(G.pages.personTrial.shows(record), true);
  // The member behind a normal raider sees no card; a lead of another team gets the Worker's 403, which is "no card".
  const erin = await s.pages.erin.api.get(`${s.base}/roster/${s.p.Eliora}`);
  assert.equal(s.pages.erin.pages.personTrial.shows(erin), false);

  // Extend: the dialog's default date is later than the end; the PATCH the card sends is accepted and the record comes back with it.
  const extendHtml = G.pages.personTrial.extendDialogHtml(record, state.data.today, G.pages.personTrial.teamTrialDays(gd, record));
  const defaultEnd = /name="trialEnd"[^>]*value="([0-9-]+)"/.exec(extendHtml)[1];
  assert.equal(defaultEnd, '2027-02-02', '14 days after the end that is still ahead');
  record = await G.api.trial.update(s.gid, s.p.Veyla, { expectedVersion: record.person.version, trialEnd: defaultEnd });
  assert.equal(record.person.trialEnd, '2027-02-02');
  assert.equal(record.person.status, 'trial');
  G.pages.person.ops.applyRecord({ gid: s.gid, pid: s.p.Veyla, rec: record, gd }, record);
  assert.equal(S.person.record.person.trialEnd, '2027-02-02', 'applyRecord keeps the answer');

  // End: Inactive with no reason (Other is gone, U B2-Q1); the note goes to the end of the officer notes as "Trial ended <today>: <note>".
  const ended = await G.api.trial.update(s.gid, s.p.Veyla, { expectedVersion: record.person.version, status: 'inactive' });
  assert.deepEqual([ended.person.status, ended.person.leftReason], ['inactive', null]);
  assert(ended.can.notesEdit && ended.notes, 'the record carries the notes version the append needs');
  S.person = { gid: s.gid, pid: s.p.Veyla, record: ended };
  // The note the End dialog collects goes onto the end of the officer notes through the real notes route (the dialog itself needs a DOM).
  const line = `Trial ended ${TODAY}: Not a fit for the schedule`;
  const saved = await G.api.trial.saveNotes(s.gid, s.p.Veyla, { text: line, expectedNotesVersion: ended.notes.version });
  assert.equal(saved.notes.text, line);
  assert.equal(saved.notes.version, ended.notes.version + 1);
  const card = await G.api.get(`${s.base}/roster/${s.p.Veyla}/trial`);
  assert.equal(card.notes.excerpt, line, 'the card\'s excerpt shows what was appended');
  assert.equal(card.person.status, 'inactive');
  assert.equal(G.pages.personTrial.shows(ended), false, 'an ended trial has no card');
});

check('trial review: the Worker\'s 403 for someone who may not edit the person is "no card", not an error page', async () => {
  const s = await scenario();
  const G = s.pages.erin;
  const gd = await s.guildData('erin');
  pageState(s, G, gd);
  await G.pages.personTrial.loadCard(s.gid, s.p.Veyla, gd, { person: { status: 'trial' }, can: { edit: true } });
  assert.equal(G.pages.personTrial.cardState(s.gid, s.p.Veyla), null, 'the 403 became no card');
  assert.equal(G.pages.personTrial.cardHtml({ guildData: gd, gid: s.gid, pid: s.p.Veyla, record: { person: { status: 'trial' }, can: { edit: true } }, state: null }), '');
});

check('calendar: the Raids page offers the button, the link is made, shown once, fetched as a real ICS, and turned off', async () => {
  const s = await scenario();
  const G = s.pages.erin;
  const gd = await s.guildData('erin');
  pageState(s, G, gd);
  const raids = await G.api.get(`${s.base}/raids?team=${s.A}`);
  const html = G.pages.raids.raidsHtml({ guildData: gd, teamId: s.A, data: raids });
  assert(/data-action="cal-open"/.test(html) && /Subscribe in your calendar/.test(stripTags(html)), 'a member sees the button');

  const status = await G.api.calendar.status(s.gid, s.A);
  assert.deepEqual(plain(status), { team: { id: s.A, name: 'Alpha' }, subscribed: false, createdAt: null, lastUsedAt: null });
  const off = stripTags(G.pages.calendar.mainHtml({ phase: 'off', busy: false, error: '', status }));
  assert(off.includes(G.pages.calendar.INTRO) && /Create my link/.test(off));
  const made = await G.api.calendar.create(s.gid, s.A);
  assert.equal(made.subscribed, true);
  assert(/^https:\/\/raidsmith\.test\/cal\/[A-Za-z0-9_-]{43}\.ics$/.test(made.url) && /^webcal:\/\/raidsmith\.test\/cal\//.test(made.webcalUrl), made.url);
  assert.equal(G.pages.calendar.safeHref(made.webcalUrl), made.webcalUrl, 'the open-in-app link is accepted as sent');
  const created = G.pages.calendar.mainHtml({ phase: 'created', busy: false, error: '', status: made, link: { url: made.url, webcalUrl: made.webcalUrl } });
  assert(created.includes(`value="${made.url}"`) && created.includes(`href="${made.webcalUrl}"`) && stripTags(created).includes(G.pages.calendar.ONE_TIME));

  // The very address the dialog shows, fetched with no cookie: a real calendar document for the team.
  const feed = await s.world.app.handle(new Request(made.url));
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  const ics = await feed.text();
  assert(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n') && !/(^|[^\r])\n/.test(ics));
  assert(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75));
  const unfolded = ics.replace(/\r\n /g, '');
  assert(unfolded.includes('X-WR-CALNAME:Ember Guard - Alpha'));
  assert(unfolded.includes(`UID:${s.r.soon}@raidsmith`) && unfolded.includes('SUMMARY:Night 3'));
  const description = /DESCRIPTION:([^\r\n]*Signed[^\r\n]*)/.exec(unfolded);
  assert(description && /Signed 2\\, Late 1/.test(description[1]) && /Your sign-up: Late/.test(description[1]), description && description[1]);

  // The next status read says it is on and used, without the address; the page text for that state.
  const on = await G.api.calendar.status(s.gid, s.A);
  assert.deepEqual([on.subscribed, on.createdAt, on.lastUsedAt], [true, NOW, NOW]);
  assert(!JSON.stringify(on).includes(made.url.split('/cal/')[1].slice(0, 20)));
  const onText = stripTags(G.pages.calendar.mainHtml({ phase: 'on', busy: false, error: '', status: on }));
  assert(/Your link is on \(created .*last used today\)/.test(onText), onText);

  // Replace: the old address stops, the new one works. Turn off: it stops too.
  const second = await G.api.calendar.create(s.gid, s.A);
  assert.equal((await s.world.app.handle(new Request(made.url))).status, 404);
  assert.equal((await s.world.app.handle(new Request(second.url))).status, 200);
  const gone = await G.api.calendar.revoke(s.gid, s.A);
  assert.deepEqual(plain(gone), { team: { id: s.A, name: 'Alpha' }, subscribed: false, createdAt: null, lastUsedAt: null });
  assert.equal((await s.world.app.handle(new Request(second.url))).status, 404);
  assert(stripTags(G.pages.calendar.mainHtml({ phase: 'revoked', busy: false, error: '', status: gone })).includes('Calendar link turned off.'));
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
