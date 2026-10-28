/**
 * Raidsmith guild tracker - the max-level rule and the My characters read (B8b, lane mychars)
 * Run: node tests/guild/guild-b8b-mychars-tests.js
 *
 * worker/bnet-auto-add.js adds the characters at the level cap of the guild's version to the member's profile when Battle.net connects and at every refresh; GET /auth/bnet
 * carries the profile beside the Battle.net list. Same harness as guild-bnet-worker-tests.js (the Worker over the D1 stand-in, Battle.net by tools/fake-battlenet.js) with the
 * fake's characters at their own levels: 70 for Aldric, Brindle, Dunmar, Galdor and Quillfeather, 68 Cassia, 61 Eliora, 12 Fenwick. The page's own tests are in guild-bnet-ui-tests.js.
 */
const assert = require('node:assert/strict');
const { ownPerson, disownPerson } = require('../guild-owner-fixture');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { createFakeBattlenet } = require('../../tools/fake-battlenet');
const { seatOnRoster } = require('../guild-seat');

const ROOT = require('path').join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const ORIGIN = 'https://raidsmith.test';
const SERVER_A = '900000000000000001';
const SERVER_B = '900000000000000002';
const DAY = 24 * 60 * 60 * 1000;

const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  bob: { id: '110000000000000002', username: 'bob', globalName: null },
  carol: { id: '110000000000000003', username: 'carol', globalName: 'Carol C' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
  gina: { id: '110000000000000006', username: 'gina', globalName: 'Gina G' },
  frank: { id: '110000000000000007', username: 'frank', globalName: 'Frank F' },
};
const ACCOUNT = { alice: '500000001', bob: '500000002', carol: '500000003', dave: '500000004', erin: '500000005', gina: '500000006', frank: '500000007' };
const TAG = (name) => `${name[0].toUpperCase()}${name.slice(1)}#${ACCOUNT[name].slice(-4)}`;

// ---------------------------------------------------------------------------
// Harness

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const openWorlds = [];

