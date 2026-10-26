/**
 * Raidsmith guild tracker - the security-review fixes of the user-hierarchy lanes B4b, B5, B6a and B7a (guild/hier-b6a-fix)
 * Run: node tests/guild/guild-hier-review-fixes-tests.js [name filter]
 *
 * Every check here FAILS on guild/hier-b6a 1f533a0 (the code the reviews read) and passes after the fix. The findings are those of tasks/todo.md "SECURITY REVIEWS 2026-10-26":
 *   F1  an Officer blocks an account-less person, the person's character is matched to the GM's roster key, the GM's Battle.net sign-in joins the person into the GM
 *       and the join copies the block onto the GM's account: a person with a person_blocks row is never joined by the sign-in match, and the officer join carries a
 *       block onto an account only when the actor strictly outranks it
 *   F2  the sign-in match ignored person_blocks: a matched holder with one is a tombstone hit (same held rules), nothing is linked or joined
 *   F3  the Battle.net link and sign-in callbacks now run the tombstone match too (legacy and manual guilds), inside the statement budget
 *   F4  a tombstone hit in the guild's batch leaves the pending account's existing person untouched
 *   F10 Delete my data turns the block of an account with a person into a person_blocks marker on that person
 *   F7  statement budgets: the sign-in match counts its tombstone reads before they run, the officer join, the daily cron's repair and failure flush are capped
 *   F5/F9 Match to roster, F6 unblock, B4b F4 the rank-map PUT, and migration 0036 follow in their own sections.
 * Two harnesses: the Battle.net world of guild-b6a-match-tests.js (raw fixtures + the fake Battle.net) and the guild scenario of tests/guild-b3-world.js.
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
const TOMBSTONE_KEY = 'test-tombstone-key-0123456789abcdef';
const BNET = {
  ann: { id: '710000001', battletag: 'Ann#1001' },
  bea: { id: '710000002', battletag: 'Bea#1002' },
  cat: { id: '710000003', battletag: 'Cat#1003' },
};
const DISCORD = {
  eve: { id: '120000000000000005', username: 'eve', globalName: 'Eve E' },
  fay: { id: '120000000000000006', username: 'fay', globalName: 'Fay F' },
};
// The fake's TBC list (tools/fake-battlenet.js): [name, class id, level, realm index]; ids 7000 + position in ALL; realm ids 4001 / 4002.
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

const pad = (n) => String(n).padStart(22, '0');
const GID = (n) => `g_${pad(n)}`;
const PID = (n) => `p_${pad(n)}`;
const CID = (n) => `c_${pad(n)}`;
const UID = (n) => `u_${pad(n)}`;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const openWorlds = [];

// ---------------------------------------------------------------------------
// The Battle.net world (the harness of guild-b6a-match-tests.js, plus roles, person blocks, audit snapshots and tombstones)

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
    TOMBSTONE_KEY,
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
    serve(names) { bnet.state.data.tbc = ALL.map((row) => (names.includes(row[0]) ? row.slice() : ['Filler', 6, 70, row[3]])); },
    mark: () => db.statementLog.length,
    since: (mark) => db.statementLog.slice(mark),
  };
  const raw = {
    guild(id, { source = 'ingame', version = 'tbc', region = 'US', realm = 'Dreamscythe', zone = 'America/New_York', server = null } = {}) {
      run(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source)
           VALUES (?, ?, ?, 'realm', ?, ?, ?, ?, 1, ?)`, id, `Guild ${id.slice(-3)}`, realm, region, server || `none:${id}`, zone, version, source);
    },
    user(id, { discordId = null } = {}) {
      run('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)', id, id, discordId, id);
    },
    person(id, guildId, { userId = null, discordUserId = null, created = 1, joined = '2026-01-01' } = {}) {
      run("INSERT INTO players (id, guild_id, status, user_id, discord_user_id, joined_on, created_at, updated_at) VALUES (?, ?, 'raider', ?, ?, ?, ?, ?)",
        id, guildId, userId, discordUserId, joined, created, created);
    },
    character(id, guildId, personId, name, { key = true, isMain = 0, coreRank = 'raider', proof = 'officer', proofUser = null, proofBnet = null, proofAt = null } = {}) {
      const row = rowOfName(name);
      const realm = row ? REALM_NAME[row[3]] : 'Dreamscythe';
      run(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on,
                                    owner_proof, proof_user_id, proof_bnet_account_id, proof_at, namespace, blizzard_realm_id, blizzard_char_id)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      id, guildId, personId, name, name.toLowerCase(), realm, realm.toLowerCase(), row ? CLASS_OF[row[1]] : 'MAGE', isMain, coreRank, proof, proofUser, proofBnet, proofAt,
      key && row ? NS : null, key && row ? REALM_ID[row[3]] : null, key && row ? idOf(name) : null);
    },
    roster(guildId, name, rank) {
      const row = rowOfName(name);
      run(`INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, guildId, NS, REALM_ID[row[3]], idOf(name), name, name.toLowerCase(), REALM_NAME[row[3]].toLowerCase(), CLASS_OF[row[1]], row[2], rank);
    },
    rankMap(guildId) {
      for (let rank = 0; rank < 10; rank++) {
        run("INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank) VALUES (?, 'ingame', ?, ?, ?)", guildId, String(rank), `Rank ${rank}`,
          rank === 9 ? 'social' : rank === 8 ? 'trial' : 'raider');
      }
    },
    role(userId, guildId, roleId) {
      run("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?, NULL, NULL, 1)",
        `ra_${userId}_${roleId}`, guildId, userId, roleId);
    },
    personBlock(guildId, playerId, blockedBy, reason = null) {
      run('INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, tombstone_missing, created_at) VALUES (?, ?, ?, ?, 0, 5)', guildId, playerId, blockedBy, reason);
    },
    // The audit row whose actor_role snapshot says who made a block (worker/block-tombstones.js blockerRankOf).
    snapshot(guildId, action, entityId, role) {
      run("INSERT INTO audit_log (id, guild_id, actor_user_id, action, entity_type, entity_id, created_at, actor_short_id, actor_role) VALUES (?, ?, NULL, ?, 'x', ?, 2, 'abcdefgh', ?)",
        `al_snap_${action}_${entityId}`.slice(0, 40), guildId, action, entityId, role);
    },
  };
  world.raw = raw;
  world.ingame = (n, rosterRows = [], opts = {}) => {
    raw.guild(GID(n), { source: 'ingame', ...opts });
    raw.rankMap(GID(n));
    for (const [name, rank] of rosterRows) raw.roster(GID(n), name, rank);
    return GID(n);
  };
  // A tombstone under `ref` for a typed value of the guild (bnet:<id>, discord:<id>, idkey:<ns>:<realm>:<char>).
  world.tombstone = async (guildId, typed, ref = 'u:u_gone') => {
    const { tombstoneHmac } = await load('worker/block-tombstones.js');
    run('INSERT OR IGNORE INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at) VALUES (?, ?, 1, ?, 3)', guildId, ref, await tombstoneHmac(TOMBSTONE_KEY, guildId, typed));
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

async function bnetSignIn(world, account, jar = {}) {
  world.bnet.state.account = account;
  const login = await world.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const mark = world.mark();
  const callback = await world.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(stateOf(login))}`, { jar });
  assert.equal(locationOf(callback), '/#/', 'the sign-in worked');
  return { jar, callback, statements: world.since(mark).length, mark };
}

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

const userOf = (world, account) => world.one('SELECT user_id FROM bnet_links WHERE bnet_account_id = ?', account.id).user_id;

// A Battle.net account that exists and has no character on any roster: -> its user id and jar.
async function makeAccount(world, account) {
  world.serve([]);
  const signed = await bnetSignIn(world, account);
  return { userId: userOf(world, account), jar: signed.jar };
}

const blockOf = (world, guildId, userId) => world.one('SELECT * FROM guild_blocks WHERE guild_id = ? AND user_id = ?', guildId, userId);
const personOf = (world, userId, guildId) => world.one('SELECT * FROM players WHERE user_id = ? AND guild_id = ?', userId, guildId);

// A VALID Battle.net-proven character for the account on the guild's stored roster (lane B6b: the effective-roles view derives the Owner's liveness and the derived roles from
// exactly this): a person linked to the account, its character 'Extra01' proven by the account's Battle.net link, on the roster at in-game rank `rank`.
function proveOnRoster(world, guildId, userId, account, rank, n = 91) {
  world.raw.person(PID(n), guildId, { userId });
  world.raw.character(CID(n), guildId, PID(n), 'Extra01', { isMain: 1, proof: 'bnet', proofUser: userId, proofBnet: account.id, proofAt: 1 });
  world.raw.roster(guildId, 'Extra01', rank);
}

// The blocked person of the reviews: an account-less person P whose character carries an officer-attested roster key, blocked by an Officer.
// blockerRole: the actor_role snapshot of the audit row that wrote the person block.
function blockedPerson(world, guildId, { pid = PID(1), cid = CID(1), name = 'Aldric', blockerRole = 'officer', reason = 'Stole loot' } = {}) {
  const blocker = UID(90);
  if (!world.one('SELECT 1 FROM users WHERE id = ?', blocker)) world.raw.user(blocker);
  world.raw.person(pid, guildId, {});
  world.raw.character(cid, guildId, pid, name, { isMain: 1 });
  world.raw.personBlock(guildId, pid, blocker, reason);
  world.raw.snapshot(guildId, 'person.block', pid, blockerRole);
  return { pid, cid, blocker };
}

// ---------------------------------------------------------------------------
// F2 / F1: the sign-in match and a matched person with a person block

check('F2: a Battle.net sign-in whose roster key sits on a BLOCKED account-less person links nothing: a plain account gets a pending-review block, the person stays unowned and blocked', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 3], ['Brindle', 5]]);
  const P = blockedPerson(w, G);
  w.serve(['Aldric']);
  w.logs.length = 0;
  const { jar } = await bnetSignIn(w, BNET.ann);
  const userId = userOf(w, BNET.ann);

  assert.equal(w.count('players', 'user_id = ?', userId), 0, 'no person is linked to the account');
  assert.equal(w.one('SELECT user_id FROM players WHERE id = ?', P.pid).user_id, null, 'the person stays unowned');
  assert.equal(w.count('person_blocks', 'player_id = ?', P.pid), 1, 'and blocked');
  assert.equal(w.count('players', 'guild_id = ?', G), 1, 'no person was created either');
  assert.equal(w.count('characters', 'proof_user_id = ?', userId), 0, 'nothing is proven for the account');
  const block = blockOf(w, G, userId);
  assert(block, 'a tombstone-style block for review');
  assert.deepEqual([block.blocked_by, block.pending_review, block.reason], [null, 1, 'Matched an earlier block of the same person']);
  const audit = w.one("SELECT actor_user_id, entity_id, after FROM audit_log WHERE action = 'block.match'");
  assert.deepEqual([audit.actor_user_id, audit.entity_id, JSON.parse(audit.after)], [null, userId, { refs: 1, kinds: ['person'] }]);
  assert.deepEqual([(await w.call(jar, 'GET', `/api/guild/${G}`)).status], [403], 'the pending block enforces');
  assert.equal(w.count('person_joins'), 0);
});

check('F2/F1 held rules: the Owner, a Guild Master by role and an account equal or senior to the blocker are NOT blocked and join nothing - one block.match_held item, no guild_blocks row', async () => {
  const cases = [
    // The Owner is LIVE (a proven character on the stored roster): a suspended Owner is blockable (U R4-Q3), a live one is held back.
    { name: 'owner', prepare: (w, G, userId) => { proveOnRoster(w, G, userId, BNET.ann, 6); w.run('UPDATE guilds SET owner_user_id = ? WHERE id = ?', userId, G); }, reason: 'owner' },
    // A Guild Master by role who does not hold the seat: DERIVED (in-game rank 0 maps to Guild Master, the account's proven character is on rank 0); the seat is another account's.
    { name: 'gm', prepare: (w, G, userId) => {
      w.raw.user(UID(95)); w.run('UPDATE guilds SET owner_user_id = ? WHERE id = ?', UID(95), G);
      w.run("UPDATE source_rank_maps SET role_id = 'guild_master' WHERE guild_id = ? AND source_key = '0'", G);
      proveOnRoster(w, G, userId, BNET.ann, 0);
    }, reason: 'gm' },
    { name: 'officer equal to the Officer who blocked', prepare: (w, G, userId) => w.raw.role(userId, G, 'officer'), reason: 'senior' },
  ];
  for (const { name, prepare, reason } of cases) {
    const w = await makeWorld();
    const G = w.ingame(1, [['Aldric', 3], ['Brindle', 5]]);
    const P = blockedPerson(w, G, { blockerRole: 'officer' });
    const { userId, jar } = await makeAccount(w, BNET.ann);
    prepare(w, G, userId);
    w.serve(['Aldric', 'Brindle']);
    await bnetSignIn(w, BNET.ann, jar);
    assert.equal(blockOf(w, G, userId), null, `${name}: not blocked`);
    assert.equal(w.one('SELECT user_id FROM players WHERE id = ?', P.pid).user_id, null, `${name}: the blocked person is not linked`);
    assert.equal(w.count('person_blocks', 'player_id = ?', P.pid), 1, `${name}: still blocked`);
    const held = w.rows("SELECT entity_id, after FROM audit_log WHERE action = 'block.match_held'");
    assert.equal(held.length, 1, `${name}: one review item`);
    assert.deepEqual([held[0].entity_id, JSON.parse(held[0].after).reason], [userId, reason], name);
    // The account itself still becomes a member through its free character (Brindle), so a held account is not shut out of its own guild.
    const mine = personOf(w, userId, G);
    assert(mine && mine.id !== P.pid, `${name}: its own person`);
    assert.equal(w.count('characters', 'player_id = ?', P.pid), 1, `${name}: the blocked person's characters stay`);
    // A second sign-in the same day adds no second item.
    w.advance(1000);
    await bnetSignIn(w, BNET.ann, jar);
    assert.equal(w.count('audit_log', "action = 'block.match_held'"), 1, `${name}: once a day`);
  }
});

check('F1: the auto join - a Battle.net sign-in whose own person and a BLOCKED person hold matched keys joins nothing and copies no block onto the account (the GM-tier account is held, a plain account is blocked for review)', async () => {
  for (const tier of ['gm', 'plain']) {
    const w = await makeWorld();
    const G = w.ingame(1, [['Aldric', 0], ['Brindle', 5]]);
    const { userId, jar } = await makeAccount(w, BNET.ann);
    w.raw.person(PID(2), G, { userId });
    w.raw.character(CID(2), G, PID(2), 'Brindle', { isMain: 1 });
    const P = blockedPerson(w, G); // holds Aldric's key (the GM's roster key, as Match to roster gave it)
    if (tier === 'gm') {
      // A DERIVED Guild Master: its proven character 'Extra01' sits on in-game rank 0, which the map gives Guild Master.
      w.run("UPDATE source_rank_maps SET role_id = 'guild_master' WHERE guild_id = ? AND source_key = '0'", G);
      w.raw.character(CID(91), G, PID(2), 'Extra01', { isMain: 0, proof: 'bnet', proofUser: userId, proofBnet: BNET.ann.id, proofAt: 1 });
      w.raw.roster(G, 'Extra01', 0);
    }
    w.serve(['Aldric', 'Brindle']);
    w.logs.length = 0;
    await bnetSignIn(w, BNET.ann, jar);
    assert.equal(w.count('person_joins'), 0, `${tier}: no join`);
    assert.equal(w.count('players', 'id = ?', P.pid), 1, `${tier}: the blocked person is still there`);
    assert.equal(w.count('person_blocks', 'player_id = ?', P.pid), 1, `${tier}: and still blocked`);
    const block = blockOf(w, G, userId);
    if (tier === 'gm') {
      assert.equal(block, null, 'the Guild Master account carries no block');
      assert.equal(w.count('audit_log', "action = 'block.match_held'"), 1);
      assert.equal((await w.call(jar, 'GET', `/api/guild/${G}`)).status, 200, 'and still gets in');
    } else {
      assert.deepEqual([block.blocked_by, block.pending_review], [null, 1]);
    }
  }
});

check('F1/F2: a blocked person is never a join or link candidate even when it is the ONLY holder: the guards of the join statement and of the link refuse it too (a block that appears after the read)', async () => {
  const { joinPersonsStatements } = await load('worker/person-join.js');
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  w.raw.user(UID(1));
  w.raw.person(PID(1), G, { userId: UID(1), created: 1 });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  const P = blockedPerson(w, G, { pid: PID(2), cid: CID(2), name: 'Brindle' });
  // The module itself: the sign-in match (reason 'bnet') never joins a person that holds a block - it refuses before building anything.
  await assert.rejects(
    joinPersonsStatements(w.db, { guildId: G, aId: PID(1), bId: P.pid, actorUserId: UID(1), now: T0, reason: 'bnet', randomBytes: w.randomBytes, lean: true }),
    (error) => error.status === 409 && error.code === 'join_blocked_person',
  );
});

check('F4: a tombstone hit in the guild\'s batch leaves the pending account\'s EXISTING person untouched - no character created, no proof stamped', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Brindle', 2], ['Cassia', 3]]);
  const { userId, jar } = await makeAccount(w, BNET.ann);
  w.raw.person(PID(1), G, { userId });
  w.raw.character(CID(1), G, PID(1), 'Brindle', { isMain: 1 });
  await w.tombstone(G, `bnet:${BNET.ann.id}`);
  const charactersBefore = JSON.stringify(w.rows('SELECT * FROM characters ORDER BY id'));
  const playersBefore = JSON.stringify(w.rows('SELECT * FROM players ORDER BY id'));
  w.serve(['Brindle', 'Cassia']);
  await bnetSignIn(w, BNET.ann, jar);
  const block = blockOf(w, G, userId);
  assert.deepEqual([block.blocked_by, block.pending_review], [null, 1], 'the tombstone hit blocked the account for review');
  assert.equal(JSON.stringify(w.rows('SELECT * FROM characters ORDER BY id')), charactersBefore, 'no character was created and no proof stamped');
  assert.equal(JSON.stringify(w.rows('SELECT * FROM players ORDER BY id')), playersBefore, 'the person is as it was');
});

// ---------------------------------------------------------------------------
// F10: Delete my data

check('F10: Delete my data turns the block of an account that has a person into a person_blocks marker (blocked_by, reason and the blocker\'s rank snapshot copied); a new account owning the officer-attested keys is then blocked, not linked', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 3], ['Brindle', 5]]);
  const G2 = w.ingame(2, [['Aldric', 3]]);
  const eveJar = await discordSignIn(w, DISCORD.eve);
  const eve = w.one('SELECT id FROM users WHERE discord_id = ?', DISCORD.eve.id).id;
  const gm = UID(91);
  w.raw.user(gm);
  w.raw.role(gm, G, 'guild_master');
  // Eve's person in G (officer-attested key of Aldric) is blocked by the Guild Master; in G2 she has a person too, but is not blocked.
  w.raw.person(PID(1), G, { userId: eve });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1 });
  w.raw.person(PID(2), G2, { userId: eve });
  w.raw.character(CID(2), G2, PID(2), 'Aldric', { isMain: 1 });
  w.run("INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES (?, ?, ?, 'Loot drama', 7)", G, eve, gm);
  w.raw.snapshot(G, 'access.remove', eve, 'guild_master');
  // A block with no person (G3) leaves no marker.
  const G3 = w.ingame(3, []);
  w.run("INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES (?, ?, ?, NULL, 8)", G3, eve, gm);

  assert.equal((await w.call(eveJar, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  assert.equal(w.count('users', 'id = ?', eve), 0, 'the account is gone');
  assert.equal(w.count('guild_blocks'), 0, 'and its block rows');
  const marker = w.one('SELECT * FROM person_blocks WHERE guild_id = ? AND player_id = ?', G, PID(1));
  assert(marker, 'the person carries the block now');
  assert.deepEqual([marker.blocked_by, marker.reason], [gm, 'Loot drama']);
  assert.equal(w.count('person_blocks'), 1, 'only where the account was blocked AND had a person');
  assert.equal(w.one('SELECT user_id FROM players WHERE id = ?', PID(1)).user_id, null, 'the person stays on the roster, unowned');
  const trail = w.one("SELECT actor_user_id, actor_role, after FROM audit_log WHERE action = 'person.block' AND entity_id = ?", PID(1));
  assert.deepEqual([trail.actor_user_id, trail.actor_role], [gm, 'guild_master'], 'the audit row keeps who blocked and their rank');

  // A NEW account (an Officer of the guild by hand role) owns the key: the Guild Master's block outranks it, so it is blocked for review and not linked.
  const { userId, jar } = await makeAccount(w, BNET.bea);
  w.raw.role(userId, G, 'officer');
  w.serve(['Aldric']);
  await bnetSignIn(w, BNET.bea, jar);
  assert.equal(w.count('players', 'guild_id = ? AND user_id = ?', G, userId), 0, 'not linked to the old person');
  const pending = blockOf(w, G, userId);
  assert(pending && pending.pending_review === 1 && pending.blocked_by === null, 'blocked for review');
  assert.equal(w.count('guild_blocks', 'guild_id = ? AND user_id = ?', G2, userId), 0, 'the guild where the account was not blocked links the new account as before');
  assert(personOf(w, userId, G2), 'linked in the other guild');
});

// ---------------------------------------------------------------------------
// F3 / F7: the tombstone match in the Battle.net callbacks, and the budget

check('F3: a Battle.net LINK callback runs the tombstone match for the guilds the account reaches that are not in-game guilds (legacy and manual): a Battle.net tombstone blocks the account there', async () => {
  const w = await makeWorld();
  const SERVER = '910000000000000001';
  w.raw.guild(GID(1), { source: null, server: SERVER });
  w.raw.guild(GID(2), { source: 'manual', server: '910000000000000002' });
  const jar = await discordSignIn(w, DISCORD.eve);
  const eve = w.one('SELECT id FROM users WHERE discord_id = ?', DISCORD.eve.id).id;
  for (const [guild, server] of [[GID(1), SERVER], [GID(2), '910000000000000002']]) {
    w.run('INSERT INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, 1)', eve, server);
    await w.tombstone(guild, `bnet:${BNET.ann.id}`);
  }
  w.serve([]);
  const link = await bnetLink(w, jar, BNET.ann);
  assert.equal(locationOf(link.callback), '/#/characters', 'the link worked');
  for (const guild of [GID(1), GID(2)]) {
    const block = blockOf(w, guild, eve);
    assert(block, `${guild}: blocked for review`);
    assert.deepEqual([block.blocked_by, block.pending_review], [null, 1]);
  }
  assert.equal(w.count('audit_log', "action = 'block.match'"), 2);
});

check('F3: the same on a Battle.net SIGN-IN (an existing account with a person in a legacy guild)', async () => {
  const w = await makeWorld();
  w.raw.guild(GID(1), { source: null });
  const { userId, jar } = await makeAccount(w, BNET.ann);
  w.raw.person(PID(1), GID(1), { userId });
  w.raw.character(CID(1), GID(1), PID(1), 'Aldric', { isMain: 1, key: false });
  await w.tombstone(GID(1), `bnet:${BNET.ann.id}`);
  w.serve(['Aldric']);
  await bnetSignIn(w, BNET.ann, jar);
  const block = blockOf(w, GID(1), userId);
  assert(block, 'blocked for review');
  assert.deepEqual([block.blocked_by, block.pending_review], [null, 1]);
});

check('F7: the sign-in match counts its tombstone reads BEFORE they run - 20 in-game guilds that all have tombstones keep the callback at or under 45 statements, the rest are deferred (`bnet match deferred: budget`)', async () => {
  const { CALLBACK_STATEMENT_BUDGET } = await load('worker/bnet-match.js');
  const w = await makeWorld();
  for (let n = 1; n <= 20; n++) {
    w.ingame(n, [['Aldric', 3], ['Brindle', 5]]);
    await w.tombstone(GID(n), 'discord:999000000000000001', 'u:u_elsewhere'); // a tombstone that does not match: the guild has tombstones, the account no hit
  }
  w.serve(['Aldric', 'Brindle']);
  w.logs.length = 0;
  const first = await bnetSignIn(w, BNET.ann);
  assert(first.statements <= CALLBACK_STATEMENT_BUDGET, `${first.statements} statements`);
  console.log(`      measured: sign-in over 20 in-game guilds with tombstones ${first.statements} statements`);
  const userId = userOf(w, BNET.ann);
  const made = w.count('players', 'user_id = ?', userId);
  assert(made >= 1 && made < 20, `${made} guilds were handled, the rest deferred`);
  assert(w.logs.includes('bnet match deferred: budget'), w.logs.join('|'));
  // The next sign-ins finish the job, each inside the budget.
  for (let i = 0; i < 8 && w.count('players', 'user_id = ?', userId) < 20; i++) {
    w.advance(1000);
    const again = await bnetSignIn(w, BNET.ann, first.jar);
    assert(again.statements <= CALLBACK_STATEMENT_BUDGET, `sign-in ${i + 2}: ${again.statements} statements`);
  }
  assert.equal(w.count('players', 'user_id = ?', userId), 20, 'every guild got its person in the end');
});

check('F3/F7: the tombstone pass of a link callback takes what the match left of the 45 statements: many legacy guilds are handled a few at a time (`bnet match deferred: budget`)', async () => {
  const { CALLBACK_STATEMENT_BUDGET } = await load('worker/bnet-match.js');
  const w = await makeWorld();
  const jar = await discordSignIn(w, DISCORD.eve);
  const eve = w.one('SELECT id FROM users WHERE discord_id = ?', DISCORD.eve.id).id;
  for (let n = 1; n <= 12; n++) {
    const server = `91000000000000${String(n).padStart(4, '0')}`;
    w.raw.guild(GID(n), { source: null, server });
    w.run('INSERT INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, 1)', eve, server);
    await w.tombstone(GID(n), `bnet:${BNET.ann.id}`);
  }
  w.serve([]);
  w.logs.length = 0;
  const link = await bnetLink(w, jar, BNET.ann);
  assert(link.statements <= CALLBACK_STATEMENT_BUDGET, `${link.statements} statements`);
  console.log(`      measured: link callback over 12 legacy guilds with tombstones ${link.statements} statements`);
  const blocked = w.count('guild_blocks', 'user_id = ?', eve);
  assert(blocked >= 2 && blocked < 12, `${blocked} guilds were matched, the rest deferred`);
  assert(w.logs.includes('bnet match deferred: budget'), w.logs.join('|'));
  // The next link callback (re-verify) carries on with the guilds still unmatched.
  w.advance(1000);
  const again = await bnetLink(w, jar, BNET.ann);
  assert(again.statements <= CALLBACK_STATEMENT_BUDGET, `${again.statements} statements`);
  assert(w.count('guild_blocks', 'user_id = ?', eve) > blocked, 'the next callback matched more');
});

// ---------------------------------------------------------------------------
// The guild scenario (tests/guild-b3-world.js): officers, roster people, the routes

const { scenario, discord: scenarioDiscord } = require('../guild-b3-world');
const { signIn, memberOf } = require('../guild-world');
const { makeProven } = require('../guild-ingame');

const sOne = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).get(...values);
const sAll = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).all(...values);
const sRun = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).run(...values);
const versionsOf = (s, a, b) => ({ version: sOne(s, 'SELECT version FROM players WHERE id = ?', a).version, otherVersion: sOne(s, 'SELECT version FROM players WHERE id = ?', b).version });
const joinCall = (s, who, a, b) => s.call(who, 'POST', `/roster/${a}/join`, { otherPersonId: b, ...versionsOf(s, a, b) });
// The D1 statements a request ran.
async function measured(s, fn) {
  const mark = s.w.db.statementLog.length;
  const result = await fn();
  return { result, statements: s.w.db.statementLog.length - mark };
}

// ---- F1 (officer join): a person block is carried onto an account only by an actor who strictly outranks it

check('F1: the officer join carries a person block onto the survivor\'s account only when the actor is the Owner or strictly senior to it and the account is neither the Owner nor GM-tier; otherwise 409 join_blocked_person and nothing changes', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  const o1 = await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  const blockedPerson = async (name) => {
    const L = await s.person({ name });
    sRun(s, "INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, tombstone_missing, created_at) VALUES (?, ?, ?, 'Spam', 0, 5)", s.gid, L.pid, o1);
    return L;
  };
  const state = () => JSON.stringify([sAll(s, 'SELECT * FROM players ORDER BY id'), sAll(s, 'SELECT * FROM person_blocks ORDER BY player_id'), sAll(s, 'SELECT * FROM guild_blocks ORDER BY user_id')]);

  // The Officer joins a blocked person into its OWN person: the block would land on the Officer's own account.
  const mine = await s.person({ name: 'Ofcperson' });
  await s.link(mine.pid, 'o1');
  const L1 = await blockedPerson('Blockedaa');
  let before = state();
  let res = await joinCall(s, 'o1', L1.pid, mine.pid);
  assert.deepEqual([res.status, res.json && res.json.error], [409, 'join_blocked_person'], res.text);
  assert.equal(state(), before, 'nothing changed');

  // The Owner (the Guild Master) joins a blocked person into its own person: the Owner is never blocked.
  const gmPerson = await s.person({ name: 'Ownerperson' });
  await s.link(gmPerson.pid, 'gm');
  const L2 = await blockedPerson('Blockedbb');
  before = state();
  res = await joinCall(s, 'gm', L2.pid, gmPerson.pid);
  assert.deepEqual([res.status, res.json && res.json.error], [409, 'join_blocked_person'], res.text);
  assert.equal(state(), before);

  // The Officer joins a blocked person into a plain member's person: the Officer outranks the member, the block lands on the member's account.
  const memberPerson = await s.person({ name: 'Memberperson' });
  await s.link(memberPerson.pid, 'm1');
  res = await joinCall(s, 'o1', L1.pid, memberPerson.pid);
  assert.equal(res.status, 200, res.text);
  const carried = sOne(s, 'SELECT * FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, s.uids.m1);
  assert(carried, 'the block is on the member\'s account now');
  assert.deepEqual([carried.blocked_by, carried.reason], [o1, 'Spam']);
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM person_blocks WHERE player_id = ?', L1.pid).n, 0);

  // A person with no account at all keeps the block with the person (it moves to the survivor).
  const plain = await s.person({ name: 'Plainsurv' });
  sRun(s, 'UPDATE players SET created_at = 1 WHERE id = ?', plain.pid);
  const L3 = await blockedPerson('Blockedcc');
  res = await joinCall(s, 'o1', L3.pid, plain.pid);
  assert.equal(res.status, 200, res.text);
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM person_blocks WHERE player_id = ?', plain.pid).n, 1, 'the survivor carries the block');
});

// ---- F5: Match to roster and the rank of the row

function rosterRows(s, rows) {
  for (const [name, id, rank] of rows) {
    sRun(s, `INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
             VALUES (?, ?, 4001, ?, ?, ?, 'nightslayer', 'MAGE', 70, ?)`, s.gid, NS, id, name, name.toLowerCase(), rank);
  }
}
function rankMapRows(s) {
  for (const [rank, role] of [[0, 'guild_master'], [1, 'officer'], [2, 'team_lead'], [4, null]]) {
    sRun(s, "INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES (?, 'ingame', ?, ?, 'raider', ?)", s.gid, String(rank), `Rank ${rank}`, role);
  }
}
const matchCall = (s, who, person, id) => s.call(who, 'POST', `/roster/${person.pid}/characters/${person.cid}/match`, { namespace: NS, blizzardRealmId: 4001, blizzardCharId: id });

check('F5: Match to roster refuses (403 seniority) a roster row whose in-game rank maps to a role the actor does not strictly outrank; the Owner may, and rows of no elevated role stay open', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  await s.officer('o1', 'Officerone');
  await s.lead('tl', [s.tids[0]], 'Leadone');
  rankMapRows(s);
  rosterRows(s, [['Gmguy', 9100, 0], ['Officerguy', 9101, 1], ['Leadguy', 9102, 2], ['Plainguy', 9103, 4]]);
  const squats = {};
  for (const name of ['Squata', 'Squatb', 'Squatc', 'Squatd', 'Squate']) squats[name] = await s.person({ name });
  const keyOf = (person) => sOne(s, 'SELECT blizzard_char_id AS id, name FROM characters WHERE id = ?', person.cid);

  // The Officer (rank 1): the Guild Master row and an Officer row are not strictly below it.
  for (const [squat, id] of [['Squata', 9100], ['Squatb', 9101]]) {
    const res = await matchCall(s, 'o1', squats[squat], id);
    assert.deepEqual([res.status, res.json && res.json.error], [403, 'seniority'], `${squat}: ${res.text}`);
    assert.equal(keyOf(squats[squat]).id, null, `${squat} stays unbound`);
  }
  // ... a Team Lead row and a plain row are.
  let res = await matchCall(s, 'o1', squats.Squatc, 9102);
  assert.equal(res.status, 200, res.text);
  res = await matchCall(s, 'o1', squats.Squatd, 9103);
  assert.equal(res.status, 200, res.text);
  // The Team Lead (rank 2, roster.edit on Alpha): a Team Lead row is its own rank.
  rosterRows(s, [['Leadtwo', 9104, 2]]);
  res = await matchCall(s, 'tl', squats.Squate, 9104);
  assert.deepEqual([res.status, res.json && res.json.error], [403, 'seniority'], res.text);
  // The Owner passes every row.
  res = await matchCall(s, 'gm', squats.Squata, 9100);
  assert.equal(res.status, 200, res.text);
  assert.equal(keyOf(squats.Squata).id, 9100);
  assert.equal(sOne(s, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'character.match_roster'").n, 3, 'only the applied matches are audited');
});

check('F9: the Match to roster write guard holds the character\'s specs and class as the officer saw them - an edit that lands between the read and the write is not overwritten (409 with the current record)', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  rosterRows(s, [['Matchme', 9200, 4]]);
  const squat = await s.person({ name: 'Handtyped', mainSpec: 'Fire', offSpec: null });
  const inner = s.w.db.batch.bind(s.w.db);
  let hooked = false;
  s.w.db.batch = async (statements) => {
    if (!hooked && statements.some((statement) => statement.values && statement.values.includes('character.match_roster'))) {
      hooked = true;
      sRun(s, "UPDATE characters SET main_spec = 'Arcane' WHERE id = ?", squat.cid); // somebody picks another spec between our read and our write
    }
    return inner(statements);
  };
  const res = await matchCall(s, 'gm', squat, 9200);
  s.w.db.batch = inner;
  assert(hooked, 'the match batch ran');
  assert.equal(res.status, 409, res.text);
  const row = sOne(s, 'SELECT main_spec, blizzard_char_id, name FROM characters WHERE id = ?', squat.cid);
  assert.equal(row.main_spec, 'Arcane', 'the other edit is kept');
  assert.equal(row.blizzard_char_id, null, 'and the match did not apply');
  assert.equal(sOne(s, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'character.match_roster'").n, 0);
  // Without the interference the same call applies.
  const again = await matchCall(s, 'gm', squat, 9200);
  assert.equal(again.status, 200, again.text);
});

check('F5 (part 2b pin): a Battle.net proof beats a squatted hand-added character that carries the Guild Master\'s name - the same character ends up keyed and proven on the Guild Master\'s person', async () => {
  for (const squatterOwner of ['unowned', 'other account']) {
    const w = await makeWorld();
    const G = w.ingame(1, [['Aldric', 0], ['Brindle', 5]]);
    if (squatterOwner === 'other account') w.raw.user(UID(5));
    w.raw.person(PID(2), G, squatterOwner === 'unowned' ? {} : { userId: UID(5) });
    w.raw.character(CID(2), G, PID(2), 'Aldric', { isMain: 1, key: false }); // hand-added by an officer: the Guild Master's name, no key
    w.serve(['Aldric', 'Brindle']);
    await bnetSignIn(w, BNET.ann);
    const userId = userOf(w, BNET.ann);
    const mine = personOf(w, userId, G);
    assert(mine, `${squatterOwner}: the account has a person`);
    const aldric = w.one("SELECT * FROM characters WHERE guild_id = ? AND name_key = 'aldric'", G);
    assert.equal(aldric.id, CID(2), `${squatterOwner}: the SAME character (its evidence stays with it)`);
    assert.deepEqual([aldric.blizzard_char_id, aldric.owner_proof, aldric.proof_user_id, aldric.player_id], [idOf('Aldric'), 'bnet', userId, mine.id], `${squatterOwner}: keyed, proven, on the account's person`);
  }
});

// ---- F6: unblocking and the tombstones of the blocks a hit matched

check('F6: restoring an account deletes a matched earlier block\'s tombstones only when the actor ranks equal to or above that block\'s actor_role snapshot (or made it: F9) - an Officer cannot lift the tombstones of a block the Owner made; the response says so', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY } });
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  // The Owner blocks m1; m1 deletes the account; the same Discord ID signs in again as a NEW account and is matched against the tombstone.
  await s.ok('gm', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  const oldRef = `u:${s.uids.m1}`;
  const refCount = () => sOne(s, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE guild_id = ? AND block_ref = ?', s.gid, oldRef).n;
  assert(refCount() > 0, 'the Owner\'s block left tombstones');
  assert.equal((await s.w.call(s.jars.m1, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  const comeBack = async (key) => {
    s.jars[key] = (await signIn(s.w, scenarioDiscord('m1', 'Memberone'), [memberOf(s.serverId)])).jar;
    s.uids[key] = (await s.w.call(s.jars[key], 'GET', '/auth/me')).json.user.id;
    return s.uids[key];
  };
  const m1b = await comeBack('m1b');
  const pending = sOne(s, 'SELECT * FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, m1b);
  assert(pending && pending.pending_review === 1, 'the new account is blocked for review');

  // The Officer lifts the pending block: the account is restored, the Owner's tombstones stay.
  const lifted = await s.call('o1', 'DELETE', `/people/${m1b}/block`);
  assert.equal(lifted.status, 200, lifted.text);
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM guild_blocks WHERE user_id = ?', m1b).n, 0, 'the block row is gone');
  assert(refCount() > 0, 'but the tombstones of the Owner\'s block stay');
  assert.equal(lifted.json.tombstonesKept, 1, 'and the response says so');

  // It signs in again: matched again. The Owner lifts it and the tombstones go with it.
  const m1c = await comeBack('m1c');
  assert(sOne(s, 'SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, m1c), 'matched again');
  const byOwner = await s.call('gm', 'DELETE', `/people/${m1c}/block`);
  assert.equal(byOwner.status, 200, byOwner.text);
  assert.equal(refCount(), 0, 'the Owner lifts the Owner\'s tombstones');
  assert.equal(byOwner.json.tombstonesKept, undefined);
});

check('F6: the same for an account-less person - an Officer lifting a person block does not delete the tombstones of the Owner\'s earlier block the person\'s keys matched (an Officer\'s own: F9)', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY } });
  await s.officer('o1', 'Officerone');
  const DISCORD_ID = '130000000000000077';
  const first = await s.person({ name: 'Firstguy' });
  sRun(s, 'UPDATE players SET discord_user_id = ? WHERE id = ?', DISCORD_ID, first.pid);
  await s.ok('gm', 'POST', `/roster/${first.pid}/block`, {}, 200);
  const firstRef = `p:${first.pid}`;
  const refCount = () => sOne(s, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE guild_id = ? AND block_ref = ?', s.gid, firstRef).n;
  assert(refCount() > 0);
  sRun(s, 'DELETE FROM players WHERE id = ?', first.pid); // the person is deleted; the block row goes with it, the tombstones stay
  const second = await s.person({ name: 'Secondguy' });
  sRun(s, 'UPDATE players SET discord_user_id = ? WHERE id = ?', DISCORD_ID, second.pid);
  await s.ok('o1', 'POST', `/roster/${second.pid}/block`, {}, 200);
  const lifted = await s.call('o1', 'DELETE', `/roster/${second.pid}/block`);
  assert.equal(lifted.status, 200, lifted.text);
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM person_blocks WHERE player_id = ?', second.pid).n, 0);
  assert(refCount() > 0, 'the Owner\'s tombstones stay');
  assert.equal(lifted.json.tombstonesKept, 1);
  await s.ok('o1', 'POST', `/roster/${second.pid}/block`, {}, 200);
  const byOwner = await s.call('gm', 'DELETE', `/roster/${second.pid}/block`);
  assert.equal(byOwner.status, 200, byOwner.text);
  assert.equal(refCount(), 0, 'the Owner lifts them');
});

// ---- F7: the officer join and the daily cron

async function populatedLoser(s, L, S) {
  const [alpha, bravo] = s.tids;
  const g = s.gid;
  const raids = [];
  for (let i = 1; i <= 4; i++) raids.push((await s.ok('gm', 'POST', '/raids', { teamId: alpha, raidOn: `2027-01-${String(i).padStart(2, '0')}`, startTime: '20:00', zone: "Gruul's Lair" })).raid.id);
  const loseAlt = await s.alt(L.pid, 'Losealt');
  s.setTeam(loseAlt, bravo);
  const survAlt = await s.alt(S.pid, 'Survalt');
  s.setTeam(survAlt, bravo);
  const att = (raidId, pid) => sRun(s, "INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, 'present', 1, 1)", raidId, g, alpha, pid);
  att(raids[0], S.pid); att(raids[0], L.pid); att(raids[1], L.pid);
  sRun(s, "INSERT INTO attendance_decisions (raid_id, player_id, guild_id, outcome, credit, reason, flags, decided_at) VALUES (?, ?, ?, 'bench', 0, 'Told us', '[]', 1)", raids[0], L.pid, g);
  sRun(s, 'INSERT INTO raid_manual (raid_id, guild_id, player_id) VALUES (?, ?, ?)', raids[0], g, L.pid);
  sRun(s, "INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, created_at, updated_at) VALUES (?, 'raidsmith', 2, 'signed', 1, ?, ?, 1, 200)", raids[2], g, L.pid);
  sRun(s, "INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, created_at, updated_at) VALUES (?, 'raidsmith', 1, 'signed', 1, ?, ?, 1, 100)", raids[2], g, S.pid);
  sRun(s, "INSERT INTO raid_roster (raid_id, guild_id, name_key, name, player_id, group_number, status) VALUES (?, ?, 'losemain', 'losemain', ?, 1, 'pending')", raids[1], g, L.pid);
  sRun(s, "INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_at, updated_at) VALUES ('an_lose0000000000000001', ?, ?, 'away', '2027-02-01', '2027-02-05', 1, 1)", g, L.pid);
  sRun(s, "INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, created_at, updated_at) VALUES ('sg_lose0000000000000001', ?, ?, ?, 2, 'signed', 1, 1)", g, alpha, L.pid);
  sRun(s, "INSERT INTO intent_rounds (id, guild_id, team_id, title, status, created_at) VALUES ('ir_round00000000000001', ?, ?, 'Round', 'open', 1)", g, alpha);
  sRun(s, "INSERT INTO intent_picks (round_id, guild_id, player_id, kind, class, spec, role, updated_at) VALUES ('ir_round00000000000001', ?, ?, 'main', 'MAGE', 'Fire', 'ranged', 1)", g, L.pid);
  sRun(s, "INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, class, answers, player_id, created_at, updated_at) VALUES ('am_app00000000000000001', ?, ?, 'accepted', 'Losemain', 'losemain', 'MAGE', '[]', ?, 1, 1)", g, alpha, L.pid);
  sRun(s, "INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, created_at) VALUES (?, ?, 'promote', 'core', 9999999999999, 1)", g, L.pid);
  sRun(s, 'INSERT INTO launch_status (guild_id, team_id, player_id, ready, updated_at) VALUES (?, ?, ?, 1, 1)', g, alpha, L.pid);
  sRun(s, "INSERT INTO raid_duties (raid_id, guild_id, duty, player_id) VALUES (?, ?, 'leader', ?)", raids[0], g, L.pid);
  sRun(s, "INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, created_at) VALUES (?, ?, ?, 'Spam', 5)", g, L.pid, s.uids.o1);
  sRun(s, "INSERT INTO attention_dismissals (id, guild_id, item_id, kind, team_id, mode, until, fingerprint, created_at) VALUES ('ad_a', ?, ?, 'trial', ?, 'snooze', 9999999999999, 'fp', 1)", g, `trial:${L.pid}`, alpha);
  sRun(s, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('na_old0000000000000001', ?, ?, 'oldfree', 'nightslayer', 5)", g, loseAlt);
}

check('F7: the officer join request stays under 50 D1 statements - a plain join about half of that, and a loser with rows in EVERY table (clashes, a person block, a team clash) still under 50', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  // A plain join: two people with nothing but characters.
  const A = await s.person({ name: 'Plaina' });
  const B = await s.person({ name: 'Plainb' });
  await s.link(B.pid, 'm1');
  const plain = await measured(s, () => joinCall(s, 'o1', A.pid, B.pid));
  assert.equal(plain.result.status, 200, plain.result.text);
  assert(plain.statements < 50, `plain join: ${plain.statements}`);
  assert(plain.statements <= 30, `a plain join asks only for the tables the loser has rows in: ${plain.statements}`);
  // The loser has rows in every table the join moves.
  const L = await s.person({ name: 'Losemain' });
  const S = await s.person({ name: 'Survmain' });
  await s.member('m2', 'Membertwo');
  await s.link(S.pid, 'm2');
  await populatedLoser(s, L, S);
  const rich = await measured(s, () => joinCall(s, 'o1', L.pid, S.pid));
  assert.equal(rich.result.status, 200, rich.result.text);
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', L.pid).n, 0, 'the loser is gone');
  const { JOIN_TABLES } = await load('worker/person-join.js');
  for (const table of Object.keys(JOIN_TABLES)) assert.equal(sOne(s, `SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ?`, L.pid).n, 0, `${table}: nothing is left on the loser`);
  assert(rich.statements < 50, `rich join: ${rich.statements}`);
  console.log(`      measured: plain join ${plain.statements}, rich join ${rich.statements} statements`);
});

check('F7: the daily repair of tombstones handles at most 25 blocks in all (account and person blocks together), the failure-counter flush at most 100 counters - both counted with statementLog', async () => {
  const { repairTombstones, REPAIR_LIMIT } = await load('worker/block-tombstones.js');
  const { flushFailureCounters, FLUSH_LIMIT, failureCounterKey, FAILURE_WINDOW_MS } = await load('worker/audit.js');
  assert.deepEqual([REPAIR_LIMIT, FLUSH_LIMIT], [25, 100]);
  const w = await makeWorld();
  const G = w.ingame(1, []);
  for (let i = 0; i < 40; i++) {
    const user = UID(100 + i);
    w.raw.user(user, { discordId: `140000000000${String(i).padStart(6, '0')}` });
    w.run('INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES (?, ?, NULL, NULL, 1)', G, user);
  }
  for (let i = 0; i < 40; i++) {
    w.raw.person(PID(100 + i), G, { discordUserId: `150000000000${String(i).padStart(6, '0')}` });
    w.raw.personBlock(G, PID(100 + i), null);
  }
  const repairMark = w.mark();
  const repaired = await repairTombstones({ db: w.db, env: w.env, now: () => T0, log: () => {} });
  const repairStatements = w.since(repairMark).length;
  assert.equal(repaired.repaired + repaired.noKeys, 25, 'at most 25 blocks a run');
  assert(repairStatements <= 2 + 4 * 25, `${repairStatements} statements`);
  // 300 counters of the hours that saw several failures.
  const bucketOf = (n) => Math.floor(T0 / FAILURE_WINDOW_MS) - 5 - n;
  for (let i = 0; i < 300; i++) {
    const bucket = bucketOf(Math.floor(i / 40));
    w.run('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 3)', failureCounterKey('fresh.failed', G, UID(100 + (i % 40)), bucket), bucket * FAILURE_WINDOW_MS);
  }
  const flushMark = w.mark();
  const written = await flushFailureCounters({ db: w.db, now: () => T0, randomBytes: w.randomBytes });
  const flushStatements = w.since(flushMark).length;
  assert(written <= 100, `${written} summaries`);
  assert(flushStatements <= 1 + 2 * 100, `${flushStatements} statements`);
  assert.equal(w.count('rate_limits', "key LIKE 'auditfail:%'"), 200, 'the other 200 counters wait for the next run');
  console.log(`      measured: repair ${repairStatements} statements for 25 blocks, flush ${flushStatements} for 100 counters`);
});

check('F7 (join trim): every KEYED table of the person join cascades from players, so the rows a join leaves behind (a row the survivor already has) go with the loser and cost no statement of their own', async () => {
  const { JOIN_TABLES } = await load('worker/person-join.js');
  const db = createD1Fake();
  const keyed = Object.entries(JOIN_TABLES).filter(([, spec]) => spec.how === 'keyed').map(([table]) => table);
  assert(keyed.length >= 7, keyed.join(','));
  for (const table of keyed) {
    const fks = db.sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all().filter((fk) => fk.table === 'players');
    assert(fks.length >= 1 && fks.every((fk) => fk.on_delete === 'CASCADE'), `${table}: ${JSON.stringify(fks.map((fk) => fk.on_delete))}`);
  }
});

// ---- B4b F4: the rank-map PUT and the characters it moves

check('B4b F4: the rank-map PUT recomputes the approved transitions INSIDE the batch - a character that changes after the check and before the batch is not moved without approval (409 approval_stale, nothing applied); a fresh dry run then applies', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  const bound = async (name, id) => {
    const made = await s.person({ name });
    s.exec(`UPDATE characters SET namespace = '${NS}', blizzard_realm_id = 4001, blizzard_char_id = ${id} WHERE id = '${made.cid}'`);
    return made;
  };
  await bound('Aone', 9000);
  await bound('Btwo', 9001);
  rosterRows(s, [['Aone', 9000, 0], ['Btwo', 9001, 5]]);
  // The flip's end state: the seat on 'gm', LIVE (a Battle.net-proven character on rank 0, a rank the map below keeps a Raider), the stored Guild Master row gone.
  const owned = await s.person({ name: 'Gmowner' });
  await s.link(owned.pid, 'gm');
  makeProven(s, 'gm', owned, { rank: 0, id: 9002 });
  s.exec(`UPDATE guilds SET rank_source = 'ingame', owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  const RANKS = [
    { rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' },
    { rank: 5, label: 'Member', coreRank: 'social', roleId: null },
  ];
  const dry = await s.ok('gm', 'POST', '/rank-map/dry-run', { ranks: RANKS }, 200);
  assert.deepEqual(dry.changes.characters.transitions, [{ from: 'raider', to: 'social', count: 1 }], 'the dry run approves one character: Btwo goes Social');
  const snapshot = () => JSON.stringify([sAll(s, 'SELECT name, core_rank FROM characters ORDER BY id'), sAll(s, 'SELECT source_key FROM source_rank_maps'), sOne(s, 'SELECT used_at FROM dry_run_approvals')]);
  const before = snapshot();

  // Between the Worker's check of the token and its batch, Aone's rank is edited: its transition (Trial -> Raider) was never shown to the Owner.
  const inner = s.w.db.batch.bind(s.w.db);
  let hooked = false;
  s.w.db.batch = async (statements) => {
    if (!hooked && statements.some((statement) => /UPDATE dry_run_approvals SET used_at/.test(statement.sql))) {
      hooked = true;
      sRun(s, "UPDATE characters SET core_rank = 'trial' WHERE name = 'Aone'");
    }
    return inner(statements);
  };
  const raced = await s.call('gm', 'PUT', '/rank-map', { ranks: RANKS, token: dry.token });
  s.w.db.batch = inner;
  assert(hooked, 'the apply batch ran');
  assert.deepEqual([raced.status, raced.json && raced.json.error], [409, 'approval_stale'], raced.text);
  assert.equal(sOne(s, "SELECT core_rank FROM characters WHERE name = 'Btwo'").core_rank, 'raider', 'Btwo was not moved');
  assert.equal(sOne(s, "SELECT core_rank FROM characters WHERE name = 'Aone'").core_rank, 'trial', 'and the edited character was not moved back either');
  assert.equal(sAll(s, 'SELECT source_key FROM source_rank_maps').length, 0, 'the map was not replaced');
  assert.equal(sOne(s, 'SELECT used_at FROM dry_run_approvals').used_at, null, 'the token was not consumed');
  assert.notEqual(snapshot(), before, 'only the edit itself changed');

  // The state is different now, so the old token is stale; a new dry run shows both changes and applies.
  assert.deepEqual([(await s.call('gm', 'PUT', '/rank-map', { ranks: RANKS, token: dry.token })).json.error], ['approval_stale']);
  const dry2 = await s.ok('gm', 'POST', '/rank-map/dry-run', { ranks: RANKS }, 200);
  assert.equal(dry2.changes.characters.changed, 2);
  const applied = await s.call('gm', 'PUT', '/rank-map', { ranks: RANKS, token: dry2.token });
  assert.equal(applied.status, 200, applied.text);
  assert.deepEqual(sAll(s, 'SELECT name, core_rank FROM characters ORDER BY name').map((row) => ({ ...row })), [{ name: 'Aone', core_rank: 'raider' }, { name: 'Btwo', core_rank: 'social' }, { name: 'Gmowner', core_rank: 'raider' }]);
});

// ---------------------------------------------------------------------------
// Runner

(async () => {
  const filter = process.argv[2] || '';
  let failed = 0;
  let ran = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    ran++;
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n      ') : error}`);
    }
  }
  await closeWorlds();
  console.log(`\n${ran - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
