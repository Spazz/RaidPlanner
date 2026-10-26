/**
 * Raidsmith guild tracker - the review fixes of lane B6a part 2b (re-home, name collision, placeholder), round 2 (guild/hier-b6a-fix2)
 * Run: node tests/guild/guild-b6a-rehome-fixes-tests.js [name filter]
 *
 * Every check here FAILS on guild/hier-b6a 6158da6 (the code the review read) and passes after the fix:
 *   M1  POST /raids/:rid/signups/link writes a Discord ID onto a person: when the person holds a Battle.net-proven character it is the Owner's (as the account link is)
 *   M2  a re-home into a person whose Main is a retired placeholder makes the moved character the Main (the person keeps a VISIBLE Main), the placeholder steps down
 *   M3  a ruleset in-game guild stores an empty realm_key: the name collision finds (and retires) the typed character there too
 *   L4  the key bind of a name collision is guarded by the account's person (the link or create that did not happen binds nothing)
 *   L5  the collision re-home needs the bind to be possible (the typed character changed after the read: nothing moves)
 *   L6  the Activity / audit JSON never carries a placeholder's id
 *   L7  the recent-bench count reads plan seats through the alias helper (an old bench seat stays with the old owner)
 *   L8  a re-home withdraws the moved character's pending team request and removes its upcoming published-roster seat (those raids are stale)
 *   F9  an unblock lifts the tombstones of a matched earlier block when the actor ranks EQUAL or SENIOR to the block's actor_role snapshot, or made that block
 * Two harnesses: the Battle.net world of guild-hier-review-fixes-tests.js (raw fixtures + the fake Battle.net) and the guild scenario of tests/guild-b3-world.js.
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
    guild(id, { source = 'ingame', version = 'tbc', region = 'US', realm = 'Dreamscythe', zone = 'America/New_York', server = null, realmKind = 'realm' } = {}) {
      run(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, id, `Guild ${id.slice(-3)}`, realm, realmKind, region, server || `none:${id}`, zone, version, source);
    },
    user(id, { discordId = null } = {}) {
      run('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)', id, id, discordId, id);
    },
    person(id, guildId, { userId = null, discordUserId = null, created = 1, joined = '2026-01-01' } = {}) {
      run("INSERT INTO players (id, guild_id, status, user_id, discord_user_id, joined_on, created_at, updated_at) VALUES (?, ?, 'raider', ?, ?, ?, ?, ?)",
        id, guildId, userId, discordUserId, joined, created, created);
    },
    // ruleset: a character of a ruleset guild (no realm, an empty realm_key). blizzardId: a key the roster does not hold (a character that left).
    character(id, guildId, personId, name, { key = true, isMain = 0, coreRank = 'raider', proof = 'officer', proofUser = null, proofBnet = null, proofAt = null, ruleset = false, blizzardId = null, leftOn = null, teamId = null } = {}) {
      const row = rowOfName(name);
      const realm = ruleset ? null : row ? REALM_NAME[row[3]] : 'Dreamscythe';
      run(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on,
                                    owner_proof, proof_user_id, proof_bnet_account_id, proof_at, namespace, blizzard_realm_id, blizzard_char_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, guildId, personId, teamId, name, name.toLowerCase(), realm, ruleset ? '' : realm.toLowerCase(), row ? CLASS_OF[row[1]] : 'MAGE', isMain, coreRank, leftOn, proof, proofUser, proofBnet, proofAt,
      (key && row) || blizzardId ? NS : null, (key && row) || blizzardId ? REALM_ID[row ? row[3] : 0] : null, blizzardId || (key && row ? idOf(name) : null));
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
// The guild scenario (tests/guild-b3-world.js): officers, roster people, the routes

const { scenario, discord: scenarioDiscord } = require('../guild-b3-world');
const { signIn, memberOf } = require('../guild-world');

const sOne = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).get(...values);
const sAll = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
const sRun = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).run(...values);
const mk = (s, name, extra = {}) => s.person({ name, ...extra });

// Plans and runs one re-home. -> { plan, results, applied }
async function rehome(s, characterId, toPersonId, { reason = 'bnet_beats_link', guards = [], actor = 'gm', run = true } = {}) {
  const { rehomeStatements } = await load('worker/rehome.js');
  const plan = await rehomeStatements(s.w.db, {
    guildId: s.gid, characterId, toPersonId, actorUserId: s.uids[actor], now: s.w.clock.now, reason, guards, randomBytes: s.w.randomBytes,
  });
  if (!run) return { plan };
  const results = await s.w.db.batch(plan.statements);
  return { plan, results, applied: results[plan.appliedIndex].meta.changes === 1 };
}

// A raid on a team: a date of January 2027 (the world's clock is 2027-01-15).
async function raidOn(s, teamId, day) {
  const res = await s.ok('gm', 'POST', '/raids', { teamId, raidOn: `2027-01-${String(day).padStart(2, '0')}`, startTime: '20:00', zone: "Gruul's Lair" });
  return res.raid.id;
}

// Runs `action` right before the first db.batch that has a statement `when` accepts: a change that lands between the Worker's read and its write.
// -> a function that restores the batch and tells whether the change happened.
function beforeBatch(db, when, action) {
  const real = db.batch.bind(db);
  let fired = false;
  db.batch = async (statements) => {
    if (!fired && statements.some(when)) { fired = true; action(); }
    return real(statements);
  };
  return () => { db.batch = real; return fired; };
}

// ---- M1: the sign-up link and a person with a Battle.net-proven character

check('M1: POST /raids/:rid/signups/link puts a Discord ID on a person who holds a Battle.net-proven character only for the Owner - an Officer gets 403 and nothing changes; a person with no proved character stays an Officer\'s', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  const proven = await mk(s, 'Provenmain');
  await s.link(proven.pid, 'm1');
  sRun(s, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = '710000001', proof_at = 1 WHERE player_id = ?", s.uids.m1, proven.pid);
  const plain = await mk(s, 'Plainmain');
  const rid = await raidOn(s, s.tids[0], 20);
  const m2Discord = scenarioDiscord('m2', 'Membertwo').id;
  const signup = (id) => sRun(s, "INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, position, guild_id) VALUES (?, 'raid_helper', ?, ?, 'Membertwo', 'signed', ?, ?)",
    rid, id, id === 7 ? m2Discord : null, id, s.gid);
  signup(7);
  const dump = () => JSON.stringify([sAll(s, 'SELECT id, discord_user_id, user_id, version FROM players ORDER BY id'), sAll(s, 'SELECT signup_id, player_id FROM raid_signups ORDER BY signup_id'),
    sAll(s, "SELECT action FROM audit_log WHERE action = 'signup.link'")]);
  const before = dump();
  const refused = await s.call('o1', 'POST', `/raids/${rid}/signups/link`, { signupId: 7, personId: proven.pid });
  assert.deepEqual([refused.status, refused.json && refused.json.error], [403, 'forbidden'], refused.text);
  assert.equal(dump(), before, 'nothing changed: the second account did not become an owner of the proved person');

  // A person without a proved character is still the Officer's to link.
  const other = await s.call('o1', 'POST', `/raids/${rid}/signups/link`, { signupId: 7, personId: plain.pid });
  assert.equal(other.status, 200, other.text);
  assert.equal(sOne(s, 'SELECT discord_user_id FROM players WHERE id = ?', plain.pid).discord_user_id, m2Discord);

  // A proof that appears between the read and the write is caught inside the batch too (the Officer's link is a no-op: 409, the sign-up stays unlinked).
  sRun(s, 'UPDATE players SET discord_user_id = NULL WHERE id = ?', plain.pid);
  sRun(s, 'UPDATE raid_signups SET player_id = NULL WHERE signup_id = 7');
  const done = beforeBatch(s.w.db, (statement) => statement.sql.startsWith('UPDATE players SET discord_user_id = ?'),
    () => sRun(s, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = '710000002', proof_at = 1 WHERE player_id = ?", s.uids.m1, plain.pid));
  const raced = await s.call('o1', 'POST', `/raids/${rid}/signups/link`, { signupId: 7, personId: plain.pid });
  assert(done(), 'the proof landed between the read and the write');
  assert.equal(raced.status, 409, raced.text);
  assert.equal(sOne(s, 'SELECT discord_user_id FROM players WHERE id = ?', plain.pid).discord_user_id, null);
  assert.equal(sOne(s, 'SELECT player_id FROM raid_signups WHERE signup_id = 7').player_id, null, 'and the sign-up stays unlinked');
  sRun(s, "UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL, proof_at = NULL WHERE player_id = ?", plain.pid);

  // The Owner may link the proved person.
  const owner = await s.call('gm', 'POST', `/raids/${rid}/signups/link`, { signupId: 7, personId: proven.pid });
  assert.equal(owner.status, 200, owner.text);
  assert.equal(sOne(s, 'SELECT discord_user_id FROM players WHERE id = ?', proven.pid).discord_user_id, m2Discord);
});

// ---- F9: the tombstones an unblock lifts

// An account that was blocked deletes its data and comes back as a NEW account with the same Discord ID: the tombstones match it (pending review).
async function blockedComesBack(s, key, name) {
  const again = async (as) => {
    s.jars[as] = (await signIn(s.w, scenarioDiscord(key, name), [memberOf(s.serverId)])).jar;
    s.uids[as] = (await s.w.call(s.jars[as], 'GET', '/auth/me')).json.user.id;
    return s.uids[as];
  };
  return again;
}

check('F9: an unblock lifts the tombstones of a matched earlier block when the actor ranks EQUAL to its blocker - another Officer lifts an Officer\'s memory, so the next sign-in is clean', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY } });
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  await s.member('m1', 'Memberone');
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  const oldRef = `u:${s.uids.m1}`;
  const refCount = () => sOne(s, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE guild_id = ? AND block_ref = ?', s.gid, oldRef).n;
  assert(refCount() > 0, 'the Officer\'s block left tombstones');
  assert.equal((await s.w.call(s.jars.m1, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  const comeBack = await blockedComesBack(s, 'm1', 'Memberone');
  const m1b = await comeBack('m1b');
  assert(sOne(s, 'SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ? AND pending_review = 1', s.gid, m1b), 'the new account is blocked for review');

  const lifted = await s.call('o2', 'DELETE', `/people/${m1b}/block`);
  assert.equal(lifted.status, 200, lifted.text);
  assert.equal(refCount(), 0, 'an Officer is equal to the Officer who blocked: the tombstones go');
  assert.equal(lifted.json.tombstonesKept, undefined);
  await comeBack('m1c');
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM guild_blocks WHERE guild_id = ?', s.gid).n, 0, 'the next sign-in is not blocked again');
});

check('F9: an unblock also lifts the tombstones of a block the actor MADE, whatever rank its snapshot says now; another Officer facing a senior snapshot keeps them (tombstonesKept)', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY } });
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  await s.member('m1', 'Memberone');
  // o1 holds the Owner seat when it blocks (the audit row snapshots 'owner', rank 0) and is only an Officer afterwards.
  s.setOwner('o1');
  await s.ok('o1', 'POST', `/people/${s.uids.m1}/block`, {}, 200);
  assert.equal(sOne(s, "SELECT actor_role FROM audit_log WHERE action = 'access.remove' AND entity_id = ?", s.uids.m1).actor_role, 'owner');
  s.setOwner('gm');
  const oldRef = `u:${s.uids.m1}`;
  const refCount = () => sOne(s, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE guild_id = ? AND block_ref = ?', s.gid, oldRef).n;
  assert.equal((await s.w.call(s.jars.m1, 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  const comeBack = await blockedComesBack(s, 'm1', 'Memberone');
  const m1b = await comeBack('m1b');
  assert(sOne(s, 'SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, m1b), 'matched');

  const byOther = await s.call('o2', 'DELETE', `/people/${m1b}/block`);
  assert.equal(byOther.status, 200, byOther.text);
  assert(refCount() > 0, 'another Officer is junior to the snapshot and did not make the block: the tombstones stay');
  assert.equal(byOther.json.tombstonesKept, 1);
  await comeBack('m1c');
  assert(sOne(s, 'SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?', s.gid, m1b), 'matched again');
  const byBlocker = await s.call('o1', 'DELETE', `/people/${m1b}/block`);
  assert.equal(byBlocker.status, 200, byBlocker.text);
  assert.equal(refCount(), 0, 'the Officer who made the block lifts its tombstones');
  assert.equal(byBlocker.json.tombstonesKept, undefined);
});

check('F9: the same for an account-less person - an Officer lifting a person block deletes the tombstones of an Officer\'s earlier block its keys matched', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY } });
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  const DISCORD_ID = '130000000000000078';
  const first = await s.person({ name: 'Firstguy' });
  sRun(s, 'UPDATE players SET discord_user_id = ? WHERE id = ?', DISCORD_ID, first.pid);
  await s.ok('o1', 'POST', `/roster/${first.pid}/block`, {}, 200);
  const firstRef = `p:${first.pid}`;
  const refCount = () => sOne(s, 'SELECT COUNT(*) AS n FROM block_tombstones WHERE guild_id = ? AND block_ref = ?', s.gid, firstRef).n;
  assert(refCount() > 0);
  sRun(s, 'DELETE FROM players WHERE id = ?', first.pid); // the person is deleted; the block row goes with it, the tombstones stay
  const second = await s.person({ name: 'Secondguy' });
  sRun(s, 'UPDATE players SET discord_user_id = ? WHERE id = ?', DISCORD_ID, second.pid);
  await s.ok('o2', 'POST', `/roster/${second.pid}/block`, {}, 200);
  const lifted = await s.call('o2', 'DELETE', `/roster/${second.pid}/block`);
  assert.equal(lifted.status, 200, lifted.text);
  assert.equal(refCount(), 0, 'the Officer\'s tombstones go with the unblock');
  assert.equal(lifted.json.tombstonesKept, undefined);
});

// ==== more checks above this line

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
    } finally {
      await closeWorlds();
    }
  }
  console.log(`\n${ran - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