function makeDiscord() {
  const state = { next: null, calls: [], tokens: new Map() };
  state.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    state.calls.push({ url: String(url) });
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${state.calls.length}`;
      state.tokens.set(token, state.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec(init.headers && init.headers.Authorization || '');
    const session = bearer && state.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  return state;
}

function absorbCookies(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[name];
    else jar[name] = pair.slice(index + 1);
  }
}

async function makeWorld({ allowlist = [], env = {} } = {}) {
  const { createApp } = await load('worker/index.js');
  const { resetBnetTokenCache } = await load('worker/battlenet.js');
  resetBnetTokenCache();
  const db = createD1Fake();
  const discord = makeDiscord();
  const bnet = createFakeBattlenet();
  await new Promise((resolve) => bnet.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bnet.server.address().port}`;
  const clock = { now: 1_800_000_000_000 };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const fullEnv = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    GUILD_CREATOR_ALLOWLIST: allowlist.join(','),
    BNET_CLIENT_ID: 'bnet-id',
    BNET_CLIENT_SECRET: 'bnet-secret',
    BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback`,
    BNET_API_BASE: base,
    ...env,
  };
  const fetchRouter = (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return fetch(url, init);
    return discord.fetch(url, init);
  };
  const logs = [];
  const app = createApp({ db, env: fullEnv, fetch: fetchRouter, now: () => clock.now, randomBytes, log: (message) => logs.push(message) });
  const world = {
    db, discord, bnet, clock, env: fullEnv, logs, app,
    advance(ms) { clock.now += ms; },
    async req(method, urlPath, { jar, body, headers = {}, rawBody } = {}) {
      const init = { method, headers: { ...headers } };
      if (jar && Object.keys(jar).length) init.headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET') {
        if (!('Content-Type' in init.headers)) init.headers['Content-Type'] = 'application/json';
        init.body = rawBody !== undefined ? rawBody : JSON.stringify(body === undefined ? {} : body);
      }
      const response = await app.handle(new Request(`${ORIGIN}${urlPath}`, init));
      if (jar) absorbCookies(jar, response);
      return response;
    },
    async call(jar, method, urlPath, body, extra = {}) {
      const response = await world.req(method, urlPath, { jar, body, ...extra });
      let json = null;
      try { json = await response.clone().json(); } catch { json = null; }
      return { status: response.status, json, headers: response.headers };
    },
    async rows(sql, ...values) { return (await db.prepare(sql).bind(...values).all()).results; },
    async count(table, where = '1 = 1', ...values) {
      return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...values).first()).n;
    },
    asked(kind, pathPrefix) { return bnet.state.requests.filter((r) => (!kind || r.token === kind) && (!pathPrefix || r.path.startsWith(pathPrefix))); },
  };
  openWorlds.push(world);
  // Identity-change protection (lane B6b part 2a): this suite links and unlinks as a staff account without being about fresh-auth, so such requests get their grant first.
  return require('../guild-auto-fresh').autoFresh(world);
}

async function signIn(world, person, servers = [], jar = {}) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await world.req('GET', '/auth/login', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  return jar;
}

const manageable = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: true, permissions: '8' });
const plain = (id) => ({ id, name: `Server ${id.slice(-2)}`, icon: null, owner: false, permissions: '0' });
const GUILD_BODY = { serverId: SERVER_A, gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };

// Alice (Guild Master) creates a TBC US Dreamscythe guild with two teams; Bob is Officer, Carol Team Lead of Alpha, Dave Team Lead of Bravo;
// Erin and Gina are Members. Frank runs a second guild on SERVER_B.
async function scenario({ guildBody = {} } = {}) {
  const w = await makeWorld({ allowlist: [PEOPLE.alice.id, PEOPLE.frank.id] });
  const alice = await signIn(w, PEOPLE.alice, [manageable(SERVER_A)]);
  const created = await w.call(alice, 'POST', '/api/guild', { ...GUILD_BODY, ...guildBody });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = { w, guildId: created.json.guild.id, teams: created.json.teams.map((team) => team.id), jars: { alice }, ids: {} };
  [s.A, s.B] = s.teams;
  for (const name of ['bob', 'carol', 'dave', 'erin', 'gina']) s.jars[name] = await signIn(w, PEOPLE[name], [plain(SERVER_A)]);
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.guildPath = `/api/guild/${s.guildId}`;
  s.call = (name, method, route, body, extra) => w.call(s.jars[name], method, `${s.guildPath}${route}`, body, extra);
  const roles = (name, body) => w.call(alice, 'PUT', `${s.guildPath}/people/${s.ids[name]}/roles`, body);
  assert.equal((await roles('bob', { officer: true, teamLeadTeamIds: [] })).status, 200);
  assert.equal((await roles('carol', { officer: false, teamLeadTeamIds: [s.A] })).status, 200);
  assert.equal((await roles('dave', { officer: false, teamLeadTeamIds: [s.B] })).status, 200);
  return s;
}

// A member links Battle.net through the real routes: the login redirect, then the callback the browser would be sent back to.
async function link(s, name, { account } = {}) {
  s.w.bnet.state.account = account || { id: ACCOUNT[name], battletag: TAG(name) };
  const login = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars[name] });
  assert.equal(login.status, 302, 'login redirects');
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars[name] });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('Location'), '/#/characters', `linked: ${callback.headers.get('Location')}`);
  return state;
}

const mainBody = (teamId, name, extra = {}) => ({ teamId, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', ...extra });
async function addPerson(s, who, teamId, name, extra = {}) {
  const r = await s.call(who, 'POST', '/roster', mainBody(teamId, name, extra));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

// The roster used by the claim tests: Aldric (Alpha, owned by Erin), Brindle (Alpha, nobody linked), Dunmar (Bravo, owned by Dave). The owner is players.user_id (the
// fixture writes it, as a Battle.net proof or an approved claim does); linkUserId alone would only record the Discord ID, which is bookkeeping since the identity split.
async function seedRoster(s) {
  const aldric = await addPerson(s, 'bob', s.A, 'Aldric', { linkUserId: s.ids.erin });
  const brindle = await addPerson(s, 'bob', s.A, 'Brindle');
  const dunmar = await addPerson(s, 'bob', s.B, 'Dunmar', { class: 'HUNTER', mainSpec: 'Marksmanship', linkUserId: s.ids.dave });
  ownPerson(s.w.db.sqlite, aldric.person.id, s.ids.erin);
  ownPerson(s.w.db.sqlite, dunmar.person.id, s.ids.dave);
  return { aldric: aldric.person.id, brindle: brindle.person.id, dunmar: dunmar.person.id };
}

async function assertOneMain(w) {
  const bad = await w.rows(
    `SELECT p.id, COALESCE(SUM(c.is_main), 0) AS mains FROM players p LEFT JOIN characters c ON c.player_id = p.id GROUP BY p.id HAVING mains != 1`,
  );
  assert.deepEqual(bad, [], 'every person has exactly one Main');
}

const claimBody = (...names) => ({ characters: names.map((name) => ({ name, realmSlug: name === 'Cassia' || name === 'Fenwick' ? 'nightslayer' : 'dreamscythe' })) });
const approveBody = (kind, extra = {}) => ({ expectedKind: kind, ...extra });

// A claim waiting for the officers, made the way the Worker made one before claims applied at once (characters/teams decision D2): the rows alone. The
// officers' side (list, approve, reject, purge, Delete my data) is tested on these; the claims a member makes now are tests/guild/guild-b3-claims-tests.js.
let pendSeq = 0;
async function pend(s, who, ...names) {
  const view = (await s.w.call(s.jars[who], 'GET', '/auth/bnet')).json.guilds[0];
  const claims = names.map((name) => {
    const found = view.characters.find((c) => c.name === name);
    assert(found, `${name} is on the list of ${who}`);
    const id = `cl_${String(++pendSeq).padStart(22, 'p')}`;
    s.w.db.sqlite.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
      VALUES ('${id}', '${s.guildId}', '${s.ids[who]}', '${found.name}', '${found.name.toLowerCase()}', '${found.realm}', '${found.realmSlug.replace(/-/g, '')}', '${found.class}', ${found.level}, 'pending', ${s.w.clock.now});
      INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, created_at) VALUES ('al_${id.slice(3)}', '${s.guildId}', '${s.ids[who]}', 'claim.create', 'claim', '${id}', ${s.w.clock.now});`);
    return { id, name: found.name, realm: found.realm, class: found.class, level: found.level, status: 'pending' };
  });
  return { status: 201, json: { claims } };
}
const plainJson = (value) => JSON.parse(JSON.stringify(value));


