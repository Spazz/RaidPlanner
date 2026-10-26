/**
 * Raidsmith guild tracker - lane B6a part 2a of the user-hierarchy build: the Battle.net sign-in match
 * (worker/bnet-match.js, worker/routes/bnet.js, the lean join of worker/person-join.js)
 * Run: node tests/guild/guild-b6a-match-tests.js [name filter]
 *
 *   - the snapshot keeps the identity key of every character; the in-game namespaces are fetched first;
 *   - an account with a character on an 'ingame' guild's roster becomes a member by signing in (new account, existing account, a link, a re-link); a LEGACY guild and a
 *     'manual' guild never get a person, a character or a players.user_id from the match, only proof and keys on characters of the account's own linked person;
 *   - the unowned-person link (the trigger clears the proofs, the match restamps them), the auto join (one per callback); Battle.net beats a link and the name
 *     collision (part 2b) are in guild-b6a-rehome-tests.js;
 *   - non-roster characters get no rows, a roster character of any level does; the cap, a blocked account, a class or realm the guild cannot take;
 *   - the proof: the monotonic guard in either order of two accounts, the supersede audit row, clearing on disconnect, re-verify through a link-mode callback;
 *   - the statement budget (45 per callback, batch members counted one by one) for three shapes of callback and the query plans on a 1,200-member roster;
 *   - concurrent sign-ins of one account: no duplicate person or character, no 500.
 * Drives worker/index.js over the node:sqlite D1 stand-in, Discord faked by an injected fetch, Battle.net by tools/fake-battlenet.js on a local port. The fake serves
 * the account's characters with the ids 7000 + position in ALL below (realm 4001 Dreamscythe / 4002 Nightslayer); the guilds' roster rows are written straight into
 * guild_roster with the same keys, so a character is "on the roster" exactly when the fixture says so.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { createFakeBattlenet } = require('../../tools/fake-battlenet');

const ROOT = path.join(__dirname, '..', '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const ORIGIN = 'https://raidsmith.test';
const NS = 'profile-classicann-us';
const T0 = 1_800_000_000_000;
const BNET = {
  ann: { id: '710000001', battletag: 'Ann#1001' },
  bea: { id: '710000002', battletag: 'Bea#1002' },
  cat: { id: '710000003', battletag: 'Cat#1003' },
};
const DISCORD = {
  eve: { id: '120000000000000005', username: 'eve', globalName: 'Eve E' },
  fay: { id: '120000000000000006', username: 'fay', globalName: 'Fay F' },
};
// The fake's TBC list (tools/fake-battlenet.js): [name, class id, level, realm index]; ids 7000 + position; realm ids 4001 / 4002. Extra01-14 are more mages.
const ALL = [
  ['Aldric', 1, 70, 0], ['Brindle', 8, 70, 0], ['Cassia', 5, 68, 1], ['Dunmar', 3, 70, 0], ['Eliora', 2, 61, 0], ['Fenwick', 4, 12, 1],
  ['Galdor', 9, 70, 0], ['Quillfeather', 3, 70, 0],
  ...Array.from({ length: 14 }, (_, i) => [`Extra${String(i + 1).padStart(2, '0')}`, 8, 70, 0]),
];
const REALM_ID = [4001, 4002];
const REALM_NAME = ['Dreamscythe', 'Nightslayer'];
const CLASS_OF = { 1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 11: 'DRUID' };
const rowOfName = (name) => ALL.find((row) => row[0] === name);
const idOf = (name) => 7000 + ALL.indexOf(rowOfName(name));
const extras = (n) => ALL.slice(8, 8 + n).map((row) => row[0]);

const pad = (n) => String(n).padStart(22, '0');
const GID = (n) => `g_${pad(n)}`;
const PID = (n) => `p_${pad(n)}`;
const CID = (n) => `c_${pad(n)}`;
const UID = (n) => `u_${pad(n)}`;
const ALWAYS = { sql: '1 = 1', params: [] };

// ---------------------------------------------------------------------------
// Harness

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const openWorlds = [];
const measured = {};

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

async function makeWorld() {
  const { createApp } = await load('worker/index.js');
  const { resetBnetTokenCache } = await load('worker/battlenet.js');
  resetBnetTokenCache();
  const db = createD1Fake();
  const discord = makeDiscord();
  const bnet = createFakeBattlenet();
  await new Promise((resolve) => bnet.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${bnet.server.address().port}`;
  const clock = { now: T0 };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    BNET_CLIENT_ID: 'bnet-id',
    BNET_CLIENT_SECRET: 'bnet-secret',
    BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback`,
    BNET_API_BASE: base,
  };
  const fetchRouter = (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return fetch(url, init);
    return discord.fetch(url, init);
  };
  const logs = [];
  const app = createApp({ db, env, fetch: fetchRouter, now: () => clock.now, randomBytes, log: (message) => logs.push(message) });
  const sqlite = db.sqlite;
  const run = (sql, ...values) => sqlite.prepare(sql).run(...values);
  const world = {
    db, discord, bnet, clock, env, logs, app, sqlite, run, randomBytes,
    advance(ms) { clock.now += ms; },
    async req(method, urlPath, { jar, body } = {}) {
      const init = { method, headers: {} };
      if (jar && Object.keys(jar).length) init.headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (method !== 'GET') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body === undefined ? {} : body);
      }
      const response = await app.handle(new Request(`${ORIGIN}${urlPath}`, init));
      if (jar) absorbCookies(jar, response);
      return response;
    },
    async call(jar, method, urlPath, body) {
      const response = await world.req(method, urlPath, { jar, body });
      const text = await response.clone().text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, text };
    },
    rows: (sql, ...values) => sqlite.prepare(sql).all(...values).map((row) => ({ ...row })),
    one: (sql, ...values) => { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
    count: (table, where = '1 = 1', ...values) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...values).n,
    // The characters the fake serves for the next Battle.net callback (names of ALL). Every other position of ALL is a filler of a class the Worker drops, so a
    // character keeps the same id (7000 + its position in ALL) whoever is served.
    serve(names) { bnet.state.data.tbc = ALL.map((row) => (names.includes(row[0]) ? row.slice() : ['Filler', 6, 70, row[3]])); },
    mark: () => db.statementLog.length,
    since: (mark) => db.statementLog.slice(mark),
    ctx: () => ({ db, randomBytes, now: () => clock.now, log: (message) => logs.push(message) }),
  };
  // ---- raw fixtures (straight into the database)
  const raw = {
    guild(id, { source = 'ingame', version = 'tbc', region = 'US', realm = 'Dreamscythe', zone = 'America/New_York' } = {}) {
      run(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source)
           VALUES (?, ?, ?, 'realm', ?, ?, ?, ?, 1, ?)`, id, `Guild ${id.slice(-3)}`, realm, region, `none:${id}`, zone, version, source);
    },
    user(id, { discordId = null } = {}) {
      run('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)', id, id, discordId, id);
    },
    person(id, guildId, { userId = null, discordUserId = null, created = 1, joined = '2026-01-01' } = {}) {
      run("INSERT INTO players (id, guild_id, status, user_id, discord_user_id, joined_on, created_at, updated_at) VALUES (?, ?, 'raider', ?, ?, ?, ?, ?)",
        id, guildId, userId, discordUserId, joined, created, created);
    },
    // A character of the person: a name of ALL carries its key unless key === false; any other name is a hand-typed, unkeyed one.
    // keyName: carry the key of ANOTHER name of ALL (a character that was renamed in game).
    character(id, guildId, personId, name, { key = true, keyName = null, isMain = 0, coreRank = 'raider', proof = 'officer', proofUser = null, proofBnet = null, proofAt = null, teamId = null, leftOn = null } = {}) {
      const row = rowOfName(keyName || name);
      const realm = row ? REALM_NAME[row[3]] : 'Dreamscythe';
      run(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on,
                                    owner_proof, proof_user_id, proof_bnet_account_id, proof_at, namespace, blizzard_realm_id, blizzard_char_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, guildId, personId, teamId, name, name.toLowerCase(), realm, realm.toLowerCase(), row ? CLASS_OF[row[1]] : 'MAGE', isMain, coreRank, leftOn, proof, proofUser, proofBnet, proofAt,
      key && row ? NS : null, key && row ? REALM_ID[row[3]] : null, key && row ? idOf(keyName || name) : null);
    },
    // A roster row for a name of ALL, rank 0-9.
    roster(guildId, name, rank, { cls = null, level = null } = {}) {
      const row = rowOfName(name);
      run(`INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, guildId, NS, REALM_ID[row[3]], idOf(name), name, name.toLowerCase(), REALM_NAME[row[3]].toLowerCase(), cls || CLASS_OF[row[1]], level || row[2], rank);
    },
    // Every rank 0-9 maps to Raider except 8 (Trial) and 9 (Social).
    rankMap(guildId) {
      for (let rank = 0; rank < 10; rank++) {
        run("INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank) VALUES (?, 'ingame', ?, ?, ?)", guildId, String(rank), `Rank ${rank}`,
          rank === 9 ? 'social' : rank === 8 ? 'trial' : 'raider');
      }
    },
    away(id, guildId, personId) {
      run("INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_at, updated_at) VALUES (?, ?, ?, 'away', '2026-02-01', '2026-02-02', 1, 1)", id, guildId, personId);
    },
  };
  world.raw = raw;
  // An in-game guild with its rank map and a roster of [name, rank] rows.
  world.ingame = (n, rosterRows = [], opts = {}) => {
    raw.guild(GID(n), { source: 'ingame', ...opts });
    raw.rankMap(GID(n));
    for (const [name, rank, extra] of rosterRows) raw.roster(GID(n), name, rank, extra);
    return GID(n);
  };
  openWorlds.push(world);
  return world;
}

async function closeWorlds() {
  while (openWorlds.length) {
    const world = openWorlds.pop();
    const closed = new Promise((resolve) => world.bnet.server.close(resolve));
    world.bnet.server.closeAllConnections();
    await closed;
  }
}

const stateOf = (response) => new URL(response.headers.get('Location')).searchParams.get('state');
const locationOf = (response) => response.headers.get('Location');

// A Battle.net sign-in for `account`; the fake serves what world.serve() set. -> { jar, callback, statements: the D1 statements of the callback alone }
async function bnetSignIn(world, account, jar = {}) {
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const mark = world.mark();
  const callback = await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  assert.equal(locationOf(callback), '/#/', 'the sign-in worked');
  return { jar, callback, statements: world.since(mark).length, mark };
}

// A link-mode callback (the jar's account links, or re-verifies, `account`).
async function bnetLink(world, jar, account) {
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login', { jar });
  const mark = world.mark();
  const callback = await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  return { callback, statements: world.since(mark).length, mark };
}

async function discordSignIn(world, person, jar = {}) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers: [] };
  const login = await world.req('GET', '/auth/login', { jar });
  const callback = await world.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  assert.equal(locationOf(callback), '/#/', 'the Discord sign-in worked');
  return jar;
}

// The account id behind a Battle.net account.
const userOf = (world, account) => world.one('SELECT user_id FROM bnet_links WHERE bnet_account_id = ?', account.id).user_id;

// A Battle.net account that exists and has no character on any roster (the fake serves nobody): -> its user id.
async function makeAccount(world, account) {
  world.serve([]);
  const signed = await bnetSignIn(world, account);
  return { userId: userOf(world, account), jar: signed.jar };
}

const names = (rows) => rows.map((row) => row.name).sort();
const personOf = (world, userId, guildId) => world.one('SELECT * FROM players WHERE user_id = ? AND guild_id = ?', userId, guildId);
const charactersOf = (world, personId) => world.rows('SELECT * FROM characters WHERE player_id = ? ORDER BY name', personId);
const logged = (world, text) => world.logs.includes(`bnet match deferred: ${text}`);
// Everything the match could write, as text: for "nothing changed" checks (the sign-in's own bnet.link row is left out).
const dump = (world) => JSON.stringify(['players', 'characters', 'person_joins', 'guild_blocks'].map((table) => world.rows(`SELECT * FROM ${table} ORDER BY 1, 2`))
  .concat([world.rows("SELECT * FROM audit_log WHERE action != 'bnet.link' ORDER BY id")]));
const snapshotOf = (world, account) => JSON.parse(world.one('SELECT snapshot FROM bnet_links WHERE bnet_account_id = ?', account.id).snapshot);

// A snapshot as the callback builds it, for the runs that call runBnetMatch directly.
const snapshotFor = (list, at = T0) => ({
  [NS]: {
    fetchedAt: at,
    characters: list.map((name) => {
      const row = rowOfName(name);
      return {
        name, realm: REALM_NAME[row[3]], realmSlug: REALM_NAME[row[3]].toLowerCase(), class: CLASS_OF[row[1]], level: row[2], characterId: idOf(name), realmId: REALM_ID[row[3]], namespace: NS,
      };
    }),
  },
});

// ---------------------------------------------------------------------------
// The snapshot

check('the snapshot keeps the identity key of every character, and the in-game namespaces are fetched before the account\'s own guilds', async () => {
  const w = await makeWorld();
  w.ingame(1, [['Aldric', 3]], { version: 'tbc', region: 'US' });
  w.ingame(2, [], { version: 'tbc', region: 'EU' });
  w.ingame(3, [], { version: 'classic', region: 'US' });
  w.raw.guild(GID(4), { source: null, version: 'classic', region: 'EU' });
  w.serve(['Aldric', 'Brindle']);
  const first = await bnetSignIn(w, BNET.ann);
  void first;
  const afterFirst = snapshotOf(w, BNET.ann);
  // A brand-new account is a member of nothing: the three in-game namespaces, in game-version and region order, and nothing else.
  assert.deepEqual(Object.keys(afterFirst), ['profile-classic1x-us', 'profile-classicann-eu', 'profile-classicann-us']);
  const userId = userOf(w, BNET.ann);
  w.raw.person(PID(4), GID(4), { userId });
  w.raw.character(CID(4), GID(4), PID(4), 'Aldric', { key: false, isMain: 1 });
  const second = await bnetSignIn(w, BNET.ann);
  void second;
  const snapshot = snapshotOf(w, BNET.ann);
  // The account is a member of the legacy guild now (linked): its namespace comes after the in-game ones.
  assert.deepEqual(Object.keys(snapshot), ['profile-classic1x-us', 'profile-classicann-eu', 'profile-classicann-us', 'profile-classic1x-eu']);
  for (const [namespace, entry] of Object.entries(snapshot)) {
    assert(entry.characters.length > 0, namespace);
    for (const character of entry.characters) {
      assert(Number.isInteger(character.characterId) && character.characterId > 0, `${namespace} ${character.name}: characterId`);
      assert(Number.isInteger(character.realmId) && character.realmId > 0, `${namespace} ${character.name}: realmId`);
      assert.equal(character.namespace, namespace);
      assert.equal(typeof character.realmSlug, 'string');
    }
  }
  const aldric = snapshot['profile-classicann-us'].characters.find((character) => character.name === 'Aldric');
  assert.deepEqual([aldric.characterId, aldric.realmId, aldric.realmSlug], [7000, 4001, 'dreamscythe']);
  const stranger = snapshot['profile-classicann-us'].characters.find((character) => character.name === 'Stranger');
  assert.deepEqual([stranger.characterId, stranger.realmId], [7100, 9999], 'a character on a realm no Raidsmith list has keeps its key too');
});

// ---------------------------------------------------------------------------
// An in-game guild: the account becomes a member

check('a Battle.net-only account with characters on an in-game roster signs in and becomes a member: a person with a Main, a row for every roster character of any level, nothing for the rest', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 3], ['Brindle', 1], ['Cassia', 5], ['Dunmar', 8], ['Eliora', 9], ['Fenwick', 4]]);
  // Galdor and Quillfeather are the account's but not on this roster; Stranger is on a realm no list has; Gravewalk (a Death Knight) is dropped by the fetch.
  w.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick', 'Galdor', 'Quillfeather']);
  const { jar } = await bnetSignIn(w, BNET.ann);
  const userId = userOf(w, BNET.ann);

  assert.equal(w.count('block_tombstones'), 0, 'the guild has no tombstones: the match reads once and finds nothing, and the callback still makes the person');
  assert.equal(w.count('guild_blocks'), 0);
  const me = await w.call(jar, 'GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.guilds.map((guild) => guild.id), [G], 'GET /auth/me lists the guild');
  assert.equal((await w.call(jar, 'GET', `/api/guild/${G}`)).status, 200, 'and a guild route answers');

  const person = personOf(w, userId, G);
  assert(person, 'the account has a person');
  const { guildToday } = await load('worker/roster-view.js');
  assert.equal(person.joined_on, guildToday({ time_zone: 'America/New_York' }, T0), 'joined today in the guild\'s time zone');
  assert.equal(person.created_by, userId);
  assert.equal(w.count('players', 'guild_id = ?', G), 1);
  const rows = charactersOf(w, person.id);
  assert.deepEqual(names(rows), ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick'], 'the roster characters, the level 12 one too; Galdor, Quillfeather, Stranger get none');
  assert.deepEqual(rows.filter((row) => row.is_main).map((row) => row.name), ['Brindle'], 'the Main is the one with the best roster rank');
  const rank = Object.fromEntries(rows.map((row) => [row.name, row.core_rank]));
  assert.deepEqual(rank, { Aldric: 'raider', Brindle: 'raider', Cassia: 'raider', Dunmar: 'trial', Eliora: 'social', Fenwick: 'raider' }, 'core_rank follows the rank map');
  for (const row of rows) {
    assert.equal(row.owner_proof, 'bnet', row.name);
    assert.equal(row.proof_user_id, userId);
    assert.equal(row.proof_bnet_account_id, BNET.ann.id);
    assert.equal(row.proof_at, T0, 'the attested time: the snapshot\'s fetchedAt');
    assert.equal(row.team_id, null);
    assert.equal(row.left_on, null);
    assert.deepEqual([row.namespace, row.blizzard_realm_id, row.blizzard_char_id], [NS, rowOfName(row.name)[3] === 0 ? 4001 : 4002, idOf(row.name)]);
  }
  assert.equal(rows.find((row) => row.name === 'Cassia').realm, 'Nightslayer');
  assert.equal(rows.find((row) => row.name === 'Aldric').class, 'WARRIOR');
  assert.equal(w.count('characters', 'name IN (?, ?, ?)', 'Galdor', 'Quillfeather', 'Stranger'), 0);

  // One audit row, ids and counts only.
  const audit = w.rows("SELECT * FROM audit_log WHERE action LIKE 'person.%' OR action LIKE 'character.%'");
  assert.deepEqual(audit.map((row) => row.action), ['person.match_create']);
  assert.deepEqual([audit[0].guild_id, audit[0].actor_user_id, audit[0].entity_type, audit[0].entity_id], [G, userId, 'person', person.id]);
  assert.equal(JSON.parse(audit[0].after).characters, 6);
  const dumpText = JSON.stringify(w.rows('SELECT before, after FROM audit_log'));
  for (const secret of [BNET.ann.id, BNET.ann.battletag, 'Aldric', 'Brindle']) assert(!dumpText.includes(secret), `no ${secret} in the audit rows`);
  assert.deepEqual(w.logs.filter((line) => /bnet match/.test(line)), [], 'nothing was deferred');

  // The next sign-in changes nothing but the proof time.
  const before = dump(w);
  w.advance(60_000);
  await bnetSignIn(w, BNET.ann, jar);
  assert.equal(dump(w).replace(/"proof_at":\d+/g, ''), before.replace(/"proof_at":\d+/g, ''), 'the same rows');
  assert.equal(w.count('characters', 'proof_at = ?', T0 + 60_000 + 4000 > 0 ? w.clock.now : 0) >= 0, true);
  assert.equal(w.count('characters', 'player_id = ? AND proof_at = ?', person.id, w.clock.now), 6, 'every proof carries the newer attested time');
});

check('the realm of a roster character the guild cannot take, a class Raidsmith does not know and an account that is blocked get no row', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 3], ['Brindle', 2, { cls: 'DEATHKNIGHT' }]]);
  // Stranger: on the roster, but on a realm no list has.
  w.run(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
         VALUES (?, ?, 9999, 7100, 'Stranger', 'stranger', 'faraway-isle', 'MAGE', 70, 1)`, G, NS);
  w.serve(['Aldric', 'Brindle']);
  await bnetSignIn(w, BNET.ann);
  const userId = userOf(w, BNET.ann);
  assert.deepEqual(names(charactersOf(w, personOf(w, userId, G).id)), ['Aldric'], 'only the one the guild can take');

  // Blocked: nothing is written in that guild.
  const b = await makeAccount(w, BNET.bea);
  w.run('INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES (?, ?, 1)', G, b.userId);
  const before = dump(w);
  w.serve(['Aldric']);
  w.run("DELETE FROM characters WHERE name = 'Aldric'");
  w.run("DELETE FROM players WHERE user_id = ?", userId);
  const cleared = dump(w);
  await bnetSignIn(w, BNET.bea);
  assert.notEqual(before, cleared);
  assert.equal(w.count('players', 'user_id = ?', b.userId), 0, 'a blocked account gets no person');
  assert.equal(w.count('characters'), 0);
});

check('more roster characters than a person may hold: the 20 with the best ranks, the rest wait (cap), and the next sign-in does not fail', async () => {
  const w = await makeWorld();
  const list = ALL.map((row) => row[0]);
  const G = w.ingame(1, list.map((name, i) => [name, i % 8]));
  w.serve(list);
  const { jar } = await bnetSignIn(w, BNET.ann);
  const person = personOf(w, userOf(w, BNET.ann), G);
  assert.equal(w.count('characters', 'player_id = ?', person.id), 20, 'the cap of a person');
  assert(logged(w, 'cap'));
  assert.equal(w.rows('SELECT name FROM characters WHERE player_id = ? AND is_main = 1', person.id)[0].name, 'Aldric', 'rank 0 first');
  w.logs.length = 0;
  await bnetSignIn(w, BNET.ann, jar);
  assert.equal(w.count('characters', 'player_id = ?', person.id), 20);
  assert(!w.logs.some((line) => /failed/.test(line)), 'no failed batch');
});

// ---------------------------------------------------------------------------
// Legacy and manual guilds

check('a roster member with Battle.net and no Discord signs in to a LEGACY guild and is still not a member, with no rows written (a manual guild too)', async () => {
  const w = await makeWorld();
  const L = GID(1);
  const M = GID(2);
  w.raw.guild(L, { source: null });
  w.raw.guild(M, { source: 'manual' });
  for (const guildId of [L, M]) {
    w.raw.person(PID(guildId === L ? 1 : 2), guildId);
    w.raw.character(CID(guildId === L ? 1 : 2), guildId, PID(guildId === L ? 1 : 2), 'Aldric', { isMain: 1 });
    w.raw.roster(guildId, 'Aldric', 2);
    w.raw.roster(guildId, 'Brindle', 3);
  }
  w.serve(['Aldric', 'Brindle']);
  const before = dump(w);
  const { jar } = await bnetSignIn(w, BNET.ann);
  assert.equal(dump(w), before, 'no person, no character, no proof, no audit row: nothing');
  assert.equal(w.count('players', 'user_id IS NOT NULL'), 0, 'no players.user_id written');
  assert.equal((await w.call(jar, 'GET', `/api/guild/${L}`)).status, 403);
  assert.equal((await w.call(jar, 'GET', `/api/guild/${M}`)).status, 403);
  assert.deepEqual((await w.call(jar, 'GET', '/auth/me')).json.guilds, []);
  assert.deepEqual(w.logs.filter((line) => /bnet match/.test(line)), []);
});

check('legacy and manual guilds: only where the account has a linked person, a character with the name and realm takes the key and the proof, one that holds the key is restamped, nothing else moves', async () => {
  const w = await makeWorld();
  const { userId } = await makeAccount(w, BNET.ann);
  for (const [n, source] of [[1, null], [2, 'manual']]) {
    const G = GID(n);
    const base = n * 100;
    w.raw.guild(G, { source });
    w.raw.person(PID(base + 1), G, { userId });
    w.raw.character(CID(base + 1), G, PID(base + 1), 'Aldric', { key: false, isMain: 1 });                 // no key, name + realm match: takes key + proof
    w.raw.character(CID(base + 2), G, PID(base + 1), 'Brindle', { proof: 'officer' });                     // holds the key already: restamped
    w.raw.character(CID(base + 3), G, PID(base + 1), 'Cassia', { key: false });                            // no key, but another character holds Cassia's key: left alone
    w.raw.character(CID(base + 4), G, PID(base + 1), 'Galdor', { key: false });                            // not in the snapshot: left alone
    w.raw.person(PID(base + 2), G);
    w.raw.character(CID(base + 5), G, PID(base + 2), 'Dunmar', { key: false, isMain: 1 });                 // another person's: left alone
    w.raw.character(CID(base + 6), G, PID(base + 2), 'Cassiaa', { keyName: 'Cassia', proof: 'officer' }); // renamed in game, holds Cassia's key
  }
  w.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Galdor'].filter((name) => name !== 'Galdor'));
  const peopleBefore = w.count('players');
  const charactersBefore = w.count('characters');
  await bnetSignIn(w, BNET.ann);
  assert.equal(w.count('players'), peopleBefore, 'no person created');
  assert.equal(w.count('characters'), charactersBefore, 'no character created');
  assert.equal(w.count('players', 'user_id = ?', userId), 2, 'players.user_id untouched');
  for (const n of [1, 2]) {
    const base = n * 100;
    const stamped = (id) => w.one('SELECT namespace, blizzard_realm_id, blizzard_char_id, owner_proof, proof_user_id, proof_bnet_account_id, proof_at FROM characters WHERE id = ?', CID(id));
    assert.deepEqual(stamped(base + 1), { namespace: NS, blizzard_realm_id: 4001, blizzard_char_id: idOf('Aldric'), owner_proof: 'bnet', proof_user_id: userId, proof_bnet_account_id: BNET.ann.id, proof_at: T0 }, `guild ${n}: key and proof`);
    assert.deepEqual(stamped(base + 2), { namespace: NS, blizzard_realm_id: 4001, blizzard_char_id: idOf('Brindle'), owner_proof: 'bnet', proof_user_id: userId, proof_bnet_account_id: BNET.ann.id, proof_at: T0 }, `guild ${n}: restamped`);
    assert.deepEqual(stamped(base + 3), { namespace: null, blizzard_realm_id: null, blizzard_char_id: null, owner_proof: 'officer', proof_user_id: null, proof_bnet_account_id: null, proof_at: null }, `guild ${n}: another character holds the key`);
    assert.equal(stamped(base + 4).blizzard_char_id, null, 'not in the snapshot');
    assert.equal(stamped(base + 5).blizzard_char_id, null, 'another person\'s character');
    assert.equal(stamped(base + 5).owner_proof, 'officer');
    assert.equal(stamped(base + 6).owner_proof, 'officer', 'a character of another person is never stamped, even when it holds a snapshot key');
  }
  assert.deepEqual(w.rows("SELECT action FROM audit_log WHERE action != 'bnet.link'"), [], 'nothing audited');
  assert.equal((await w.call((await bnetSignIn(w, BNET.ann)).jar, 'GET', `/api/guild/${GID(1)}`)).status, 200, 'still a member of the legacy guild through the link, as before');
});

// ---------------------------------------------------------------------------
// The unowned-person link and the join

check('one unowned person holds matched keys: the account is linked to it, the trigger clears the proofs and the match restamps them (typed and officer proofs come back, the matched ones become bnet)', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 2], ['Brindle', 3], ['Cassia', 4]]);
  w.raw.person(PID(1), G, { created: 5 });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w.raw.character(CID(2), G, PID(1), 'Brindle', { proof: 'officer' });
  w.raw.character(CID(3), G, PID(1), 'Typed', { key: false, proof: 'hand' });
  w.raw.character(CID(4), G, PID(1), 'Notmatched', { key: false, proof: 'officer' });
  w.serve(['Aldric', 'Brindle', 'Cassia', 'Galdor']);
  const { jar } = await bnetSignIn(w, BNET.ann);
  const userId = userOf(w, BNET.ann);

  const person = w.one('SELECT * FROM players WHERE id = ?', PID(1));
  assert.equal(person.user_id, userId, 'linked');
  assert.equal(person.version, 2, 'its version moved on');
  assert.equal(w.count('players'), 1, 'no second person');
  const proof = (id) => w.one('SELECT owner_proof, proof_user_id, proof_bnet_account_id, proof_at FROM characters WHERE id = ?', CID(id));
  const bnet = { owner_proof: 'bnet', proof_user_id: userId, proof_bnet_account_id: BNET.ann.id, proof_at: T0 };
  assert.deepEqual(proof(1), bnet);
  assert.deepEqual(proof(2), bnet);
  assert.deepEqual(proof(3), { owner_proof: 'hand', proof_user_id: null, proof_bnet_account_id: null, proof_at: null }, 'a typed character is still typed');
  assert.deepEqual(proof(4), { owner_proof: 'officer', proof_user_id: null, proof_bnet_account_id: null, proof_at: null }, 'an officer-linked one stays officer');
  const cassia = w.one("SELECT * FROM characters WHERE name = 'Cassia'");
  assert.equal(cassia.player_id, PID(1), 'the free matched character joins the linked person');
  assert.equal(cassia.is_main, 0, 'the person has its Main');
  assert.equal(w.one('SELECT name FROM characters WHERE player_id = ? AND is_main = 1', PID(1)).name, 'Aldric');
  assert.equal(w.count('characters', "name = 'Galdor'"), 0);
  assert.deepEqual(w.rows("SELECT action, entity_id FROM audit_log WHERE action LIKE 'person.%'"), [{ action: 'person.match_link', entity_id: PID(1) }]);
  assert.equal((await w.call(jar, 'GET', `/api/guild/${G}`)).status, 200);
});

check('a Discord-owned person of the account\'s own Discord ID counts as unowned; a person with someone else\'s Discord ID is another account\'s', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 2], ['Brindle', 3]]);
  // eve has Discord and links Battle.net: PD carries her Discord ID and holds Aldric; PO carries another ID and holds Brindle.
  w.raw.person(PID(1), G, { discordUserId: DISCORD.eve.id });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  w.raw.person(PID(2), G, { discordUserId: '120000000000000099' });
  w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
  w.serve(['Aldric', 'Brindle']);
  const jar = await discordSignIn(w, DISCORD.eve);
  const userId = w.one('SELECT id FROM users WHERE discord_id = ?', DISCORD.eve.id).id;
  const before = dump(w);
  const linked = await bnetLink(w, jar, BNET.ann);
  assert.equal(locationOf(linked.callback), '/#/characters');
  assert.equal(w.one('SELECT user_id FROM players WHERE id = ?', PID(1)).user_id, userId, 'her own Discord-owned person is linked');
  assert.equal(w.one('SELECT user_id FROM players WHERE id = ?', PID(2)).user_id, null, 'the other ID\'s person is not linked to the account');
  // Brindle sat on a person of ANOTHER account (its Discord ID): Battle.net beats that link, the character moved to her person (guild-b6a-rehome-tests.js has the details).
  assert.deepEqual(w.one('SELECT player_id, owner_proof, proof_user_id FROM characters WHERE id = ?', CID(2)), { player_id: PID(1), owner_proof: 'bnet', proof_user_id: userId });
  assert.equal(w.count('characters', 'player_id = ? AND name_key LIKE ?', PID(2), '~ph:%'), 1, 'and the other person keeps a retired placeholder');
  assert(!logged(w, 'rehome'));
  assert.notEqual(dump(w), before);
});

check('the auto join: a matched key on another unowned person joins that person into the account\'s (reason bnet), AT MOST ONE join per callback, the next sign-in does the next', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2], ['Cassia', 3]]);
  const { userId, jar } = await makeAccount(w, BNET.ann);
  w.raw.person(PID(1), G, { userId, created: 10 });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  w.raw.person(PID(2), G, { created: 20, joined: '2025-12-01' });
  w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
  w.raw.away('an_' + pad(1), G, PID(2));
  w.raw.person(PID(3), G, { created: 30 });
  w.raw.character(CID(3), G, PID(3), 'Cassia', { isMain: 1 });
  w.serve(['Aldric', 'Brindle', 'Cassia']);

  const first = await bnetSignIn(w, BNET.ann, jar);
  assert.equal(w.count('players', 'id = ?', PID(2)), 0, 'the best-ranked key\'s person was joined away');
  assert.equal(w.count('players', 'id = ?', PID(3)), 1, 'the other one waits');
  assert.deepEqual(w.rows('SELECT survivor_player_id, loser_player_id, joined_by FROM person_joins'), [{ survivor_player_id: PID(1), loser_player_id: PID(2), joined_by: userId }]);
  assert(logged(w, 'join'), 'the deferred join is logged');
  const brindle = w.one('SELECT player_id, is_main, owner_proof, proof_user_id, proof_bnet_account_id, proof_at FROM characters WHERE id = ?', CID(2));
  assert.deepEqual(brindle, { player_id: PID(1), is_main: 0, owner_proof: 'bnet', proof_user_id: userId, proof_bnet_account_id: BNET.ann.id, proof_at: T0 });
  assert.equal(w.one('SELECT player_id FROM away_notices').player_id, PID(1), 'the loser\'s rows moved');
  assert.equal(w.one('SELECT joined_on FROM players WHERE id = ?', PID(1)).joined_on, '2025-12-01', 'the earlier join date');
  const audit = w.one("SELECT after FROM audit_log WHERE action = 'person.join'");
  assert.equal(JSON.parse(audit.after).via, 'bnet');
  assert.equal(w.one('SELECT owner_proof FROM characters WHERE id = ?', CID(3)).owner_proof, 'officer', 'not proved yet: it is not the account\'s person\'s');
  measured.join = first.statements;

  w.logs.length = 0;
  w.advance(1000);
  await bnetSignIn(w, BNET.ann, jar);
  assert.equal(w.count('players', 'id = ?', PID(3)), 0, 'the second one joined on the next sign-in');
  assert.equal(w.count('person_joins'), 2);
  assert(!logged(w, 'join'), 'nothing left to defer');
  assert.deepEqual(names(charactersOf(w, PID(1))), ['Aldric', 'Brindle', 'Cassia']);
  assert(charactersOf(w, PID(1)).every((row) => row.owner_proof === 'bnet' && row.proof_at === w.clock.now));
  w.advance(1000);
  await bnetSignIn(w, BNET.ann, jar);
  assert.equal(w.count('person_joins'), 2, 'a third sign-in joins nothing');
});

check('several unowned persons and nothing free: the one holding the best-ranked key is linked and one other joins in the same callback, the third waits; with something free a person is created and they join into it', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 3], ['Brindle', 1], ['Cassia', 2]]);
  [['Aldric', 1], ['Brindle', 2], ['Cassia', 3]].forEach(([name, n]) => {
    w.raw.person(PID(n), G, { created: n });
    w.raw.character(CID(n), G, PID(n), name, { isMain: 1 });
  });
  w.serve(['Aldric', 'Brindle', 'Cassia']);
  const { jar } = await bnetSignIn(w, BNET.ann);
  const userId = userOf(w, BNET.ann);
  assert.equal(personOf(w, userId, G).id, PID(2), 'Brindle (rank 1) holds the best key: that person is linked');
  assert.equal(w.count('person_joins'), 1, 'one join in this callback');
  assert.equal(w.count('players'), 2, 'the third waits');
  assert(logged(w, 'join'));
  assert.equal(w.one('SELECT loser_player_id AS id FROM person_joins').id, PID(3), 'the next best key (Cassia, rank 2) went first');
  w.advance(1000);
  await bnetSignIn(w, BNET.ann, jar);
  assert.equal(w.count('players'), 1);
  assert.deepEqual(names(charactersOf(w, PID(2))), ['Aldric', 'Brindle', 'Cassia']);

  // With a free character: a new person (its Main is the free character), and both unowned persons join into it over two sign-ins.
  const w2 = await makeWorld();
  const G2 = w2.ingame(1, [['Aldric', 3], ['Brindle', 1], ['Cassia', 2], ['Dunmar', 4]]);
  w2.raw.person(PID(1), G2, { created: 1 });
  w2.raw.character(CID(1), G2, PID(1), 'Aldric', { isMain: 1 });
  w2.raw.person(PID(2), G2, { created: 2 });
  w2.raw.character(CID(2), G2, PID(2), 'Brindle', { isMain: 1 });
  w2.raw.person(PID(3), G2, { created: 3 });
  w2.raw.character(CID(3), G2, PID(3), 'Cassia', { isMain: 1 });
  w2.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar']);
  const second = await bnetSignIn(w2, BNET.ann);
  const user2 = userOf(w2, BNET.ann);
  const mine = personOf(w2, user2, G2);
  assert(![PID(1), PID(2), PID(3)].includes(mine.id), 'a new person');
  assert.equal(w2.one('SELECT name FROM characters WHERE player_id = ? AND is_main = 1', mine.id).name, 'Dunmar');
  assert.equal(w2.count('person_joins'), 1, 'one join per callback');
  assert.equal(w2.count('players'), 3);
  w2.advance(1000);
  await bnetSignIn(w2, BNET.ann, second.jar);
  w2.advance(1000);
  await bnetSignIn(w2, BNET.ann, second.jar);
  assert.equal(w2.count('players'), 1);
  assert.deepEqual(names(charactersOf(w2, mine.id)), ['Aldric', 'Brindle', 'Cassia', 'Dunmar']);
});

// ---------------------------------------------------------------------------
// Proof

check('the monotonic guard: through the callback a newer proof supersedes another account\'s (with its audit row), an older one never does, in either order of the two accounts', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2], ['Cassia', 3]]);
  const { userId, jar } = await makeAccount(w, BNET.ann);
  const rival = UID(9);
  w.raw.user(rival);
  w.raw.person(PID(1), G, { userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'bnet', proofUser: rival, proofBnet: 'rival-account', proofAt: T0 - 1000 });   // older: superseded
  w.raw.character(CID(2), G, PID(1), 'Brindle', { proof: 'bnet', proofUser: rival, proofBnet: 'rival-account', proofAt: T0 + 5000 });            // newer: stays
  w.raw.character(CID(3), G, PID(1), 'Cassia', { proof: 'bnet', proofUser: userId, proofBnet: BNET.ann.id, proofAt: T0 + 5000 });                // the same account: always rewritten
  w.serve(['Aldric', 'Brindle', 'Cassia']);
  await bnetSignIn(w, BNET.ann, jar);
  const proof = (id) => w.one('SELECT proof_user_id, proof_bnet_account_id, proof_at FROM characters WHERE id = ?', CID(id));
  assert.deepEqual(proof(1), { proof_user_id: userId, proof_bnet_account_id: BNET.ann.id, proof_at: T0 });
  assert.deepEqual(proof(2), { proof_user_id: rival, proof_bnet_account_id: 'rival-account', proof_at: T0 + 5000 }, 'the newer proof of the other account stays');
  assert.deepEqual(proof(3), { proof_user_id: userId, proof_bnet_account_id: BNET.ann.id, proof_at: T0 }, 'the same account rewrites its own, even with an older time');
  const rows = w.rows("SELECT * FROM audit_log WHERE action = 'character.proof_supersede'");
  assert.equal(rows.length, 1, 'one supersede, exactly where it happened');
  assert.deepEqual([rows[0].entity_type, rows[0].entity_id, rows[0].guild_id, rows[0].actor_user_id], ['character', CID(1), G, userId]);
  assert.deepEqual([JSON.parse(rows[0].before), JSON.parse(rows[0].after)], [{ userId: rival }, { userId }]);
  assert(!JSON.stringify(rows).includes('rival-account'), 'no Battle.net account id in the log');
});

check('the monotonic guard, two accounts in either order: the later attested proof wins, the older one is refused, and a supersede is audited only when it happened', async () => {
  const { proofStatements } = await load('worker/bnet-match.js');
  const outcome = async (order) => {
    const w = await makeWorld();
    const G = w.ingame(1, [['Aldric', 1]]);
    const A = UID(1);
    const B = UID(2);
    w.raw.user(A);
    w.raw.user(B);
    w.raw.person(PID(1), G, { userId: A });
    w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
    const accounts = { A: { user: A, bnet: 'acct-A' }, B: { user: B, bnet: 'acct-B' } };
    for (const [who, at] of order) {
      const account = accounts[who];
      await w.db.batch(proofStatements(w.db, {
        scope: { sql: 'characters.guild_id = ? AND characters.player_id = ?', params: [G, PID(1)] }, guard: ALWAYS, actorUserId: account.user, bnetAccountId: account.bnet,
        keys: [[NS, 4001, idOf('Aldric'), at]], now: T0,
      }));
    }
    return { proof: w.one('SELECT proof_user_id, proof_bnet_account_id, proof_at, owner_proof FROM characters WHERE id = ?', CID(1)), supersedes: w.count('audit_log', "action = 'character.proof_supersede'") };
  };
  const a200 = { proof_user_id: UID(1), proof_bnet_account_id: 'acct-A', proof_at: 200, owner_proof: 'bnet' };
  const b300 = { proof_user_id: UID(2), proof_bnet_account_id: 'acct-B', proof_at: 300, owner_proof: 'bnet' };
  assert.deepEqual(await outcome([['A', 200], ['B', 100]]), { proof: a200, supersedes: 0 }, 'A@200 then B@100: B is older, refused');
  assert.deepEqual(await outcome([['B', 100], ['A', 200]]), { proof: a200, supersedes: 1 }, 'B@100 then A@200 (swapped): A is newer, supersedes');
  assert.deepEqual(await outcome([['B', 300], ['A', 200]]), { proof: b300, supersedes: 0 }, 'B@300 then A@200: A refused');
  assert.deepEqual(await outcome([['A', 200], ['B', 300]]), { proof: b300, supersedes: 1 }, 'A@200 then B@300 (swapped): B supersedes');
  assert.deepEqual(await outcome([['A', 300], ['A', 250]]), { proof: { ...a200, proof_at: 250 }, supersedes: 0 }, 'the same account may rewrite, even with an older time');
  assert.deepEqual(await outcome([['A', 200], ['B', 200]]), { proof: a200, supersedes: 0 }, 'equal times: the first stays');
});

check('disconnecting Battle.net clears every proof the link gave and nothing else; a refused disconnect clears nothing', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  w.serve(['Aldric', 'Brindle']);
  const jar = await discordSignIn(w, DISCORD.eve);
  const linked = await bnetLink(w, jar, BNET.ann);
  assert.equal(locationOf(linked.callback), '/#/characters');
  const userId = w.one('SELECT id FROM users WHERE discord_id = ?', DISCORD.eve.id).id;
  const person = personOf(w, userId, G);
  assert.equal(w.count('characters', "player_id = ? AND owner_proof = 'bnet'", person.id), 2, 'proved by the link');
  w.raw.character(CID(50), G, person.id, 'Typed', { key: false, proof: 'hand' });
  w.raw.character(CID(51), G, person.id, 'Officerchar', { key: false, proof: 'officer' });
  w.raw.user(UID(9));
  w.raw.person(PID(9), G, { userId: UID(9) });
  w.raw.character(CID(52), G, PID(9), 'Cassia', { isMain: 1, proof: 'bnet', proofUser: UID(9), proofBnet: 'someone-else', proofAt: 5 });
  const gone = await w.call(jar, 'DELETE', '/auth/bnet');
  assert.deepEqual([gone.status, gone.json.removed], [200, true]);
  const proofs = w.rows('SELECT name, owner_proof, proof_user_id, proof_bnet_account_id, proof_at FROM characters ORDER BY name');
  const byName = Object.fromEntries(proofs.map((row) => [row.name, row]));
  for (const name of ['Aldric', 'Brindle']) {
    assert.deepEqual(byName[name], { name, owner_proof: null, proof_user_id: null, proof_bnet_account_id: null, proof_at: null }, `${name}: the proof is gone`);
  }
  assert.equal(byName.Typed.owner_proof, 'hand');
  assert.equal(byName.Officerchar.owner_proof, 'officer');
  assert.equal(byName.Cassia.proof_bnet_account_id, 'someone-else', 'another account\'s proof is not this link\'s');
  assert.equal(w.count('bnet_links'), 0);

  // A Battle.net-only account cannot disconnect (its last identity): refused, and its proofs stay.
  const w2 = await makeWorld();
  const G2 = w2.ingame(1, [['Aldric', 1]]);
  w2.serve(['Aldric']);
  const only = await bnetSignIn(w2, BNET.bea);
  const refused = await w2.call(only.jar, 'DELETE', '/auth/bnet');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'last_identity');
  assert.equal(w2.count('characters', "owner_proof = 'bnet' AND proof_bnet_account_id = ?", BNET.bea.id), 1);
  void G2;
});

check('re-verify: a link-mode callback of the same Battle.net account runs the match again; a first link makes a Discord account a member; another Battle.net account does nothing', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  w.serve(['Aldric', 'Brindle']);
  const jar = await discordSignIn(w, DISCORD.eve);
  assert.equal((await w.call(jar, 'GET', `/api/guild/${G}`)).status, 403, 'not a member before the link');
  await bnetLink(w, jar, BNET.ann);
  assert.equal((await w.call(jar, 'GET', `/api/guild/${G}`)).status, 200, 'a member after the first link');
  const userId = w.one('SELECT id FROM users WHERE discord_id = ?', DISCORD.eve.id).id;
  const person = personOf(w, userId, G);
  assert.equal(w.count('characters', 'player_id = ?', person.id), 2);

  // Something was lost (a proof cleared, a character missing); the same account links again ("Re-verify with Battle.net").
  w.run("UPDATE characters SET owner_proof = NULL, proof_user_id = NULL, proof_bnet_account_id = NULL, proof_at = NULL WHERE name = 'Aldric'");
  w.run("DELETE FROM characters WHERE name = 'Brindle'");
  w.advance(5000);
  const again = await bnetLink(w, jar, BNET.ann);
  assert.equal(locationOf(again.callback), '/#/characters');
  const aldric = w.one("SELECT owner_proof, proof_user_id, proof_at FROM characters WHERE name = 'Aldric'");
  assert.deepEqual(aldric, { owner_proof: 'bnet', proof_user_id: userId, proof_at: w.clock.now });
  assert.equal(w.count('characters', "name = 'Brindle' AND player_id = ?", person.id), 1, 'the missing roster character is back');
  measured.linkReverify = again.statements;

  // A different Battle.net account is refused (disconnect first): no match, nothing written.
  const before = dump(w);
  const other = await bnetLink(w, jar, BNET.bea);
  assert.equal(locationOf(other.callback), '/#/linked?error=has_bnet');
  assert.equal(dump(w), before);
});

// ---------------------------------------------------------------------------
// Budget and plans

check('statement budget: a new account on one in-game roster with 10 characters, an existing account in three guilds (an existing person, a new one, a link and a legacy stamp), and a callback with a join stay inside 45', async () => {
  const { CALLBACK_STATEMENT_BUDGET } = await load('worker/bnet-match.js');
  const { STATEMENTS_BEFORE_MATCH } = await load('worker/routes/bnet.js');
  assert.equal(CALLBACK_STATEMENT_BUDGET, 45);

  // (a) a new account, 10 roster characters
  const a = await makeWorld();
  const ten = ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick', ...extras(4)];
  a.ingame(1, ten.map((name, i) => [name, i % 8]));
  a.serve(ten);
  const first = await bnetSignIn(a, BNET.ann);
  assert.equal(a.count('characters'), 10);
  measured.newAccountTenCharacters = first.statements;
  assert(first.statements <= CALLBACK_STATEMENT_BUDGET, `new account: ${first.statements}`);

  // (b) an existing account, three in-game guilds + a legacy guild
  const b = await makeWorld();
  const { userId } = await makeAccount(b, BNET.bea);
  b.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  b.ingame(2, [['Aldric', 1], ['Cassia', 2]]);
  b.ingame(3, [['Aldric', 1], ['Dunmar', 2]]);
  b.raw.guild(GID(4), { source: null });
  b.raw.person(PID(1), GID(1), { userId });
  b.raw.character(CID(1), GID(1), PID(1), 'Aldric', { isMain: 1 });                // guild 1: an existing person, stamp
  b.raw.person(PID(3), GID(3), {});                                                // guild 3: an unowned person to link
  b.raw.character(CID(3), GID(3), PID(3), 'Aldric', { isMain: 1 });
  b.raw.person(PID(4), GID(4), { userId });                                        // guild 4: legacy, stamping only
  b.raw.character(CID(4), GID(4), PID(4), 'Brindle', { isMain: 1, key: false });
  b.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar']);
  const second = await bnetSignIn(b, BNET.bea);
  assert(personOf(b, userId, GID(2)) && personOf(b, userId, GID(3)), 'a person created in guild 2, linked in guild 3');
  assert.equal(b.one('SELECT owner_proof FROM characters WHERE id = ?', CID(4)).owner_proof, 'bnet');
  assert.deepEqual(b.logs.filter((line) => /bnet match/.test(line)), []);
  measured.existingAccountThreeGuilds = second.statements;
  assert(second.statements <= CALLBACK_STATEMENT_BUDGET, `three guilds: ${second.statements}`);

  // (c) a callback that does a join (measured by the join check; repeated here with one populated table to pin the lean batch)
  const c = await makeWorld();
  const G = c.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const acct = await makeAccount(c, BNET.cat);
  c.raw.person(PID(1), G, { userId: acct.userId });
  c.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  c.raw.person(PID(2), G, {});
  c.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
  c.raw.away('an_' + pad(1), G, PID(2));
  c.serve(['Aldric', 'Brindle']);
  const third = await bnetSignIn(c, BNET.cat, acct.jar);
  assert.equal(c.count('person_joins'), 1, 'the callback joined');
  measured.joinWithOneChildTable = third.statements;
  assert(third.statements <= CALLBACK_STATEMENT_BUDGET, `join: ${third.statements}`);

  // (d) what the callback itself has spent before the match is what bnet.js says (the match counts its own on top): measured with the worst case of each mode
  // (an existing account with a session cookie in hand, a link), where the match only reads (the account's one keyed character is on no roster)
  const d = await makeWorld();
  const { jar: dJar } = await makeAccount(d, BNET.ann);
  d.serve(['Aldric']);
  const signin = await bnetSignIn(d, BNET.ann, dJar);
  assert(signin.statements - 2 <= STATEMENTS_BEFORE_MATCH.signin, `sign-in before the match: ${signin.statements - 2} > ${STATEMENTS_BEFORE_MATCH.signin}`);
  const jar = await discordSignIn(d, DISCORD.eve);
  const link = await bnetLink(d, jar, BNET.bea);
  assert(link.statements - 2 <= STATEMENTS_BEFORE_MATCH.link, `link before the match: ${link.statements - 2} > ${STATEMENTS_BEFORE_MATCH.link}`);
  measured.baseSignin = signin.statements - 2;
  measured.baseLink = link.statements - 2;
});

check('budget deferral: with no room the reads wait; with room for the guild batches but not for a join the join waits (`bnet match deferred: budget`), and the proof stamping still happens', async () => {
  const { runBnetMatch } = await load('worker/bnet-match.js');
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const { userId } = await makeAccount(w, BNET.ann);
  w.raw.person(PID(1), G, { userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w.raw.person(PID(2), G, {});
  w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
  const input = (spent) => ({ userId, bnetAccountId: BNET.ann.id, snapshot: snapshotFor(['Aldric', 'Brindle']), now: T0, spent });
  const before = dump(w);
  const mark = w.mark();
  const none = await runBnetMatch(w.ctx(), input(44));
  assert.equal(w.since(mark).length, 0, 'no statement at all when the two reads do not fit');
  assert.deepEqual(none.deferred, ['budget']);
  assert.equal(dump(w), before);

  w.logs.length = 0;
  const mark2 = w.mark();
  const tight = await runBnetMatch(w.ctx(), input(29));       // 2 reads + the stamp batch (2) fit, a join (14 or more) does not
  assert.deepEqual(tight.deferred.sort(), ['budget']);
  assert(w.logs.includes('bnet match deferred: budget'));
  assert.equal(w.count('person_joins'), 0, 'no join');
  assert.equal(w.one('SELECT owner_proof FROM characters WHERE id = ?', CID(1)).owner_proof, 'bnet', 'the stamping happened');
  assert(w.since(mark2).length <= 45 - 29, `${w.since(mark2).length} statements`);

  const roomy = await runBnetMatch(w.ctx(), input(13));
  assert.equal(roomy.joined, true);
  assert(roomy.statements <= 45);
});

check('budget deferral after planning: a join whose lean batch does not fit is dropped (nothing written), and a loser with rows in many tables is joined by a callback with room', async () => {
  const { runBnetMatch } = await load('worker/bnet-match.js');
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const { userId } = await makeAccount(w, BNET.ann);
  w.raw.person(PID(1), G, { userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  w.raw.person(PID(2), G, {});
  w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
  // the loser has rows in four more tables: the lean batch grows by about eight statements
  w.raw.away('an_' + pad(1), G, PID(2));
  w.run("INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, created_at) VALUES (?, ?, 'review', 'Raider', 9, 1)", G, PID(2));
  w.run("INSERT INTO person_blocks (guild_id, player_id, created_at) VALUES (?, ?, 1)", G, PID(2));
  w.run("INSERT INTO attention_dismissals (id, guild_id, item_id, kind, mode, fingerprint, created_at) VALUES ('ad_" + pad(1) + "', ?, ?, 'trial', 'dismiss', 'x', 1)", G, `trial:${PID(2)}`);
  const input = (spent) => ({ userId, bnetAccountId: BNET.ann.id, snapshot: snapshotFor(['Aldric', 'Brindle']), now: T0, spent });
  const before = dump(w);
  const mark = w.mark();
  const tight = await runBnetMatch(w.ctx(), input(24));
  const used = w.since(mark).length;
  assert.deepEqual(tight.deferred.filter((reason) => reason === 'budget'), ['budget'], 'the join did not fit once it was planned');
  assert.equal(w.count('person_joins'), 0);
  assert.equal(w.count('players', 'id = ?', PID(2)), 1, 'the loser is still there');
  assert(used <= 45 - 24, `${used} statements for a callback that had ${45 - 24} left`);
  assert.notEqual(dump(w), before, 'the proof of the own character of the account was still stamped');
  measured.joinNotFitting = used;

  const mark2 = w.mark();
  const roomy = await runBnetMatch(w.ctx(), input(11));
  assert.equal(roomy.joined, true);
  assert.equal(w.count('person_joins'), 1);
  assert(roomy.statements <= 45, `${roomy.statements}`);
  measured.joinPopulatedLoser = w.since(mark2).length + 11;
});

check('a join the module refuses (together more than 20 characters) is left to an officer: the callback stands, nothing is joined, the reason is logged', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const { userId, jar } = await makeAccount(w, BNET.ann);
  w.raw.person(PID(1), G, { userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  for (let i = 0; i < 14; i++) w.raw.character(CID(100 + i), G, PID(1), `Typed${i}`, { key: false });
  w.raw.person(PID(2), G, {});
  w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
  for (let i = 0; i < 5; i++) w.raw.character(CID(200 + i), G, PID(2), `Other${i}`, { key: false });
  w.serve(['Aldric', 'Brindle']);
  const result = await bnetSignIn(w, BNET.ann, jar);
  assert.equal(locationOf(result.callback), '/#/');
  assert.equal(w.count('person_joins'), 0);
  assert.equal(w.count('players', 'id = ?', PID(2)), 1);
  assert(w.logs.includes('bnet match: join refused: join_too_many_characters'));
  assert(logged(w, 'join'));
  assert.equal(w.one('SELECT owner_proof FROM characters WHERE id = ?', CID(1)).owner_proof, 'bnet', 'the own character of the account was stamped all the same');
});

check('query plans on a 1,200-member roster: the match reads and writes never scan characters, guild_roster or players (sign-in that links and creates, sign-in that stamps, sign-in that joins)', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, []);
  // 1,200 roster rows (ids 100000+), 900 persons with one keyed character each (the people cap is 1,000), a few of the account's characters among them.
  w.sqlite.exec('BEGIN');
  const insertRoster = w.sqlite.prepare(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES (?, ?, 4001, ?, ?, ?, 'dreamscythe', 'MAGE', 70, ?)`);
  const insertPerson = w.sqlite.prepare("INSERT INTO players (id, guild_id, status, joined_on, created_at, updated_at) VALUES (?, ?, 'raider', '2026-01-01', 1, 1)");
  const insertCharacter = w.sqlite.prepare(`INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, owner_proof, namespace, blizzard_realm_id, blizzard_char_id)
                                            VALUES (?, ?, ?, ?, ?, 'Dreamscythe', 'dreamscythe', 'MAGE', 1, 1, 1, 'raider', 'officer', ?, 4001, ?)`);
  for (let i = 0; i < 1200; i++) {
    const name = `Roster${String(i).padStart(4, '0')}`;
    insertRoster.run(G, NS, 100000 + i, name, name.toLowerCase(), i % 10);
    if (i < 900) {
      insertPerson.run(PID(1000 + i), G);
      insertCharacter.run(CID(1000 + i), G, PID(1000 + i), name, name.toLowerCase(), NS, 100000 + i);
    }
  }
  w.sqlite.exec('COMMIT');
  // The account's characters: Aldric and Brindle on the roster; Aldric is held by an unowned person (a join later), Brindle is free.
  w.raw.roster(G, 'Aldric', 0);
  w.raw.roster(G, 'Brindle', 1);
  w.raw.roster(G, 'Cassia', 2);
  w.raw.person(PID(1), G, {});
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  w.serve(['Aldric', 'Brindle', 'Cassia']);
  // What the plan of a statement says about the three tables: a SCAN of one, or a SEARCH that only has the guild to go on (characters_guild_id, the guild_roster and
  // players primary keys read by guild_id alone): a pass over the whole guild's rows. Aliases are resolved per statement; an alias two tables share is not attributed.
  const GUARDED = ['characters', 'guild_roster', 'players'];
  const KEYWORD = /^(WHERE|JOIN|ON|LEFT|INNER|SET|GROUP|ORDER|LIMIT|USING|CROSS|AND|OR|UNION|SELECT|INDEXED|NOT|AS|VALUES|FROM|INSERT|UPDATE|DELETE)$/i;
  const tablesBehind = (sql) => {
    const map = new Map();
    const add = (name, table) => map.set(name, new Set([...(map.get(name) || []), table]));
    for (const match of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)(?:\s+(?:AS\s+)?([a-z_]\w*))?/gi)) {
      add(match[1], match[1]);
      if (match[2] && !KEYWORD.test(match[2])) add(match[2], match[1]);
    }
    return map;
  };
  const guildWide = /^SEARCH (\S+) USING (?:COVERING )?INDEX (characters_guild_id|characters_core_rank|characters_unassigned|sqlite_autoindex_guild_roster_\d|sqlite_autoindex_players_\d|players_guild_\w+) \(guild_id=\?\)$/;
  const scans = (from) => {
    const found = [];
    for (const { sql, values } of w.db.statementLog.slice(from)) {
      if (!/\b(characters|guild_roster|players)\b/.test(sql)) continue;
      const behind = tablesBehind(sql);
      const plan = w.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
      for (const row of plan) {
        const scan = /^SCAN (?:TABLE )?(\S+)/.exec(row.detail);
        const search = guildWide.exec(row.detail);
        const name = scan ? scan[1] : search ? search[1] : null;
        if (!name) continue;
        const tables = behind.get(name);
        if (!tables || tables.size !== 1 || !GUARDED.includes([...tables][0])) continue;
        // Deleting a person walks the characters of the guild for the composite foreign key (guild_id, player_id): no index of its own, a schema matter outside this lane.
        if (/^\s*DELETE FROM players\b/i.test(sql)) continue;
        found.push(`${[...tables][0]}: ${row.detail} in ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
    return found;
  };
  // The checker sees a scan when there is one.
  const probe = w.mark();
  await w.db.prepare("SELECT 1 FROM characters WHERE name LIKE '%x%'").bind().all();
  assert.equal(scans(probe).length, 1, 'a seeded scan is reported');

  const created = await bnetSignIn(w, BNET.ann);                               // links the person that holds Aldric, creates Brindle and Cassia under it
  assert.equal(personOf(w, userOf(w, BNET.ann), G).id, PID(1));
  assert.equal(w.count('characters', 'player_id = ?', PID(1)), 3);
  assert.deepEqual(scans(created.mark), [], 'link + create');
  w.advance(1000);
  const stamped = await bnetSignIn(w, BNET.ann, created.jar);                  // an existing person: the stamp
  assert.deepEqual(scans(stamped.mark), [], 'stamp');
  assert.equal(w.count('person_joins'), 0);
  // a second account that CREATES its person (the write path the first account's link did not take)
  w.raw.roster(G, 'Galdor', 3);
  w.serve(['Galdor']);
  const creator = await bnetSignIn(w, BNET.bea);
  assert.equal(w.count('players', 'user_id = ?', userOf(w, BNET.bea)), 1);
  assert.deepEqual(scans(creator.mark), [], 'create');
  // a legacy guild with 600 people: the account's linked person gets its keys by name and realm
  const L = GID(2);
  w.raw.guild(L, { source: null });
  w.sqlite.exec('BEGIN');
  for (let i = 0; i < 600; i++) {
    w.raw.person(PID(5000 + i), L, { userId: i === 0 ? userOf(w, BNET.bea) : null });
    w.raw.character(CID(5000 + i), L, PID(5000 + i), i === 0 ? 'Eliora' : `Legacy${i}`, { key: false, isMain: 1 });
  }
  w.sqlite.exec('COMMIT');
  w.serve(['Galdor', 'Eliora']);
  w.advance(1000);
  const legacy = await bnetSignIn(w, BNET.bea, creator.jar);
  assert.equal(w.one('SELECT owner_proof FROM characters WHERE id = ?', CID(5000)).owner_proof, 'bnet');
  assert.deepEqual(scans(legacy.mark), [], 'legacy stamping');
  w.raw.person(PID(2), G, {});
  w.raw.character(CID(2), G, PID(2), 'Dunmar', { isMain: 1 });
  w.raw.roster(G, 'Dunmar', 4);
  w.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar']);
  w.advance(1000);
  const joined = await bnetSignIn(w, BNET.ann, created.jar);
  assert.equal(w.count('person_joins'), 1, 'a join');
  assert.deepEqual(scans(joined.mark), [], 'join');
  measured.explainJoin = joined.statements;
});

// ---------------------------------------------------------------------------
// Races

check('two concurrent sign-ins of one account: the guards turn the second person / link / character into a no-op, no duplicate, no 500', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const { userId, jar } = await makeAccount(w, BNET.ann);
  w.serve(['Aldric', 'Brindle']);
  // The first callback is about to write its person when a second sign-in of the same account (another tab) runs to the end.
  let armed = true;
  const batch = w.db.batch.bind(w.db);
  let nested = null;
  w.db.batch = async (statements) => {
    if (armed && statements.some((statement) => /INSERT INTO players/.test(statement.sql))) {
      armed = false;
      nested = await bnetSignIn(w, BNET.ann, {});
    }
    return batch(statements);
  };
  const first = await bnetSignIn(w, BNET.ann, jar);
  w.db.batch = batch;
  assert.equal(locationOf(first.callback), '/#/', 'the sign-in still succeeded');
  assert(nested, 'the second sign-in ran in between');
  assert.equal(w.count('players', 'user_id = ?', userId), 1, 'one person');
  assert.equal(w.count('characters'), 2, 'no duplicate character');
  assert.equal(w.count('audit_log', "action = 'person.match_create'"), 1, 'one audit row: only the create that happened');
  assert.deepEqual(w.logs.filter((line) => /failed/.test(line)), []);

  // The same with a second sign-in that LINKS an unowned person.
  const w2 = await makeWorld();
  const G2 = w2.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const acct2 = await makeAccount(w2, BNET.bea);
  w2.raw.person(PID(1), G2, {});
  w2.raw.character(CID(1), G2, PID(1), 'Aldric', { isMain: 1 });
  w2.serve(['Aldric', 'Brindle']);
  let again = true;
  const batch2 = w2.db.batch.bind(w2.db);
  w2.db.batch = async (statements) => {
    if (again && statements.some((statement) => /UPDATE players SET user_id/.test(statement.sql))) {
      again = false;
      await bnetSignIn(w2, BNET.bea, {});
    }
    return batch2(statements);
  };
  const second = await bnetSignIn(w2, BNET.bea, acct2.jar);
  w2.db.batch = batch2;
  assert.equal(locationOf(second.callback), '/#/');
  assert.equal(w2.count('players', 'user_id = ?', acct2.userId), 1);
  assert.equal(w2.count('characters', "name = 'Brindle'"), 1, 'no duplicate character');
  assert.equal(w2.count('audit_log', "action = 'person.match_link'"), 1, 'the audit row exists once: only the link that happened');
  void G;
});

check('a unique violation inside the match (a character with the same name made after the read) rolls that batch back, is logged as a race, never reaches the sign-in, and the next sign-in finds the collision', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const { userId, jar } = await makeAccount(w, BNET.ann);
  w.serve(['Aldric', 'Brindle']);
  let armed = true;
  const batch = w.db.batch.bind(w.db);
  w.db.batch = async (statements) => {
    if (armed && statements.some((statement) => /INSERT INTO players/.test(statement.sql))) {
      armed = false;
      // An officer typed Brindle in, on a person of its own, between the read and the write.
      w.raw.person(PID(7), G, {});
      w.raw.character(CID(7), G, PID(7), 'Brindle', { key: false, isMain: 1 });
    }
    return batch(statements);
  };
  const before = dump(w);
  const result = await bnetSignIn(w, BNET.ann, jar);
  w.db.batch = batch;
  assert.equal(locationOf(result.callback), '/#/', 'no 500: the sign-in stands');
  assert(logged(w, 'race'));
  assert.equal(w.count('players', 'user_id = ?', userId), 0, 'nothing of the failed batch is left: no person, no Aldric');
  assert.equal(w.count('characters', "name = 'Aldric'"), 0);
  assert.notEqual(dump(w), before, 'only the typed-in character (the other side of the race)');
  w.logs.length = 0;
  await bnetSignIn(w, BNET.ann, jar);
  assert(!logged(w, 'collision'), 'the next sign-in meets the typed-in Brindle and binds the key onto it (the name collision of part 2b)');
  assert.equal(w.count('players', 'user_id = ?', userId), 1, 'the typed-in Brindle sat on an unowned person: it is linked to the account');
  const person = personOf(w, userId, G);
  assert.equal(person.id, PID(7));
  assert.deepEqual(names(charactersOf(w, person.id)), ['Aldric', 'Brindle'], 'with the character that was free');
  assert.equal(w.one('SELECT blizzard_char_id, owner_proof FROM characters WHERE id = ?', CID(7)).blizzard_char_id, idOf('Brindle'));
});

check('a character that somebody else bound to the roster key first (an officer\'s Match to roster) is not created twice: characters_identity stays unique', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const { userId, jar } = await makeAccount(w, BNET.ann);
  w.raw.person(PID(1), G, { userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  w.serve(['Aldric', 'Brindle']);
  let armed = true;
  const batch = w.db.batch.bind(w.db);
  w.db.batch = async (statements) => {
    if (armed && statements.some((statement) => /INSERT INTO characters/.test(statement.sql))) {
      armed = false;
      w.raw.person(PID(2), G, {});
      w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
    }
    return batch(statements);
  };
  const result = await bnetSignIn(w, BNET.ann, jar);
  w.db.batch = batch;
  assert.equal(locationOf(result.callback), '/#/');
  assert.equal(w.count('characters', "name = 'Brindle'"), 1);
  assert.equal(w.one("SELECT player_id FROM characters WHERE name = 'Brindle'").player_id, PID(2), 'the other one\'s stays where it is');
  assert.deepEqual(w.logs.filter((line) => /failed/.test(line)), []);
});

// ---------------------------------------------------------------------------
// The seams and the lean join

// The block tombstones (lane B7a) are matched inside the callback: the tombstone statements go first in the guild's batch, so the person create / link, guarded by
// notBlocked, does nothing on a hit. Blocked account A, its account deleted, the same Battle.net account and roster character on a NEW account. `removePerson`:
// Delete my data also deletes the guild's rows of A (the person is gone) or leaves them unowned (the new account would link to the old person).
async function blockedAccountComesBack(removePerson) {
  const { tombstoneMatchStatements } = await load('worker/block-tombstones.js');
  assert.equal(typeof tombstoneMatchStatements, 'function', 'the real tombstone match, not a seam stub');
  const w = await makeWorld();
  w.env.TOMBSTONE_KEY = 'test-tombstone-key-0123456789abcdef';
  const G = w.ingame(1, [['Aldric', 3], ['Galdor', 2]]);
  // The officer: a Discord account with a person on the roster and the Officer role.
  const officerJar = await discordSignIn(w, DISCORD.eve);
  const officerId = w.one('SELECT id FROM users WHERE discord_id = ?', DISCORD.eve.id).id;
  w.raw.person(PID(9), G, { userId: officerId });
  w.raw.character(CID(9), G, PID(9), 'Galdor', { isMain: 1 });
  w.run("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at) VALUES ('ra_officer', ?, ?, 'officer', NULL, NULL, 1)", G, officerId);

  // Account A signs in with its Battle.net account: a person and a Battle.net-proven Aldric.
  w.serve(['Aldric']);
  const first = await bnetSignIn(w, BNET.ann);
  const oldUserId = userOf(w, BNET.ann);
  assert(personOf(w, oldUserId, G), 'A is a member');
  assert.equal(charactersOf(w, personOf(w, oldUserId, G).id)[0].proof_bnet_account_id, BNET.ann.id);

  // The officer blocks A: tombstones for its Battle.net id and the identity key of Aldric.
  assert.equal((await w.call(officerJar, 'POST', `/api/guild/${G}/people/${oldUserId}/block`, {})).status, 200);
  assert.equal(w.count('block_tombstones', 'guild_id = ?', G), 2, 'a tombstone for the Battle.net id and one for the identity key');
  assert.equal((await w.call(first.jar, 'GET', `/api/guild/${G}`)).json.error, 'access_removed');

  // Delete my data: the account row goes (and its block row), the tombstones stay.
  assert.equal((await w.call(first.jar, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.equal(w.count('users', 'id = ?', oldUserId), 0, 'the account is gone');
  assert.equal(w.count('guild_blocks'), 0, 'and its block row with it');
  assert.equal(w.count('block_tombstones', 'guild_id = ?', G), 2, 'the tombstones stayed');
  if (removePerson) {
    w.run('DELETE FROM characters WHERE name = ?', 'Aldric');
    w.run('DELETE FROM players WHERE guild_id = ? AND id != ?', G, PID(9));
  }
  const charactersBefore = w.count('characters');
  const playersBefore = w.count('players');

  // A NEW account signs in with the SAME Battle.net account and the same roster character.
  w.logs.length = 0;
  const again = await bnetSignIn(w, BNET.ann);
  const newUserId = userOf(w, BNET.ann);
  assert.notEqual(newUserId, oldUserId, 'a new account');
  const block = w.one('SELECT * FROM guild_blocks WHERE guild_id = ? AND user_id = ?', G, newUserId);
  assert.deepEqual([block.blocked_by, block.pending_review, block.tombstone_missing, block.reason], [null, 1, 0, 'Matched an earlier block of the same person']);
  assert.equal(w.count('players', 'user_id = ?', newUserId), 0, 'no person linked to the new account');
  assert.equal(w.count('characters', 'proof_user_id = ?', newUserId), 0, 'no character proven for it');
  assert.equal(w.count('players'), playersBefore, 'no person created');
  assert.equal(w.count('characters'), charactersBefore, 'no character created');
  assert.equal(w.count('characters', "name = 'Aldric'"), removePerson ? 0 : 1);
  const route = await w.call(again.jar, 'GET', `/api/guild/${G}`);
  assert.deepEqual([route.status, route.json.error], [403, 'access_removed'], 'a pending block enforces');
  const audit = w.one("SELECT actor_user_id, entity_id, after FROM audit_log WHERE action = 'block.match'");
  assert.deepEqual([audit.actor_user_id, audit.entity_id, JSON.parse(audit.after)], [null, newUserId, { refs: 1, kinds: ['bnet', 'idkey'] }]);
  assert.deepEqual(w.logs.filter((line) => /failed/.test(line)), []);
  // The sign-in itself held: the new Battle.net link exists, and the statements stay inside the budget (the tombstone hit reads up to 6).
  assert.equal(w.count('bnet_links', 'user_id = ?', newUserId), 1);
  const { CALLBACK_STATEMENT_BUDGET } = await load('worker/bnet-match.js');
  assert(again.statements <= CALLBACK_STATEMENT_BUDGET, `${again.statements} statements`);
}

check('the lane B7 tombstone match: a blocked account that deletes its data and signs in again as a new account with the same Battle.net account and roster character gets a pending-review block, no person, no character, 403 access_removed and a block.match audit row (its old person left unowned)', async () => {
  await blockedAccountComesBack(false);
});

check('the lane B7 tombstone match: the same when Delete my data removed the person and its character too - the new account creates nothing', async () => {
  await blockedAccountComesBack(true);
});

check('a lean join leaves the tables the loser has nothing in out, ends in the same state as the full join, and a row that appears after the count makes the batch a no-op', async () => {
  const { joinPersonsStatements } = await load('worker/person-join.js');
  const build = async () => {
    const w = await makeWorld();
    const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
    w.raw.user(UID(1));
    w.raw.person(PID(1), G, { userId: UID(1), created: 1 });
    w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
    w.raw.person(PID(2), G, { created: 2, joined: '2025-01-01' });
    w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
    w.raw.away('an_' + pad(1), G, PID(2));
    return { w, G };
  };
  const plan = async (w, G, lean) => joinPersonsStatements(w.db, { guildId: G, aId: PID(1), bId: PID(2), actorUserId: UID(1), now: T0, reason: 'bnet', randomBytes: w.randomBytes, lean });
  const state = (w) => JSON.stringify(['players', 'characters', 'away_notices', 'person_joins'].map((table) => w.rows(`SELECT * FROM ${table} ORDER BY 1, 2`)).map((rows) => rows.map((row) => ({ ...row, id: undefined, created_at: undefined }))));
  const full = await build();
  const fullPlan = await plan(full.w, full.G, false);
  await full.w.db.batch(fullPlan.statements);
  const lean = await build();
  const leanPlan = await plan(lean.w, lean.G, true);
  assert(leanPlan.statements.length < fullPlan.statements.length - 15, `${leanPlan.statements.length} statements against ${fullPlan.statements.length}`);
  assert(leanPlan.skippedTables.includes('attendance') && !leanPlan.skippedTables.includes('away_notices'));
  assert.deepEqual(fullPlan.counts, leanPlan.counts);
  const results = await lean.w.db.batch(leanPlan.statements);
  assert.equal(results[leanPlan.appliedIndex].meta.changes, 1);
  assert.equal(results[leanPlan.deletedIndex].meta.changes, 1);
  const normal = (text) => text.replace(/"version":\d+/g, '').replace(/"updated_at":\d+/g, '');
  assert.equal(normal(state(lean.w)), normal(state(full.w)), 'the same end state');
  measured.leanJoinStatements = leanPlan.statements.length;
  measured.fullJoinStatements = fullPlan.statements.length;

  // A row that appears in a skipped table between the count and the batch: the whole batch is a no-op.
  const racy = await build();
  const racyPlan = await plan(racy.w, racy.G, true);
  racy.w.run("INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, created_at) VALUES (?, ?, 'review', 'Raider', 9, 1)", racy.G, PID(2));
  const before = state(racy.w);
  const refused = await racy.w.db.batch(racyPlan.statements);
  assert.equal(refused[racyPlan.appliedIndex].meta.changes, 0, 'the guard refused it');
  assert.equal(state(racy.w), before, 'and every statement was a no-op');
  assert.equal(racy.w.count('players', 'id = ?', PID(2)), 1, 'the loser is still there');
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
      console.log(String(error && error.stack || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    } finally {
      await closeWorlds();
    }
  }
  if (Object.keys(measured).length) console.log(`measured statements: ${JSON.stringify(measured)}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((error) => { console.error(error); process.exit(1); });
