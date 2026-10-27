/**
 * Raidsmith guild tracker - design framework Wave 3 CONTRACT tests (Worker <-> pages)
 * Run: node tests/guild/guild-fw3-contract-tests.js
 *
 * guild-fw3-worker-tests.js and guild-fw3-ui-tests.js each work from hand-made data on the other side. This suite joins them, the way guild-wave3-contract-tests.js
 * does: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in) through G.api, and what they
 * draw from the real answers is checked. One check per thing a person can see: My characters for somebody on the roster and for somebody who is not, the guest sign-up
 * and the public page in the guild's zone, and the three person pages with and without the You line.
 */
const assert = require('node:assert/strict');
const { ownPerson } = require('../guild-owner-fixture');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = require('path').join(__dirname, '..', '..');
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000001';
const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: 'Bob B' },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
};
const NOW = Date.parse('2026-10-17T16:00:00Z');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
const sectionIds = (html) => [...html.matchAll(/<(?:section|div) class="(?:gs-osection[^"]*|gs-hd-panel gs-pr-panel)" id="([a-z0-9-]+)"|<div class="gs-osection-bare" id="([a-z0-9-]+)"/g)].map((m) => m[1] || m[2]).filter((id) => id !== 'person-cols');

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
  const env = { DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`, GUILD_CREATOR_ALLOWLIST: PEOPLE.alice.id, BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret', BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback` };
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
  G.jar = jar;
  return G;
}

const MEMBER_SERVER = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];

async function scenario() {
  const world = await makeWorld();
  const aliceJar = await signIn(world, PEOPLE.alice, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const A = loadPages(world, aliceJar);
  const created = await A.api.post('/api/guild', { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false });
  const gid = created.guild.id;
  const teamId = created.teams[0].id;
  const base = `/api/guild/${gid}`;
  const bobJar = await signIn(world, PEOPLE.bob, MEMBER_SERVER);
  const carolJar = await signIn(world, PEOPLE.carol, MEMBER_SERVER);
  const B = loadPages(world, bobJar);
  const C = loadPages(world, carolJar);
  const bobId = (await B.api.get('/auth/me')).user.id;
  const made = await A.api.post(`${base}/roster`, { teamId, name: 'Thornwick', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  const pid = made.person.id;
  ownPerson(world.db.sqlite, pid, bobId); // players.user_id: the Link account route only records a Discord ID since the identity split
  await A.api.post(`${base}/roster/${pid}/characters`, { name: 'Thornalt', class: 'MAGE', mainSpec: 'Fire', offSpec: null, teamId, makeMain: false });
  for (const G of [A, B, C]) G.guildData = await G.api.get(base);
  return { world, A, B, C, gid, teamId, base, pid };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('My characters: a member an officer linked to the roster is told what Battle.net adds; a member on no roster still gets the invitation', async () => {
  const s = await scenario();
  const onRoster = s.B.pages.bnet.charactersHtml({ data: await s.B.api.get('/auth/bnet') });
  const t = stripTags(onRoster);
  assert(t.includes('You are on the roster already') && t.includes('Ember') && t.includes('claim your alts') && !/Connect Battle\.net/.test(t), t);
  assert(!onRoster.includes('gs-btn-molten'));
  const off = s.C.pages.bnet.charactersHtml({ data: await s.C.api.get('/auth/bnet') });
  assert(stripTags(off).includes('Connect Battle.net to see your characters') && off.includes('gs-btn-molten'));
});

check('the guest sign-up page writes the raid\'s start in the guild\'s zone from the real answer, and the public page names that zone', async () => {
  const s = await scenario();
  const raid = await s.A.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn: '2027-01-20', startTime: '20:00', zone: "Gruul's Lair", title: 'Sunday Gruul' });
  const link = await s.A.api.post(`${s.base}/raids/${raid.raid.id}/join-links`, { maxUses: 2 });
  const guest = loadPages(s.world, {});
  const state = await guest.pages.join.load({ name: 'join', token: link.created.token });
  assert.equal(state.status, 'ok', JSON.stringify(state));
  assert.equal(state.data.guild.timeZone, 'America/New_York');
  const out = stripTags(guest.pages.join.joinHtml({ state }));
  assert(out.includes('Sunday Gruul - Gruul\'s Lair - Main team - Wed Jan 20, 8:00 PM ET'), out);
  // The public page: on, and the view the page draws names the zone of its times.
  await s.A.api.put(`${s.base}/public`, { enabled: true, sections: ['roster'] });
  const visitor = loadPages(s.world, {});
  const view = await visitor.pages.view.load({ name: 'public', gid: s.gid });
  assert.equal(view.error, null, JSON.stringify(view.error));
  assert.equal(view.data.guild.timeZone, 'America/New_York');
  const page = visitor.pages.view.viewHtml({ data: view.data, kind: 'public' });
  assert(page.includes('>Read-only<') && stripTags(page).includes('Times are in ET, the guild\'s zone.') && stripTags(page).includes('Thornwick'));
});

check('the person pages from the real answers: an officer sees Thornwick\'s record, the member sees their own with the You line; the loot history knows it is theirs', async () => {
  const s = await scenario();
  const open = async (G) => {
    const record = await G.api.get(`${s.base}/roster/${s.pid}`);
    return G.pages.person.personHtml({ guildData: G.guildData, record, linkable: [], alert: '', attendance: null, trial: null, away: null });
  };
  const officer = await open(s.A);
  assert(officer.includes('gs-object-page') && !officer.includes('gs-youline'));
  assert.deepEqual(sectionIds(officer), ['attendance', 'characters', 'details', 'notes']);
  assert(stripTags(officer).includes('Warrior - Arms') && stripTags(officer).includes('Alt: Thornalt'));
  const own = await open(s.B);
  assert(own.includes('<div class="gs-youline">') && own.includes('<span class="gs-hd-chip is-grey">You</span>') && stripTags(own).includes('Who can see this page'));
  assert(own.indexOf('id="attendance"') < own.indexOf('id="characters"'), 'your own page leads with attendance');
  assert(!own.includes('person-details-form') && !own.includes('id="notes"'), 'a member gets no forms and no officer notes');
  const loot = await s.B.api.get(`${s.base}/loot/person/${s.pid}`);
  const lootPage = s.B.pages.personLoot.personLootHtml({ guildData: s.B.guildData, pid: s.pid, data: loot });
  assert(lootPage.includes('<span class="gs-hd-chip is-grey">You</span>') && stripTags(lootPage).includes('This is your loot.') && stripTags(lootPage).includes('Main: Warrior'));
  const att = await s.B.api.get(`${s.base}/attendance/person/${s.pid}`);
  const attPage = s.B.pages.personAtt.personAttHtml({ guildData: s.B.guildData, pid: s.pid, data: att });
  assert(attPage.includes('<span class="gs-hd-chip is-grey">You</span>') && attPage.includes('gs-pa-figs') && attPage.includes('gs-pa-strip'));
  const others = s.A.pages.personLoot.personLootHtml({ guildData: s.A.guildData, pid: s.pid, data: await s.A.api.get(`${s.base}/loot/person/${s.pid}`) });
  assert(!others.includes('gs-youline'));
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