// ---------------------------------------------------------------------------
// The level cap per game version

check('realms: every game version has a level cap (70 TBC Anniversary, 60 Classic Era and WoW Forever), and an unknown version has none', async () => {
  const { GAME_VERSIONS, maxLevelOf } = await load('worker/realms.js');
  assert.deepEqual(GAME_VERSIONS.map((v) => [v.key, v.maxLevel]), [['tbc', 70], ['classic', 60], ['forever', 60]]);
  assert.deepEqual([maxLevelOf('tbc'), maxLevelOf('classic'), maxLevelOf('forever'), maxLevelOf('toString'), maxLevelOf(undefined)], [70, 60, 60, null, null]);
});

check('maxLevelPicks: only characters at the cap of the guild\'s version, on its realm, with a name a roster can hold, one per name, best first', async () => {
  const { maxLevelPicks, hasMaxLevelCharacter } = await load('worker/bnet-auto-add.js');
  const era = { game_version: 'classic', region: 'US', realm: 'Atiesh', realm_kind: 'realm' };
  const row = (name, level, extra = {}) => ({ name, level, realm: 'Atiesh', realmSlug: 'atiesh', class: 'MAGE', ...extra });
  const entry = { characters: [row('Sixty', 60), row('Fiftynine', 59), row('Zed', 60), row('Abe', 60), row('Abe', 60), row('Faraway', 60, { realm: 'Faraway Isle', realmSlug: 'faraway-isle' }), row('Nolevel', null), row('Bad1name', 60), row('Over', 61)] };
  assert.deepEqual(maxLevelPicks(era, entry).map((p) => [p.name, p.level]), [['Over', 61], ['Abe', 60], ['Sixty', 60], ['Zed', 60]], 'the cap and above; Faraway is on a realm no list has; Bad1name has a digit');
  const tbc = { game_version: 'tbc', region: 'US', realm: 'Dreamscythe', realm_kind: 'realm' };
  assert.deepEqual(maxLevelPicks(tbc, { characters: [{ name: 'Sixty', level: 60, realm: 'Dreamscythe', class: 'MAGE' }] }), [], '60 is not the cap of TBC');
  const many = { characters: Array.from({ length: 14 }, (_, i) => ({ name: `Alt${String.fromCharCode(97 + i)}`, level: 70, realm: 'Dreamscythe', class: 'MAGE' })) };
  assert.equal(maxLevelPicks(tbc, many).length, 14, 'all of them: the ones already on the profile drop out in the plan, so the next refresh reaches the rest');
  assert.deepEqual(maxLevelPicks(tbc, { error: 'unavailable' }), []);
  assert.deepEqual(maxLevelPicks({ ...tbc, game_version: 'nope' }, many), []);
  assert.equal(hasMaxLevelCharacter({ 'profile-classicann-us': { characters: [{ level: 70 }] } }), true);
  assert.equal(hasMaxLevelCharacter({ 'profile-classicann-us': { characters: [{ level: 69 }] }, 'profile-classic1x-eu': { characters: [{ level: 60 }] } }), true, 'the Classic Era cap is 60');
  assert.equal(hasMaxLevelCharacter({ 'profile-classicann-us': { characters: [{ level: 60 }] }, 'profile-classicann-eu': { error: 'unavailable' } }), false);
  assert.equal(hasMaxLevelCharacter(null), false);
});

// ---------------------------------------------------------------------------
// GET /auth/bnet: the profile beside the Battle.net list

const guildViewOf = async (s, who) => (await s.w.call(s.jars[who], 'GET', '/auth/bnet')).json.guilds[0];
const profileNames = (view) => view.profile.map((c) => c.name);

check('connect: the characters at the cap join the profile at once (same writes and audit as Add), the lower ones stay offered; a new person gets the first as Main on no team', async () => {
  const s = await scenario();
  await link(s, 'erin');
  const view = await guildViewOf(s, 'erin');
  assert.equal(view.maxLevel, 70);
  // The fake account lists Aldric, Brindle, Dunmar, Galdor and Quillfeather at 70, Cassia 68, Eliora 61, Fenwick 12 and Stranger on another realm.
  assert.deepEqual(profileNames(view), ['Aldric', 'Brindle', 'Dunmar', 'Galdor', 'Quillfeather'], 'the Main first, then by name');
  assert.deepEqual(view.profile.map((c) => c.isMain), [true, false, false, false, false]);
  assert.deepEqual(view.profile.map((c) => c.level), [70, 70, 70, 70, 70], 'the level is the one Battle.net lists');
  assert.deepEqual(view.profile.map((c) => c.team), [null, null, null, null, null], 'on no team');
  assert.deepEqual(view.profile.map((c) => c.request), [null, null, null, null, null]);
  assert.deepEqual(Object.keys(view.profile[0]).sort(), ['class', 'id', 'isMain', 'level', 'mainSpec', 'name', 'request', 'team']);
  assert.equal(view.profile[0].class, 'WARRIOR');
  const state = Object.fromEntries(view.characters.map((c) => [c.name, [c.state, c.claimable]]));
  assert.deepEqual([state.Aldric, state.Quillfeather], [['yours', false], ['yours', false]]);
  assert.deepEqual([state.Cassia, state.Eliora, state.Fenwick], [['new', true], ['new', true], ['new', true]], 'below the cap: left for the member to pick');
  assert.equal(await s.w.count('players', 'guild_id = ? AND user_id = ?', s.guildId, s.ids.erin), 1);
  assert.equal(await s.w.count('characters', 'guild_id = ? AND player_id IN (SELECT id FROM players WHERE user_id = ?)', s.guildId, s.ids.erin), 5);
  const person = (await s.w.rows('SELECT status FROM players WHERE user_id = ?', s.ids.erin))[0];
  assert.equal(person.status, 'raider', 'players.status is the inert placeholder; the person\'s standing is its Main\'s (worker/person-legacy.js)');
  const trial = await s.w.rows(`SELECT core_rank, team_id, owner_proof FROM characters WHERE name = 'Aldric' AND guild_id = ?`, s.guildId);
  assert.deepEqual([trial[0].core_rank, trial[0].team_id], ['trial', null], 'a new person from a claim is a Trial');
  const audit = await s.w.rows(`SELECT action, actor_user_id FROM audit_log WHERE guild_id = ? AND action = 'character.claim'`, s.guildId);
  assert.equal(audit.length, 5, 'one audit row per character, as Add writes');
  assert(audit.every((row) => row.actor_user_id === s.ids.erin), 'by the member');
  assert(!JSON.stringify(await s.w.rows(`SELECT after FROM audit_log WHERE action = 'character.claim'`)).includes('Aldric'), 'no name in the audit');
  assert.equal((await s.w.call(s.jars.erin, 'POST', `${s.guildPath}/claims`, claimBody('Aldric'))).json.error, 'already_yours', 'the manual Add agrees');
});

check('refresh: Connect again adds only what reached the cap since; nothing is added twice and nothing is removed', async () => {
  const s = await scenario();
  await link(s, 'erin');
  const first = await s.w.count('audit_log', `action = 'character.claim'`);
  await link(s, 'erin');
  assert.equal(await s.w.count('audit_log', `action = 'character.claim'`), first, 'the same list adds nothing');
  assert.equal(await s.w.count('character_claims'), 0);
  // Cassia levelled to 70 and Hestia is new; Aldric left Battle.net's list.
  s.w.bnet.state.data.tbc = s.w.bnet.state.data.tbc.filter((row) => row[0] !== 'Aldric').map((row) => (row[0] === 'Cassia' ? [row[0], row[1], 70, ...row.slice(3)] : row));
  s.w.bnet.state.data.tbc.push(['Hestia', 5, 70, 0]);
  await link(s, 'erin');
  const view = await guildViewOf(s, 'erin');
  assert.deepEqual(profileNames(view), ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Galdor', 'Hestia', 'Quillfeather'], 'Aldric stays (a refresh never removes), Cassia and Hestia joined');
  assert.equal(await s.w.count('audit_log', `action = 'character.claim'`), first + 2);
  assert.deepEqual(view.characters.filter((c) => c.claimable).map((c) => c.name).sort(), ['Eliora', 'Fenwick']);
});

check('conflicts: a character on a roster person nobody linked waits for an officer (Waiting for an officer); one on someone else\'s linked person is left alone; neither fails the connect', async () => {
  const s = await scenario();
  await seedRoster(s); // Aldric: Erin\'s own person; Brindle: nobody linked; Dunmar: Dave\'s
  await link(s, 'erin');
  const view = await guildViewOf(s, 'erin');
  assert.deepEqual(profileNames(view), ['Aldric', 'Galdor', 'Quillfeather'], 'Aldric was hers already; Galdor and Quillfeather are on no roster');
  const claims = await s.w.rows('SELECT name, status, level FROM character_claims WHERE user_id = ?', s.ids.erin);
  assert.deepEqual(plainJson(claims), [{ name: 'Brindle', status: 'pending', level: 70 }], 'one claim, for the character on the unlinked person; Dunmar (Dave\'s) made none');
  const brindle = view.characters.find((c) => c.name === 'Brindle');
  assert.deepEqual([brindle.state, brindle.claim.status, brindle.claimable], ['on_roster', 'pending', false]);
  assert.equal(await s.w.count('audit_log', `action = 'claim.create'`), 1);
  // A refresh does not file it again, and the Worker answers the page's Withdraw as before.
  await link(s, 'erin');
  assert.equal(await s.w.count('character_claims', 'user_id = ?', s.ids.erin), 1);
  const second = await guildViewOf(s, 'erin');
  assert.equal((await s.w.call(s.jars.erin, 'DELETE', `${s.guildPath}/claims/${second.characters.find((c) => c.name === 'Brindle').claim.id}`, {})).status, 200, 'Withdraw');
  // A withdrawn claim is deleted and nobody turned it down: the next refresh asks the officers again.
  await link(s, 'erin');
  assert.equal(await s.w.count('character_claims', "user_id = ? AND status = 'pending'", s.ids.erin), 1);
});

check('conflicts: a claim an officer turned down is not filed again at every refresh, but Add still asks', async () => {
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'erin');
  const claimId = (await s.w.rows('SELECT id FROM character_claims WHERE user_id = ?', s.ids.erin))[0].id;
  assert.equal((await s.call('bob', 'POST', `/claims/${claimId}/reject`, {})).status, 200);
  await link(s, 'erin');
  assert.equal(await s.w.count('character_claims', "user_id = ? AND status = 'pending'", s.ids.erin), 0, 'turned down: not asked again by the refresh');
  const view = await guildViewOf(s, 'erin');
  const brindle = view.characters.find((c) => c.name === 'Brindle');
  assert.deepEqual([brindle.claimable, brindle.claim.status], [true, 'rejected'], 'still offered under Add');
  assert.equal((await s.call('erin', 'POST', '/claims', claimBody('Brindle'))).json.claims[0].status, 'pending', 'and Add asks again');
});

check('conflicts: a member with no person is linked to the unlinked roster person that holds a character at the cap (D2b); taken characters are left alone and file nothing', async () => {
  const s = await scenario();
  await seedRoster(s); // Aldric: Erin's, Brindle: nobody's, Dunmar: Dave's
  await link(s, 'gina');
  const gina = await guildViewOf(s, 'gina');
  assert.deepEqual(profileNames(gina), ['Brindle', 'Galdor', 'Quillfeather'], 'the linked person\'s own character, then the ones on no roster; Aldric and Dunmar belong to others');
  assert.equal(await s.w.count('character_claims', 'user_id = ?', s.ids.gina), 0);
  assert.equal(await s.w.count('players', 'guild_id = ? AND user_id = ?', s.guildId, s.ids.gina), 1);
});

check('connect: the profile cards carry the team, a team request waiting for the character, and leave out Former characters and other members\' characters', async () => {
  const s = await scenario();
  await link(s, 'erin');
  const view = await guildViewOf(s, 'erin');
  const id = (name) => view.profile.find((c) => c.name === name).id;
  // Erin\'s Main joins Alpha (an officer places it), Brindle asks for Bravo, Dunmar left the guild.
  assert.equal((await s.call('bob', 'PUT', `/roster/${(await s.w.rows('SELECT player_id FROM characters WHERE id = ?', id('Aldric')))[0].player_id}/characters/${id('Aldric')}/team`, { teamId: s.A })).status, 200);
  const asked = await s.call('erin', 'POST', '/team-requests', { characterId: id('Brindle'), teamId: s.B });
  assert.equal(asked.status, 201, JSON.stringify(asked.json));
  s.w.db.sqlite.prepare(`UPDATE characters SET left_on = '2026-01-01', left_reason = 'left' WHERE id = ?`).run(id('Dunmar'));
  const after = await guildViewOf(s, 'erin');
  assert.deepEqual(profileNames(after), ['Aldric', 'Brindle', 'Galdor', 'Quillfeather'], 'no Former character');
  const aldric = after.profile.find((c) => c.name === 'Aldric');
  assert.deepEqual([aldric.team.id, aldric.team.name, aldric.request], [s.A, 'Alpha', null]);
  const brindle = after.profile.find((c) => c.name === 'Brindle');
  assert.deepEqual([brindle.team, brindle.request.team.id, brindle.request.team.name], [null, s.B, 'Bravo']);
  assert.equal(typeof brindle.request.createdAt, 'number');
  assert.equal(typeof brindle.request.id, 'string');
  const gina = await guildViewOf(s, 'gina');
  assert.deepEqual(gina.profile, [], 'another member sees none of Erin\'s characters');
  assert.equal(gina.maxLevel, 70);
});

check('GET /auth/bnet: the profile is there without Battle.net too (cards of a hand-added character, no level), and a version Battle.net has no data for still lists it', async () => {
  const s = await scenario();
  const typed = await s.call('erin', 'POST', '/me/characters', { name: 'Typedone', class: 'MAGE' });
  assert.equal(typed.status, 201, JSON.stringify(typed.json));
  const view = await guildViewOf(s, 'erin');
  assert.equal(view.status, 'not_linked');
  assert.deepEqual(plainJson(view.profile.map((c) => [c.name, c.level, c.isMain, c.mainSpec])), [['Typedone', null, true, null]]);
  const forever = await scenario({ guildBody: { gameVersion: 'forever', realm: 'Normal', realmKind: 'ruleset', region: 'US' } });
  const typedForever = await forever.call('erin', 'POST', '/me/characters', { name: 'Foreverone', class: 'MAGE' });
  assert.equal(typedForever.status, 201, JSON.stringify(typedForever.json));
  const fv = await guildViewOf(forever, 'erin');
  assert.deepEqual([fv.status, fv.maxLevel, profileNames(fv)], ['unsupported', 60, ['Foreverone']]);
});

// ---------------------------------------------------------------------------
// The callback's budget, the caps and the in-game guilds

// link(), reporting the D1 statements the CALLBACK ran (the login redirect is another request).
async function linkMeasured(s, name) {
  s.w.bnet.state.account = { id: ACCOUNT[name], battletag: TAG(name) };
  const login = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars[name] });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const mark = s.w.db.statementLog.length;
  const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars[name] });
  assert.equal(callback.headers.get('Location'), '/#/characters');
  return s.w.db.statementLog.length - mark;
}

check('budget: a member with 14 characters at the cap gets what fits the callback\'s 45 D1 statements, the rest at the next refreshes, and the callback never fails', async () => {
  const s = await scenario();
  s.w.bnet.state.data.tbc = Array.from({ length: 14 }, (_, i) => [`Alt${String.fromCharCode(97 + i)}`, 8, 70, 0]);
  const { CALLBACK_STATEMENT_BUDGET } = await load('worker/bnet-match.js');
  const sizes = [];
  for (let i = 0; i < 4; i++) {
    s.w.logs.length = 0;
    const used = await linkMeasured(s, 'erin');
    assert(used <= CALLBACK_STATEMENT_BUDGET, `callback ${i + 1}: ${used} statements`);
    sizes.push((await guildViewOf(s, 'erin')).profile.length);
    if (sizes[i] === 14) break;
  }
  assert(sizes[0] >= 1 && sizes[0] < 14, `the first callback adds some, not all: ${sizes}`);
  assert.equal(sizes[sizes.length - 1], 14, `every character is on the profile after a few refreshes: ${sizes}`);
  assert(sizes.every((n, i) => i === 0 || n >= sizes[i - 1]), 'a refresh never takes one away');
  assert(!s.w.logs.some((line) => /failed/.test(line)), 'no failed batch');
});

check('cap: a person at 20 characters refuses the batch quietly: the connect stands, the log says deferred (cap), nothing is half-added', async () => {
  const s = await scenario();
  await link(s, 'erin');
  const personId = (await s.w.rows('SELECT id FROM players WHERE user_id = ?', s.ids.erin))[0].id;
  for (let i = 0; i < 15; i++) {
    s.w.db.sqlite.prepare(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank)
      VALUES (?, ?, ?, NULL, ?, ?, 'Dreamscythe', 'dreamscythe', 'MAGE', 0, 1, 1, 'raider')`).run(`c_${String(i).padStart(22, 'f')}`, s.guildId, personId, `Fill${String.fromCharCode(97 + i)}`, `fill${String.fromCharCode(97 + i)}`);
  }
  assert.equal(await s.w.count('characters', 'player_id = ?', personId), 20);
  s.w.bnet.state.data.tbc = [...s.w.bnet.state.data.tbc, ['Newcomer', 8, 70, 0]];
  s.w.logs.length = 0;
  await link(s, 'erin');
  assert.equal(await s.w.count('characters', 'player_id = ?', personId), 20, 'still 20');
  assert(s.w.logs.includes('bnet auto-add deferred: cap'), JSON.stringify(s.w.logs));
  assert(!s.w.logs.some((line) => /failed/.test(line)));
  const view = await guildViewOf(s, 'erin');
  assert.equal(view.characters.find((c) => c.name === 'Newcomer').claimable, true, 'and Add still offers it (the manual Add shows the cap)');
});

check('in-game guild: the rule adds the characters at the cap that are not on the guild roster too (Add always could); roster characters come from the sign-in match, not from here', async () => {
  const s = await scenario();
  // A member of an in-game guild has a person with a character on the roster (the sign-in match makes it; here the fixture does), so the connect only adds what is at the cap.
  await seatOnRoster({ call: (who, method, tail, body) => s.call(who, method, tail, body), sqlite: s.w.db.sqlite, guildId: s.guildId, teamId: s.A, userId: s.ids.erin, who: 'alice' }, { name: 'Seaterin', id: 71002 });
  s.w.db.sqlite.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.guildId}'`);
  const before = await s.w.count('characters', 'guild_id = ?', s.guildId);
  await link(s, 'erin');
  const view = await guildViewOf(s, 'erin');
  assert.equal(view.battlenetOnly, true);
  assert(profileNames(view).includes('Aldric') && profileNames(view).includes('Seaterin'), JSON.stringify(profileNames(view)));
  assert.equal((await s.w.count('characters', 'guild_id = ?', s.guildId)) - before, 5, 'Aldric, Brindle, Dunmar, Galdor, Quillfeather');
  assert(!profileNames(view).includes('Cassia'), 'below the cap: picked by hand');
});

// ---------------------------------------------------------------------------
// The page, drawn from the Worker's real answer

check('contract: My characters draws its cards, waiting row and quiet line from the real GET /auth/bnet', async () => {
  const vm = require('node:vm');
  const { GUILD_SCRIPTS } = require('../guild-scripts');
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const s = await scenario();
  await seedRoster(s);
  await link(s, 'erin');
  const res = await s.w.call(s.jars.erin, 'GET', '/auth/bnet');
  const out = sandbox.Guild.pages.bnet.charactersHtml({ data: res.json });
  const text = out.replace(/<[^>]*>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
  assert((out.match(/<a class="gs-hd-panel gs-chars-card/g) || []).length, 'cards');
  assert.equal((out.match(/<a class="gs-hd-panel gs-chars-card/g) || []).length, 3, 'Aldric, Galdor, Quillfeather');
  assert(/gs-chars-card-name[^>]*>Aldric</.test(out) && out.includes('>Main<') && out.includes('>No team<'));
  assert(text.includes('Waiting for an officer') && text.includes('Brindle') && text.includes('Needs an officer') && text.includes('On a different roster entry than yours'), text);
  assert(text.includes('3 characters below 70 on your Battle.net · Add'), text);
  assert(text.includes('From Battle.net as Erin#0005, loaded'), text);
  assert.equal((out.match(/\/auth\/bnet\/login/g) || []).length, 1, 'one Battle.net link');
  for (const card of out.split('<a class="gs-hd-panel gs-chars-card').slice(1)) {
    const href = /href="([^"]*)"/.exec(card)[1];
    assert(href.startsWith('#/'), href);
  }
});

// ---------------------------------------------------------------------------

async function closeWorlds() {
  while (openWorlds.length) {
    const world = openWorlds.pop();
    const closed = new Promise((resolve) => world.bnet.server.close(resolve));
    world.bnet.server.closeAllConnections();
    await closed;
  }
}

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
      console.log(String(error && error.stack || error).split('\n').slice(0, 12).map((line) => `      ${line}`).join('\n'));
    } finally {
      await closeWorlds();
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
