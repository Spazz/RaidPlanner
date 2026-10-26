/**
 * Raidsmith guild tracker - lane B6a part 2b of the user-hierarchy build: the re-home, Battle.net beats a link, the name collision
 * (worker/rehome.js, worker/bnet-match.js, worker/character-visibility.js, the Owner-only account link of worker/routes/accounts.js)
 * Run: node tests/guild/guild-b6a-rehome-tests.js [name filter]
 *
 *   - the module: one batch moves a character to another person, removes the old person's UPCOMING sign-ups that name it and marks those raids stale, hands the old
 *     person's Main to another character, leaves a retired placeholder (Former, Social, no key, no team, `~ph:` name_key) and a dated alias, bumps both versions,
 *     audits `character.rehome`; a lost guard makes every statement a no-op; the old person is never deleted;
 *   - the old person's history stays on it: per-table row counts before and after (attendance, decisions, away notices, intent picks, duties, loot resolution by
 *     name), a recompute of an old raid still credits it, a raid after the re-home credits the new person;
 *   - the placeholder is hidden: the roster, the person page, the pickers, the cap count (person join, re-home, sign-in match), membership (no key: not on the roster);
 *   - Battle.net beats a link at the sign-in: an officer's link and a typed-in character lose to the proving account (proof monotonic guard included);
 *   - the name collision: squat-then-enrol (the typed-in character is re-homed with the key), an unowned or own person, delete-and-recreate (the old character
 *     becomes Former and gives the name up to a dated alias), a roster that holds two characters with the name (invalid, nothing written);
 *   - at most one re-home per callback, the statement budget (45), two concurrent sign-ins, the Owner-only account link on a person with a proved character.
 * Two worlds: the Worker over the D1 stand-in with Discord and Battle.net faked (the sign-in flows, like guild-b6a-match-tests.js) and the guild scenario of
 * tests/guild-b3-world.js (teams, raids, roles: the module and what the pages show).
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
// World 2: the guild scenario of the lane B3 suites (teams, an Officer, members), for the module and the pages

const { scenario } = require('../guild-b3-world');

const DAY = 86_400_000;
let idSerial = 0;
const sid = (prefix) => `${prefix}_${String(++idSerial).padStart(22, '0')}`;
const sRun = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).run(...values);
const sAll = (s, sql, ...values) => s.w.db.sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
const sOne = (s, sql, ...values) => sAll(s, sql, ...values)[0];

// A guild with two teams, an Officer, a Team Lead of Alpha and two members. The Guild Master holds the Owner seat.
async function guildWorld() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  return s;
}

const moduleOf = (rel) => load(rel);

// Plans and runs one re-home. -> { plan, results, applied }
async function rehome(s, characterId, toPersonId, { reason = 'bnet_beats_link', guards = [], actor = 'gm', run = true } = {}) {
  const { rehomeStatements } = await moduleOf('worker/rehome.js');
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

// A two-pull log on the raid with these names present in both.
function addLog(s, raidId, names) {
  const raidRow = sOne(s, 'SELECT starts_at FROM raids WHERE id = ?', raidId);
  const code = `${raidId.slice(2, 10)}xxxxxxxx`.replace(/[^A-Za-z0-9]/g, 'x');
  sRun(s, "INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES (?, ?, ?, 'www', ?, 1)", raidId, s.gid, code, raidRow.starts_at);
  let fight = 0;
  for (const offset of [0, 600000]) {
    fight++;
    const pull = sRun(s, "INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, 1, 'Boss', 0, ?, ?)",
      raidId, code, fight, raidRow.starts_at + offset, raidRow.starts_at + offset + 1000).lastInsertRowid;
    for (const name of names) {
      sRun(s, "INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE')", pull, raidId, s.gid, name, name.toLowerCase());
    }
  }
}
const attendanceOf = (s, raidId) => Object.fromEntries(sAll(s, 'SELECT player_id, outcome, attended FROM attendance WHERE raid_id = ?', raidId).map((row) => [row.player_id, [row.outcome, row.attended]]));

// A character straight into the table (a fixture: the API makes at most a few). Visible unless `key` says otherwise.
let rawSerial = 0;
function rawCharacter(s, personId, name, { isMain = 0, teamId = null, key = null, leftOn = null } = {}) {
  rawSerial++;
  const id = `c_${String(rawSerial).padStart(22, 'z')}`;
  sRun(s, `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on)
           VALUES (?, ?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', ?, 1, 1, ?, ?)`, id, s.gid, personId, teamId, name, key || name.toLowerCase(), isMain, leftOn ? 'social' : 'raider', leftOn);
  return id;
}

// The rows a person holds in every table the person join knows (the evidence), by table.
async function evidenceCounts(s, personId) {
  const { JOIN_TABLES } = await moduleOf('worker/person-join.js');
  const out = {};
  for (const table of Object.keys(JOIN_TABLES)) {
    if (['characters', 'raid_signups', 'standing_signups'].includes(table)) continue;
    out[table] = sOne(s, `SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ? AND player_id = ?`, s.gid, personId).n;
  }
  return out;
}

// A person with history in every table a re-home must leave alone, on raids r1 and r2 (past) of the team, plus loot awarded to `name` and upcoming sign-ups on rf.
async function seedHistory(s, personId, name, { teamId, r1, r2, rf, rf2, characterId, altId }) {
  const g = s.gid;
  const att = (raidId, outcome) => sRun(s, 'INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, 1, 1)', raidId, g, teamId, personId, outcome);
  att(r1, 'present'); att(r2, 'missed');
  const decide = (raidId, outcome) => sRun(s, "INSERT INTO attendance_decisions (raid_id, player_id, guild_id, outcome, credit, reason, flags, decided_at) VALUES (?, ?, ?, ?, 0, 'Told us', '[]', 1)", raidId, personId, g, outcome);
  decide(r1, 'bench'); decide(r2, 'missed_notice');
  sRun(s, 'INSERT INTO raid_manual (raid_id, guild_id, player_id) VALUES (?, ?, ?)', r1, g, personId);
  sRun(s, "INSERT INTO raid_roster (raid_id, guild_id, name_key, name, player_id, group_number, status) VALUES (?, ?, ?, ?, ?, 1, 'confirmed')", r1, g, name.toLowerCase(), name, personId);
  for (const [n, from] of [[1, '2027-02-01'], [2, '2027-03-01']]) {
    sRun(s, "INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_at, updated_at) VALUES (?, ?, ?, 'away', ?, ?, 1, 1)", sid('an'), g, personId, from, from);
  }
  // one open spec poll per team
  let round = (sOne(s, "SELECT id FROM intent_rounds WHERE team_id = ? AND status = 'open'", teamId) || {}).id;
  if (!round) {
    round = sid('ir');
    sRun(s, "INSERT INTO intent_rounds (id, guild_id, team_id, title, status, created_at) VALUES (?, ?, ?, 'Round', 'open', 1)", round, g, teamId);
  }
  for (const kind of ['main', 'alt']) sRun(s, "INSERT INTO intent_picks (round_id, guild_id, player_id, kind, class, spec, role, updated_at) VALUES (?, ?, ?, ?, 'MAGE', 'Fire', 'ranged', 1)", round, g, personId, kind);
  sRun(s, "INSERT INTO raid_duties (raid_id, guild_id, duty, player_id) VALUES (?, ?, 'leader', ?)", r1, g, personId);
  sRun(s, "INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, created_at) VALUES (?, ?, 'promote', 'core', 9999999999999, 1)", g, personId);
  // two loot awards to the name, one in each past raid
  const award = (n, raidId, at) => sRun(s,
    `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 30000, 'Sword', ?, ?, ?, 'Nightslayer', 'nightslayer', 1, 1)`, sid('lo'), g, raidId, teamId, `${name}-chk-${n}`, at, name, name.toLowerCase());
  const starts = (raidId) => sOne(s, 'SELECT starts_at FROM raids WHERE id = ?', raidId).starts_at;
  award(1, r1, starts(r1) + 3600000); award(2, r2, starts(r2) + 3600000);
  // upcoming sign-ups on rf: one naming the character, one naming the alt; standing sign-ups likewise
  const signup = (n, character) => sRun(s, "INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, character_id, created_at, updated_at) VALUES (?, 'raidsmith', ?, 'signed', ?, ?, ?, ?, 1, 1)", n === 1 ? rf : rf2, 100 + (++idSerial), n, g, personId, character);
  signup(1, characterId); signup(2, altId);
  const standing = (_n, weekday, character) => sRun(s, "INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'signed', ?, 1, 1)", sid('sg'), g, teamId, personId, weekday, character);
  standing(1, 2, characterId); standing(2, 4, altId); standing(3, 5, null);
}

// Who an award resolves to, the way every loot reader reads it: the winner's name as the characters carry it on the day of the award.
async function awardOwners(s, name) {
  const { winnerNameKeySql } = await moduleOf('worker/name-alias.js');
  return Object.fromEntries(sAll(s,
    `SELECT a.id, (SELECT c.player_id FROM characters c WHERE c.guild_id = a.guild_id AND c.name_key = ${winnerNameKeySql('a')} AND c.realm_key = a.winner_realm_key) AS owner
       FROM loot_awards a WHERE a.guild_id = ? AND a.winner_name = ? ORDER BY a.awarded_at`, s.gid, name).map((row) => [row.id, row.owner]));
}

const mk = (s, name, extra = {}) => s.person({ name, ...extra });

// ---------------------------------------------------------------------------
// The module

check('rehome: one batch moves the character, hands over the Main, leaves a placeholder and a dated alias, removes the upcoming sign-ups, marks the raids stale, audits it', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  const A = await mk(s, 'Foo');
  const fooAlt = await s.alt(A.pid, 'Fooalt');
  const B = await mk(s, 'Bar', { teamId: bravo });
  await s.link(B.pid, 'm1');
  const r1 = await raidOn(s, alpha, 10);
  const r2 = await raidOn(s, alpha, 11);
  const rf = await raidOn(s, alpha, 25);
  const rf2 = await raidOn(s, alpha, 26);
  await seedHistory(s, A.pid, 'Foo', { teamId: alpha, r1, r2, rf, rf2, characterId: A.cid, altId: fooAlt });
  sRun(s, "UPDATE raids SET policy_fp = 'x'");
  sRun(s, "INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('na_older0000000000000001', ?, ?, 'foold', 'nightslayer', 5)", s.gid, A.cid);
  const versions = () => ({ a: sOne(s, 'SELECT version FROM players WHERE id = ?', A.pid).version, b: sOne(s, 'SELECT version FROM players WHERE id = ?', B.pid).version });
  const before = versions();
  const teamBefore = sOne(s, 'SELECT team_id, is_main, updated_at FROM characters WHERE id = ?', A.cid);
  assert.equal(teamBefore.team_id, alpha);
  assert.equal(teamBefore.is_main, 1);

  const { plan, applied } = await rehome(s, A.cid, B.pid);
  assert(applied, 'the opening row says it applied');
  assert.equal(plan.fromPersonId, A.pid);
  assert.equal(plan.toPersonId, B.pid);
  assert.equal(plan.wasMain, true);
  assert.equal(plan.statements.length, 11, 'the batch: opening audit, 4 sign-up and stale statements, move, Main, placeholder, alias, older aliases, versions (one read before it)');

  // the character: B's now, on its team (B has none there), not the Main (B has one)
  const moved = sOne(s, 'SELECT * FROM characters WHERE id = ?', A.cid);
  assert.deepEqual([moved.player_id, moved.team_id, moved.is_main, moved.name, moved.name_key, moved.updated_at], [B.pid, alpha, 0, 'Foo', 'foo', teamBefore.updated_at], 'updated_at stays: the Trial clock reads it');
  // the old person: still there, Fooalt is the Main, the placeholder is hidden away
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', A.pid).n, 1, 'a re-home never deletes the old person');
  const altRow = sOne(s, 'SELECT is_main FROM characters WHERE id = ?', fooAlt);
  assert.equal(altRow.is_main, 1, 'another character of the old person is the Main now');
  const placeholder = sOne(s, 'SELECT * FROM characters WHERE id = ?', plan.placeholderId);
  assert.deepEqual(
    [placeholder.player_id, placeholder.team_id, placeholder.name, placeholder.name_key, placeholder.realm_key, placeholder.class, placeholder.is_main, placeholder.core_rank, placeholder.left_reason],
    [A.pid, null, 'Foo', `~ph:${plan.placeholderId}`, 'nightslayer', 'MAGE', 0, 'social', 'other'], 'a Former, Social, teamless, non-Main character with a reserved key');
  assert.match(placeholder.left_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual([placeholder.owner_proof, placeholder.proof_user_id, placeholder.namespace, placeholder.blizzard_char_id, placeholder.blizzard_realm_id], [null, null, null, null, null], 'no proof, no identity key');
  // the alias: the moved character's name and realm, dated at the re-home, pointing at the placeholder; the older alias followed it
  const aliases = sAll(s, 'SELECT name_key, realm_key, renamed_at, character_id FROM character_name_aliases WHERE guild_id = ? ORDER BY name_key', s.gid);
  assert.deepEqual(aliases, [
    { name_key: 'foo', realm_key: 'nightslayer', renamed_at: s.w.clock.now, character_id: plan.placeholderId },
    { name_key: 'foold', realm_key: 'nightslayer', renamed_at: 5, character_id: plan.placeholderId },
  ]);
  // versions
  assert.deepEqual(versions(), { a: before.a + 1, b: before.b + 1 });
  // sign-ups: the ones naming the character are gone, the alt's and the person's remain; the standing ones likewise
  assert.deepEqual(sAll(s, 'SELECT character_id FROM raid_signups WHERE raid_id = ? ORDER BY signup_id', rf), [], 'the sign-up naming the moved character is gone');
  assert.deepEqual(sAll(s, 'SELECT character_id FROM raid_signups WHERE raid_id = ? ORDER BY signup_id', rf2), [{ character_id: fooAlt }], 'the one naming the alt stays');
  assert.deepEqual(sAll(s, 'SELECT weekday, character_id FROM standing_signups WHERE player_id = ? ORDER BY weekday', A.pid), [{ weekday: 4, character_id: fooAlt }, { weekday: 5, character_id: null }]);
  // stale: the upcoming raid and the raids of the character's team
  for (const raidId of [rf, r1, r2]) assert.equal(sOne(s, 'SELECT policy_fp FROM raids WHERE id = ?', raidId).policy_fp, '', `${raidId} is marked stale`);
  // the audit row: ids and flags, no names
  const audit = sAll(s, "SELECT * FROM audit_log WHERE action = 'character.rehome'");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].entity_type, audit[0].entity_id, audit[0].actor_user_id, audit[0].guild_id], ['character', A.cid, s.uids.gm, s.gid]);
  assert.deepEqual(JSON.parse(audit[0].before), { personId: A.pid, teamId: alpha, wasMain: true });
  assert.deepEqual(JSON.parse(audit[0].after), { personId: B.pid, placeholderId: plan.placeholderId, reason: 'bnet_beats_link' });
  assert(!`${audit[0].before} ${audit[0].after}`.includes('Foo'));
  const shown = (await s.ok('gm', 'GET', '/audit?group=roster')).rows.find((row) => row.action === 'character.rehome');
  assert.equal(shown.text, 'Moved Foo from Fooalt to Bar, because the Battle.net account that owns it proved it', 'the old person is named by what it still has');
  assert.equal(shown.group, 'roster');
});

check('rehome: the old person\'s history stays on it - per-table row counts before and after, and loot resolved by name credits it for what was awarded before, the new person for what comes after', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  const A = await mk(s, 'Foo');
  const fooAlt = await s.alt(A.pid, 'Fooalt');
  const B = await mk(s, 'Bar', { teamId: bravo });
  const r1 = await raidOn(s, alpha, 10);
  const r2 = await raidOn(s, alpha, 11);
  const rf = await raidOn(s, alpha, 25);
  const rf2 = await raidOn(s, alpha, 26);
  await seedHistory(s, A.pid, 'Foo', { teamId: alpha, r1, r2, rf, rf2, characterId: A.cid, altId: fooAlt });
  const countsA = await evidenceCounts(s, A.pid);
  const countsB = await evidenceCounts(s, B.pid);
  assert(Object.values(countsA).filter((n) => n > 0).length >= 8, `the fixture holds rows in many tables: ${JSON.stringify(countsA)}`);
  const owners = await awardOwners(s, 'Foo');
  assert.deepEqual(Object.values(owners), [A.pid, A.pid], 'before: both awards are the old person\'s');

  const letters = { bnet_beats_link: 'alpha', collision: 'beta', gm_claim: 'gamma' };
  for (const [index, reason] of ['bnet_beats_link', 'collision', 'gm_claim'].entries()) {
    // each reason, on a fresh pair: the same counts hold (the three triggers share the module)
    const x = await mk(s, `Xfoo${letters[reason]}`);
    const y = await mk(s, `Yfoo${letters[reason]}`, { teamId: bravo });
    const xAlt = await s.alt(x.pid, `Xalt${letters[reason]}`);
    const rx1 = await raidOn(s, alpha, 3 + 2 * index);
    const rx2 = await raidOn(s, alpha, 4 + 2 * index);
    await seedHistory(s, x.pid, `Xfoo${letters[reason]}`, { teamId: alpha, r1: rx1, r2: rx2, rf, rf2, characterId: x.cid, altId: xAlt });
    const beforeX = await evidenceCounts(s, x.pid);
    const { applied } = await rehome(s, x.cid, y.pid, { reason });
    assert(applied, reason);
    assert.deepEqual(await evidenceCounts(s, x.pid), beforeX, `${reason}: nothing of the old person's moved or went`);
  }

  const { applied } = await rehome(s, A.cid, B.pid);
  assert(applied);
  assert.deepEqual(await evidenceCounts(s, A.pid), countsA, 'every table: the old person has the rows it had');
  assert.deepEqual(await evidenceCounts(s, B.pid), countsB, 'and the new person gained none of them');
  assert.deepEqual(Object.values(await awardOwners(s, 'Foo')), [A.pid, A.pid], 'loot awarded before the re-home still resolves to the old person (through the placeholder)');
  // an award after the re-home (a later date) resolves to the live name: the new person's character
  const later = sOne(s, 'SELECT starts_at FROM raids WHERE id = ?', r2).starts_at;
  sRun(s, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key, created_at, updated_at)
           VALUES ('lo_later0000000000000000001', ?, ?, ?, 'later-chk', 30001, 'Axe', ?, 'Foo', 'foo', 'Nightslayer', 'nightslayer', 1, 1)`, s.gid, r2, alpha, s.w.clock.now + 5 * DAY);
  void later;
  const owners2 = await awardOwners(s, 'Foo');
  assert.equal(owners2.lo_later0000000000000000001, B.pid, 'an award dated after the re-home is the new person\'s');
  // the person page of loot reads the same through the route
  const loot = await s.ok('gm', 'GET', `/loot/person/${A.pid}`);
  assert.equal(loot.awards.length, 2, 'the old person\'s loot page still lists what it was awarded');
  const lootB = await s.ok('gm', 'GET', `/loot/person/${B.pid}`);
  assert.equal(lootB.awards.length, 1, 'and the new person\'s the one after');
});

check('rehome: a recompute of an old raid still credits the old person (the placeholder carries the name), a raid after the re-home credits the new person', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  const A = await mk(s, 'Foo');
  await s.alt(A.pid, 'Fooalt');
  const B = await mk(s, 'Bar', { teamId: bravo });
  const old = await raidOn(s, alpha, 10);
  addLog(s, old, ['Foo']);
  await s.ok('gm', 'POST', `/raids/${old}/recompute`, {}, 200);
  assert.deepEqual(attendanceOf(s, old), { [A.pid]: ['present', 1] });
  const { applied } = await rehome(s, A.cid, B.pid);
  assert(applied);
  assert.equal(sOne(s, 'SELECT policy_fp FROM raids WHERE id = ?', old).policy_fp, '', 'the raid with Foo in its log is stale');
  // (the old person has no character on the team any more, so it was there as a fill-in; the new person is on the roster now and was not in the log)
  const attended = (raidId, personId) => (attendanceOf(s, raidId)[personId] || ['none', 0])[1];
  await s.ok('gm', 'POST', `/raids/${old}/recompute`, {}, 200);
  assert.equal(attended(old, A.pid), 1, 'a recompute: Foo of that night is still the old person');
  assert.equal(attended(old, B.pid), 0, 'and the new person was not there');
  sRun(s, 'DELETE FROM attendance WHERE raid_id = ?', old);
  await s.ok('gm', 'POST', `/raids/${old}/recompute`, {}, 200);
  assert.equal(attended(old, A.pid), 1, 'from the log alone, with no stored result');
  assert.equal(attended(old, B.pid), 0);
  const page = await s.ok('gm', 'GET', `/raids/${old}`);
  assert.deepEqual(page.unmatched, [], 'nobody in the log is unmatched');
  assert(page.people.some((person) => person.name === 'Fooalt'), 'the old person is on the raid page under the name it still has');
  assert(!JSON.stringify(page).includes('~ph:'), 'and the placeholder\'s key shows nowhere');

  // a raid after the re-home: the same log name is the new person's
  s.w.advance(20 * DAY);
  const after = await raidOn(s, alpha, 28);
  addLog(s, after, ['Foo']);
  await s.ok('gm', 'POST', `/raids/${after}/recompute`, {}, 200);
  assert.equal(attended(after, B.pid), 1, 'the new person was there');
  assert.equal(attended(after, A.pid), 0, 'the old person was not');
  assert.equal(attended(old, A.pid), 1, 'and the old raid did not change');
});

check('rehome: the old person\'s Main - another visible character takes over (not Former first, best rank first); a person with nothing else gets the placeholder as its Main; a character that was not the Main leaves the Main alone', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  const B = await mk(s, 'Bar', { teamId: bravo });
  // a Main with three others: a Former one, a Trial one, a Raider one
  const A = await mk(s, 'Mainfoo');
  const former = rawCharacter(s, A.pid, 'Formeralt', { leftOn: '2026-12-01' });
  const trial = rawCharacter(s, A.pid, 'Trialalt');
  sRun(s, "UPDATE characters SET core_rank = 'trial' WHERE id = ?", trial);
  const raider = rawCharacter(s, A.pid, 'Raideralt');
  assert((await rehome(s, A.cid, B.pid)).applied);
  const mains = sAll(s, 'SELECT id FROM characters WHERE player_id = ? AND is_main = 1', A.pid).map((row) => row.id);
  assert.deepEqual(mains, [raider], 'the raiding, not-Former character takes over');
  void former; void trial;

  // a non-Main goes: the Main stays and the placeholder is no Main
  const C = await mk(s, 'Cmain');
  const cAlt = await s.alt(C.pid, 'Calt');
  const D = await mk(s, 'Dmain', { teamId: bravo });
  const placeholderOf = async (res) => sOne(s, 'SELECT is_main FROM characters WHERE id = ?', res.plan.placeholderId);
  const res = await rehome(s, cAlt, D.pid);
  assert(res.applied);
  assert.equal(sOne(s, 'SELECT is_main FROM characters WHERE id = ?', C.cid).is_main, 1);
  assert.equal((await placeholderOf(res)).is_main, 0);
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ? AND is_main = 1', C.pid).n, 1);

  // the only character: the placeholder is the Main (the person keeps one Main, as every person has)
  const E = await mk(s, 'Emain');
  const F = await mk(s, 'Fmain', { teamId: bravo });
  const sole = await rehome(s, E.cid, F.pid);
  assert(sole.applied);
  assert.equal((await placeholderOf(sole)).is_main, 1, 'nothing else is left: the placeholder is the Main');
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ?', E.pid).n, 1);
  // the moved character: the new person has a Main, so it is an alt; when the new person has none, it becomes the Main
  assert.equal(sOne(s, 'SELECT is_main FROM characters WHERE id = ?', E.cid).is_main, 0);
  const G = await mk(s, 'Gmain');
  const H = await mk(s, 'Hmain', { teamId: bravo });
  sRun(s, 'UPDATE characters SET player_id = ?, is_main = 0 WHERE id = ?', G.pid, H.cid); // H's Main goes to G: H is empty and has no Main
  sRun(s, 'DELETE FROM players WHERE id = ?', H.pid);
  const I = await mk(s, 'Imain', { teamId: bravo });
  const fresh = s.w.db.sqlite;
  fresh.prepare("INSERT INTO players (id, guild_id, status, joined_on, created_at, updated_at) VALUES ('p_nomain000000000000001', ?, 'raider', '2027-01-01', 1, 1)").run(s.gid);
  const into = await rehome(s, I.cid, 'p_nomain000000000000001');
  assert(into.applied);
  assert.equal(sOne(s, 'SELECT is_main FROM characters WHERE id = ?', I.cid).is_main, 1, 'a person with no Main takes the moved character as its Main');
  void alpha;
});

check('rehome: a team the new person already has a character on is cleared on the moved character; a lost guard (a concurrent edit, a moved character, a full person) makes every statement a no-op; the refusals', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  const A = await mk(s, 'Afoo');
  const B = await mk(s, 'Bbar'); // on Alpha too
  assert.equal((await rehome(s, A.cid, B.pid)).applied, true);
  assert.equal(sOne(s, 'SELECT team_id FROM characters WHERE id = ?', A.cid).team_id, null, 'one character per team and person: the moved one goes teamless');
  assert.equal(sOne(s, 'SELECT team_id FROM characters WHERE id = ?', B.cid).team_id, alpha);

  // a concurrent edit between the plan and the batch
  const C = await mk(s, 'Cfoo');
  const cAlt = await s.alt(C.pid, 'Calt');
  const D = await mk(s, 'Dbar', { teamId: bravo });
  const dump = () => JSON.stringify(['players', 'characters', 'character_name_aliases', 'audit_log', 'raids', 'raid_signups', 'standing_signups'].map((table) => sAll(s, `SELECT * FROM ${table} ORDER BY 1, 2`)));
  const planned = await rehome(s, C.cid, D.pid, { run: false });
  sRun(s, 'UPDATE players SET version = version + 1 WHERE id = ?', D.pid);
  const frozen = dump();
  const results = await s.w.db.batch(planned.plan.statements);
  assert.equal(results[planned.plan.appliedIndex].meta.changes, 0, 'the opening row was refused');
  assert.equal(dump(), frozen, 'and every statement was a no-op');
  // a caller's guard
  const never = await rehome(s, C.cid, D.pid, { guards: [{ sql: '1 = 0', params: [] }], run: false });
  const frozen2 = dump();
  const refused = await s.w.db.batch(never.plan.statements);
  assert.equal(refused[never.plan.appliedIndex].meta.changes, 0);
  assert.equal(dump(), frozen2);
  // the character moved in between
  const planned2 = await rehome(s, cAlt, D.pid, { run: false });
  sRun(s, 'UPDATE characters SET player_id = ?, team_id = NULL WHERE id = ?', B.pid, cAlt);
  const frozen3 = dump();
  assert.equal((await s.w.db.batch(planned2.plan.statements))[planned2.plan.appliedIndex].meta.changes, 0);
  assert.equal(dump(), frozen3);

  // the refusals of the module
  const { rehomeStatements } = await moduleOf('worker/rehome.js');
  const base = { guildId: s.gid, actorUserId: s.uids.gm, now: s.w.clock.now, reason: 'bnet_beats_link', randomBytes: s.w.randomBytes };
  await assert.rejects(() => rehomeStatements(s.w.db, { ...base, characterId: D.cid, toPersonId: D.pid }), (error) => error.status === 400, 'already on that person');
  await assert.rejects(() => rehomeStatements(s.w.db, { ...base, characterId: 'c_nobody00000000000000a', toPersonId: D.pid }), (error) => error.status === 404, 'no such character');
  await assert.rejects(() => rehomeStatements(s.w.db, { ...base, characterId: D.cid, toPersonId: 'p_nobody00000000000000a' }), (error) => error.status === 404, 'no such person');
  await assert.rejects(() => rehomeStatements(s.w.db, { ...base, characterId: D.cid, toPersonId: B.pid, reason: 'nope' }), /reason/);
  const placeholder = sOne(s, "SELECT id FROM characters WHERE name_key LIKE '~ph:%' LIMIT 1").id;
  await assert.rejects(() => rehomeStatements(s.w.db, { ...base, characterId: placeholder, toPersonId: D.pid }), (error) => error.status === 400, 'a placeholder is never moved');
  // another guild's person
  const other = await scenario({ teams: ['Zeta', 'Eta'] });
  const stranger = await other.person({ name: 'Zfoo' });
  await assert.rejects(() => rehomeStatements(s.w.db, { ...base, characterId: D.cid, toPersonId: stranger.pid }), (error) => error.status === 404, 'a person of another guild');
});

check('the placeholder is hidden: the roster, the person page, the pickers and Users show nothing of it, and a person that has only a placeholder shows no characters', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  const A = await mk(s, 'Foo');
  const fooAlt = await s.alt(A.pid, 'Fooalt');
  const B = await mk(s, 'Bar', { teamId: bravo });
  const E = await mk(s, 'Lonely');
  await s.link(E.pid, 'm1');
  const F = await mk(s, 'Fhome', { teamId: bravo });
  assert((await rehome(s, A.cid, B.pid)).applied);
  assert((await rehome(s, E.cid, F.pid)).applied);
  const placeholders = sAll(s, "SELECT id, player_id, name FROM characters WHERE name_key LIKE '~ph:%'");
  assert.equal(placeholders.length, 2);
  const everything = (value) => JSON.stringify(value);
  const hidden = (value) => placeholders.every((row) => !everything(value).includes(row.id));

  const rosterAlpha = await s.ok('gm', 'GET', `/roster?team=${alpha}`);
  assert(hidden(rosterAlpha));
  const people = Object.fromEntries(rosterAlpha.people.map((person) => [person.id, person]));
  assert(!people[A.pid], 'the old person has no character on Alpha any more');
  assert(!people[E.pid], 'a person with only a placeholder is on no roster');
  assert.deepEqual(people[B.pid].names, ['Foo'], 'the new person is listed by the moved character, which sits on Alpha');
  assert.equal(people[B.pid].main.name, 'Bar', 'its Main is still Bar');
  const rosterBravo = await s.ok('gm', 'GET', `/roster?team=${bravo}`);
  assert(hidden(rosterBravo));
  assert.deepEqual(rosterBravo.people.find((person) => person.id === F.pid).names, ['Fhome'], 'Lonely went to F with its team cleared (one character per team and person)');

  const pageA = await s.ok('gm', 'GET', `/roster/${A.pid}`);
  assert(hidden(pageA));
  assert.deepEqual(pageA.characters.map((character) => [character.name, character.isMain]), [['Fooalt', true]], 'the old person page: its remaining character, now the Main');
  const pageB = await s.ok('gm', 'GET', `/roster/${B.pid}`);
  assert.deepEqual(pageB.characters.map((character) => character.name).sort(), ['Bar', 'Foo']);
  const lonely = await s.ok('gm', 'GET', `/roster/${E.pid}`);
  assert.deepEqual(lonely.characters, [], 'a person with nothing but a placeholder shows no characters');
  assert(hidden(lonely));

  const unassigned = await s.ok('gm', 'GET', '/roster/unassigned');
  assert(hidden(unassigned));
  assert.deepEqual(unassigned.characters.map((character) => character.name).sort(), ['Fooalt'], 'the Add to team picker lists real characters only');
  // Users: the account linked to the emptied person has no roster entry
  const peoplePage = await s.ok('gm', 'GET', '/people');
  const memberOne = JSON.stringify(peoplePage).includes(s.uids.m1);
  assert(memberOne, 'the account is still listed');
  const entry = (peoplePage.people || peoplePage.members || []).find((item) => item.id === s.uids.m1 || (item.person && item.person.id === s.uids.m1));
  if (entry) assert.equal(entry.roster, null, 'but without a roster entry named after the placeholder');
  assert(hidden(peoplePage));
  // the audit view names the emptied person by its placeholder (history stays readable), the others by what they have
  const rows = (await s.ok('gm', 'GET', '/audit?group=roster')).rows.filter((row) => row.action === 'character.rehome');
  assert.deepEqual(rows.map((row) => row.text).sort(), [
    'Moved Foo from Fooalt to Bar, because the Battle.net account that owns it proved it',
    'Moved Lonely from Lonely to Fhome, because the Battle.net account that owns it proved it',
  ]);
});

check('the placeholder does not count: the 20-character cap of a re-home and of the person join count visible characters', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  // T has 19 visible characters and 5 placeholders (moved in by a raw UPDATE: the INSERT trigger of migration 0030 counts every row)
  const T = await mk(s, 'Tmain', { teamId: bravo });
  for (let i = 1; i < 19; i++) rawCharacter(s, T.pid, `Talt${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
  const parking = await mk(s, 'Parking');
  for (let i = 0; i < 5; i++) {
    const id = rawCharacter(s, parking.pid, `Retired${i}`, { key: `~ph:c_cap${i}`, leftOn: '2026-12-01' });
    sRun(s, 'UPDATE characters SET player_id = ? WHERE id = ?', T.pid, id);
  }
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ?', T.pid).n, 24);
  const first = await mk(s, 'Firstmove');
  const second = await mk(s, 'Secondmove');
  assert((await rehome(s, first.cid, T.pid)).applied, 'the 20th visible character fits (24 rows, 19 visible)');
  const { rehomeStatements } = await moduleOf('worker/rehome.js');
  await assert.rejects(
    () => rehomeStatements(s.w.db, { guildId: s.gid, characterId: second.cid, toPersonId: T.pid, actorUserId: s.uids.gm, now: s.w.clock.now, reason: 'bnet_beats_link', randomBytes: s.w.randomBytes }),
    (error) => error.status === 409 && error.code === 'rehome_too_many_characters', 'the 21st is refused: 20 visible');

  // the person join: 10 + 10 visible characters and 6 placeholders on one of them is 20, not 26
  const J1 = await mk(s, 'Jone');
  for (let i = 1; i < 10; i++) rawCharacter(s, J1.pid, `Jonealt${String.fromCharCode(97 + i)}`);
  const J2 = await mk(s, 'Jtwo');
  for (let i = 1; i < 10; i++) rawCharacter(s, J2.pid, `Jtwoalt${String.fromCharCode(97 + i)}`);
  for (let i = 0; i < 6; i++) {
    const id = rawCharacter(s, parking.pid, `Retiredj${i}`, { key: `~ph:c_join${i}`, leftOn: '2026-12-01' });
    sRun(s, 'UPDATE characters SET player_id = ? WHERE id = ?', J1.pid, id);
  }
  const versions = (a, b) => ({ version: sOne(s, 'SELECT version FROM players WHERE id = ?', a).version, otherVersion: sOne(s, 'SELECT version FROM players WHERE id = ?', b).version });
  const joined = await s.call('o1', 'POST', `/roster/${J1.pid}/join`, { otherPersonId: J2.pid, ...versions(J1.pid, J2.pid) });
  assert.equal(joined.status, 200, joined.text);
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ?', joined.json.survivorId).n, 26, 'the placeholders moved along');
  assert.equal(joined.json.characters.length, 20, 'and the person shows its 20 visible characters');
  // one visible character too many is still refused
  const K1 = await mk(s, 'Kone');
  for (let i = 1; i < 11; i++) rawCharacter(s, K1.pid, `Konealt${String.fromCharCode(97 + i)}`);
  const K2 = await mk(s, 'Ktwo');
  for (let i = 1; i < 10; i++) rawCharacter(s, K2.pid, `Ktwoalt${String.fromCharCode(97 + i)}`);
  const refused = await s.call('o1', 'POST', `/roster/${K1.pid}/join`, { otherPersonId: K2.pid, ...versions(K1.pid, K2.pid) });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.error, 'join_too_many_characters');
  void alpha;
});

check('a join with a retired placeholder: the survivor keeps ONE visible Main (an emptied survivor hands its placeholder Main over), and the placeholder moves with its person', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  // E is emptied (only a placeholder, its Main), then joined with a person that has a real Main
  const E = await mk(s, 'Emptied');
  const F = await mk(s, 'Fhome', { teamId: bravo });
  const res = await rehome(s, E.cid, F.pid);
  assert(res.applied);
  const G = await mk(s, 'Gmain');
  const versions = (a, b) => ({ version: sOne(s, 'SELECT version FROM players WHERE id = ?', a).version, otherVersion: sOne(s, 'SELECT version FROM players WHERE id = ?', b).version });
  // the officer opens the emptied person; neither is account-linked: the older survives (E)
  const joined = await s.call('o1', 'POST', `/roster/${E.pid}/join`, { otherPersonId: G.pid, ...versions(E.pid, G.pid) });
  assert.equal(joined.status, 200, joined.text);
  const survivor = joined.json.survivorId;
  assert.equal(survivor, E.pid, 'the older person survives');
  const mains = sAll(s, 'SELECT id, name FROM characters WHERE player_id = ? AND is_main = 1', survivor);
  assert.deepEqual(mains.map((row) => row.name), ['Gmain'], 'one Main, the visible one');
  assert.equal(sOne(s, 'SELECT COUNT(*) AS n FROM characters WHERE player_id = ? AND name_key LIKE ?', survivor, '~ph:%').n, 1, 'the placeholder came along');
  assert.deepEqual(joined.json.characters.map((character) => character.name), ['Gmain']);
  void alpha;
});

check('membership: a person with only a placeholder is on no in-game roster (the placeholder has no key); the officer link and unlink of a person with a Battle.net-proved character are the Owner\'s', async () => {
  const s = await guildWorld();
  const [alpha, bravo] = s.tids;
  const { personOnRosterSql } = await moduleOf('worker/membership.js');
  const E = await mk(s, 'Emptied');
  const F = await mk(s, 'Fhome', { teamId: bravo });
  // E's only character is on the in-game roster (a keyed, rostered character)
  sRun(s, "INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES (?, 'profile-classicann-us', 4002, 9101, 'Emptied', 'emptied', 'nightslayer', 'MAGE', 70, 3)", s.gid);
  sRun(s, "UPDATE characters SET namespace = 'profile-classicann-us', blizzard_realm_id = 4002, blizzard_char_id = 9101 WHERE id = ?", E.cid);
  const on = () => sOne(s, `SELECT ${personOnRosterSql('?', '?')} AS on_roster`, s.gid, E.pid).on_roster;
  assert.equal(on(), 1);
  assert((await rehome(s, E.cid, F.pid)).applied);
  assert.equal(on(), 0, 'what is left of the person is a placeholder: no identity key, so not on the roster');

  // Owner-only: a person holding a character proved by Battle.net
  const P = await mk(s, 'Proven');
  const Q = await mk(s, 'Plain');
  sRun(s, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = '710', proof_at = 5 WHERE id = ?", s.uids.m2, P.cid);
  const link = (who, pid, userId) => s.call(who, 'PUT', `/roster/${pid}/account`, { userId });
  const refusedLink = await link('o1', P.pid, s.uids.m1);
  assert.equal(refusedLink.status, 403, refusedLink.text);
  assert.equal(refusedLink.json.error, 'forbidden');
  assert.match(refusedLink.json.message, /Owner/);
  assert.equal(sOne(s, 'SELECT user_id FROM players WHERE id = ?', P.pid).user_id, null);
  assert.equal((await link('o1', Q.pid, s.uids.m1)).status, 200, 'a person with no proved character is the officer\'s to link');
  assert.equal((await link('o1', Q.pid, null)).status, 200, '... and to unlink');
  // the Owner (the Guild Master) may
  const owned = await link('gm', P.pid, s.uids.m1);
  assert.equal(owned.status, 200, owned.text);
  assert.equal(sOne(s, 'SELECT user_id FROM players WHERE id = ?', P.pid).user_id, s.uids.m1);
  sRun(s, "UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = '711', proof_at = 5 WHERE id = ?", s.uids.m1, P.cid); // the link cleared the proof: put it back
  const refusedUnlink = await link('o1', P.pid, null);
  assert.equal(refusedUnlink.status, 403, refusedUnlink.text);
  assert.equal(sOne(s, 'SELECT user_id FROM players WHERE id = ?', P.pid).user_id, s.uids.m1, 'nothing changed');
  assert.equal((await link('gm', P.pid, null)).status, 200, 'the Owner unlinks it');
  void alpha;
});


// ---------------------------------------------------------------------------
// World 1 again: the sign-in flows

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextSerial = (() => { let n = 5000; return () => ++n; })();

// A team and four raids in the world: two past ones, two upcoming ones. -> { team, past: [r1, r2], future: [f1, f2] }
function seedRaids(w, G) {
  const team = `t_${pad(nextSerial())}`;
  w.run("INSERT INTO teams (id, guild_id, name, created_at) VALUES (?, ?, 'Alpha', 1)", team, G);
  const raid = (days) => {
    const id = `r_${pad(nextSerial())}`;
    const startsAt = T0 + days * 86_400_000;
    w.run("INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, created_at, updated_at, policy_fp) VALUES (?, ?, ?, ?, ?, 1, 1, 'fp')", id, G, team, iso(startsAt), startsAt);
    return id;
  };
  return { team, past: [raid(-3), raid(-2)], future: [raid(3), raid(4)] };
}

// History of a person in every table a re-home must leave alone; upcoming sign-ups naming characterId (on f1) and altId (on f2); loot awarded to `name` in the past raids.
function seedPersonHistory(w, G, personId, name, { team, past: [r1, r2], future: [f1, f2] }, { characterId, altId }) {
  const sid = (prefix) => `${prefix}_${pad(nextSerial())}`;
  const att = (raidId, outcome) => w.run('INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, 1, 1)', raidId, G, team, personId, outcome);
  att(r1, 'present'); att(r2, 'missed');
  w.run("INSERT INTO attendance_decisions (raid_id, player_id, guild_id, outcome, credit, reason, flags, decided_at) VALUES (?, ?, ?, 'bench', 0, 'Told us', '[]', 1)", r1, personId, G);
  w.run('INSERT INTO raid_manual (raid_id, guild_id, player_id) VALUES (?, ?, ?)', r1, G, personId);
  w.run("INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, created_at, updated_at) VALUES (?, ?, ?, 'away', '2027-03-01', '2027-03-02', 1, 1)", sid('an'), G, personId);
  let round = (w.one("SELECT id FROM intent_rounds WHERE team_id = ? AND status = 'open'", team) || {}).id;
  if (!round) { round = sid('ir'); w.run("INSERT INTO intent_rounds (id, guild_id, team_id, title, status, created_at) VALUES (?, ?, ?, 'Round', 'open', 1)", round, G, team); }
  w.run("INSERT INTO intent_picks (round_id, guild_id, player_id, kind, class, spec, role, updated_at) VALUES (?, ?, ?, 'main', 'MAGE', 'Fire', 'ranged', 1)", round, G, personId);
  w.run("INSERT INTO raid_duties (raid_id, guild_id, duty, player_id) VALUES (?, ?, 'leader', ?)", r1, G, personId);
  const winnerKey = name.toLowerCase();
  [r1, r2].forEach((raidId, i) => w.run(
    `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 30000, 'Sword', ?, ?, ?, 'Dreamscythe', 'dreamscythe', 1, 1)`, sid('lo'), G, raidId, team, `${name}-${nextSerial()}`, T0 - (3 - i) * 86_400_000 + 3_600_000, name, winnerKey));
  w.run("INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, character_id, created_at, updated_at) VALUES (?, 'raidsmith', ?, 'signed', 1, ?, ?, ?, 1, 1)", f1, nextSerial(), G, personId, characterId);
  w.run("INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id, character_id, created_at, updated_at) VALUES (?, 'raidsmith', ?, 'signed', 2, ?, ?, ?, 1, 1)", f2, nextSerial(), G, personId, altId);
  w.run("INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, 2, 'signed', ?, 1, 1)", sid('sg'), G, team, personId, characterId);
  w.run("INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, 4, 'signed', ?, 1, 1)", sid('sg'), G, team, personId, altId);
}

// The rows a person holds in every table of the person join but the characters and the sign-ups.
async function personCounts(w, personId) {
  const { JOIN_TABLES } = await load('worker/person-join.js');
  const out = {};
  for (const table of Object.keys(JOIN_TABLES)) {
    if (['characters', 'raid_signups', 'standing_signups'].includes(table)) continue;
    out[table] = w.count(table, 'player_id = ?', personId);
  }
  return out;
}

// Who the loot awards of this winner name resolve to (the way every loot reader reads them).
async function winnersOf(w, name) {
  const { winnerNameKeySql } = await load('worker/name-alias.js');
  return w.rows(
    `SELECT a.awarded_at, (SELECT c.player_id FROM characters c WHERE c.guild_id = a.guild_id AND c.name_key = ${winnerNameKeySql('a')} AND c.realm_key = a.winner_realm_key) AS owner
       FROM loot_awards a WHERE a.winner_name = ? ORDER BY a.awarded_at`, name).map((row) => row.owner);
}

const placeholdersOf = (w, personId) => w.rows("SELECT * FROM characters WHERE player_id = ? AND name_key LIKE '~ph:%'", personId);
const auditOf = (w, action) => w.rows('SELECT * FROM audit_log WHERE action = ? ORDER BY created_at, id', action).map((row) => ({ ...row, before: row.before && JSON.parse(row.before), after: row.after && JSON.parse(row.after) }));
const dumpAll = (w) => JSON.stringify(['players', 'characters', 'character_name_aliases', 'person_joins', 'guild_blocks', 'raid_signups', 'standing_signups'].map((table) => w.rows(`SELECT * FROM ${table} ORDER BY 1, 2`))
  .concat([w.rows("SELECT * FROM audit_log WHERE action != 'bnet.link' ORDER BY id")]));

check('Battle.net beats an officer link: the proving account gets the character, the old person keeps its history, a placeholder, its other character as Main and nothing else of the character', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2], ['Cassia', 3]]);
  const bea = await makeAccount(w, BNET.bea);
  // an officer linked Bea's account to this person: Aldric (Main) and Brindle, both typed in by an officer and bound to the roster by "Match to roster"
  w.raw.person(PID(1), G, { userId: bea.userId, created: 10 });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w.raw.character(CID(2), G, PID(1), 'Brindle', { proof: 'officer' });
  const raids = seedRaids(w, G);
  seedPersonHistory(w, G, PID(1), 'Aldric', raids, { characterId: CID(1), altId: CID(2) });
  const countsBefore = await personCounts(w, PID(1));
  assert(Object.values(countsBefore).filter((n) => n > 0).length >= 6, JSON.stringify(countsBefore));
  const versionBefore = w.one('SELECT version FROM players WHERE id = ?', PID(1)).version;
  assert.deepEqual(await winnersOf(w, 'Aldric'), [PID(1), PID(1)]);

  w.serve(['Aldric']);
  w.logs.length = 0;
  const { jar, statements } = await bnetSignIn(w, BNET.ann);
  const annId = userOf(w, BNET.ann);
  const person = personOf(w, annId, G);
  assert(person, 'Ann got a person');
  const aldric = w.one('SELECT * FROM characters WHERE id = ?', CID(1));
  assert.deepEqual([aldric.player_id, aldric.is_main, aldric.name_key, aldric.owner_proof, aldric.proof_user_id, aldric.proof_bnet_account_id, aldric.proof_at, aldric.team_id],
    [person.id, 1, 'aldric', 'bnet', annId, BNET.ann.id, T0, null], 'Aldric is Ann\'s: the Main of her new person, proved by her Battle.net account');
  assert.deepEqual(charactersOf(w, person.id).map((row) => row.name), ['Aldric']);

  // the old person: still there, still Bea's, Brindle is its Main now, a placeholder holds its place
  const old = w.one('SELECT * FROM players WHERE id = ?', PID(1));
  assert.equal(old.user_id, bea.userId);
  assert.equal(old.version, versionBefore + 1);
  assert.equal(w.one('SELECT is_main FROM characters WHERE id = ?', CID(2)).is_main, 1);
  const placeholders = placeholdersOf(w, PID(1));
  assert.equal(placeholders.length, 1);
  assert.deepEqual([placeholders[0].name, placeholders[0].core_rank, placeholders[0].is_main, placeholders[0].team_id, placeholders[0].blizzard_char_id, placeholders[0].owner_proof], ['Aldric', 'social', 0, null, null, null]);
  assert(placeholders[0].left_on, 'Former');
  const alias = w.rows('SELECT * FROM character_name_aliases');
  assert.deepEqual(alias.map((row) => [row.name_key, row.realm_key, row.character_id, row.renamed_at]), [['aldric', 'dreamscythe', placeholders[0].id, T0]]);
  // the history stayed
  assert.deepEqual(await personCounts(w, PID(1)), countsBefore, 'per-table row counts of the old person are equal before and after');
  assert.deepEqual(await winnersOf(w, 'Aldric'), [PID(1), PID(1)], 'the loot awarded to Aldric before still resolves to the old person');
  assert.equal(w.count('raid_signups', 'character_id = ?', CID(1)), 0, 'the upcoming sign-up naming the character is gone');
  assert.equal(w.count('raid_signups', 'character_id = ?', CID(2)), 1, 'the one naming the other character stays');
  assert.equal(w.count('standing_signups', 'character_id = ?', CID(1)), 0);
  assert.equal(w.count('standing_signups', 'character_id = ?', CID(2)), 1);
  assert.equal(w.one('SELECT policy_fp FROM raids WHERE id = ?', raids.future[0]).policy_fp, '', 'the upcoming raid that lost a sign-up is stale');
  for (const raidId of [...raids.past, raids.future[1]]) assert.equal(w.one('SELECT policy_fp FROM raids WHERE id = ?', raidId).policy_fp, 'fp', 'the character is on no team and in no log: the other raids are untouched');
  // the audit rows and the log
  const rehomed = auditOf(w, 'character.rehome');
  assert.equal(rehomed.length, 1);
  assert.deepEqual([rehomed[0].actor_user_id, rehomed[0].entity_id, rehomed[0].before.personId, rehomed[0].after.personId, rehomed[0].after.reason], [annId, CID(1), PID(1), person.id, 'bnet_beats_link']);
  assert.equal(auditOf(w, 'character.proof_supersede').length, 0, 'an officer proof is not a Battle.net proof: nothing was superseded');
  assert.deepEqual(w.logs.filter((line) => /bnet match/.test(line)), [], 'nothing deferred');
  assert(statements <= 45, `${statements} statements`);
  measured.rehomeBeatsLink = statements;
  // Ann is a member now, Bea still is (her person still holds Brindle, on the roster)
  assert.equal((await w.call(jar, 'GET', `/api/guild/${G}`)).status, 200);
  assert.equal((await w.call(bea.jar, 'GET', `/api/guild/${G}`)).status, 200);

  // the next sign-in changes nothing
  const before = dumpAll(w).replace(/"proof_at":\d+/g, '');
  w.advance(60_000);
  await bnetSignIn(w, BNET.ann, jar);
  assert.equal(dumpAll(w).replace(/"proof_at":\d+/g, ''), before, 'the same rows');
});

check('Battle.net beats an officer link: a person left with nothing but a placeholder is no member of the in-game guild any more, and keeps its placeholder as Main', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1]]);
  const bea = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: bea.userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  assert.equal((await w.call(bea.jar, 'GET', `/api/guild/${G}`)).status, 200, 'before: Bea is on the roster through the linked person');
  w.serve(['Aldric']);
  const { jar } = await bnetSignIn(w, BNET.ann);
  const placeholders = placeholdersOf(w, PID(1));
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].is_main, 1, 'nothing else is left: the placeholder is the Main');
  assert.equal(w.count('players', 'id = ?', PID(1)), 1, 'the old person is not deleted');
  assert.equal(w.one('SELECT user_id FROM players WHERE id = ?', PID(1)).user_id, bea.userId, 'and stays linked');
  assert.equal((await w.call(bea.jar, 'GET', `/api/guild/${G}`)).status, 403, 'after: no identity key on the roster, so not a member');
  assert.equal((await w.call(jar, 'GET', `/api/guild/${G}`)).status, 200);
  assert.equal(w.one('SELECT is_main FROM characters WHERE id = ?', CID(1)).is_main, 1);
});

check('Battle.net beats a link by the proof clock: another account\'s NEWER Battle.net proof keeps the character where it is, an older one is superseded (with its audit row) and the character moves', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const bea = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: bea.userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'bnet', proofUser: bea.userId, proofBnet: BNET.bea.id, proofAt: T0 + 1000 });
  w.raw.character(CID(2), G, PID(1), 'Brindle');
  w.serve(['Aldric']);
  w.logs.length = 0;
  await bnetSignIn(w, BNET.ann);
  const annId = userOf(w, BNET.ann);
  assert.equal(w.one('SELECT player_id FROM characters WHERE id = ?', CID(1)).player_id, PID(1), 'a proof attested later than this snapshot stays');
  assert.equal(w.count('characters', "name_key LIKE '~ph:%'"), 0, 'nothing was left behind');
  assert.equal(w.count('audit_log', "action = 'character.rehome'"), 0);
  assert(logged(w, 'rehome'), 'the refusal is logged');
  assert.equal(w.one('SELECT proof_user_id FROM characters WHERE id = ?', CID(1)).proof_user_id, bea.userId);

  // an older proof of the other account: superseded, and the character moves
  w.run('UPDATE characters SET proof_at = ? WHERE id = ?', T0 - 1000, CID(1));
  w.logs.length = 0;
  w.advance(1000);
  await bnetSignIn(w, BNET.ann, {});
  const moved = w.one('SELECT player_id, owner_proof, proof_user_id, proof_bnet_account_id FROM characters WHERE id = ?', CID(1));
  assert.deepEqual(moved, { player_id: personOf(w, annId, G).id, owner_proof: 'bnet', proof_user_id: annId, proof_bnet_account_id: BNET.ann.id });
  const supersede = auditOf(w, 'character.proof_supersede');
  assert.equal(supersede.length, 1);
  assert.equal(supersede[0].before.userId, bea.userId);
  assert.equal(supersede[0].after.userId, annId);
  assert.equal(auditOf(w, 'character.rehome').length, 1);
});

check('the name collision, squat-then-enrol: an officer typed Aldric into someone else\'s person; Aldric\'s owner signs in with Battle.net, the key binds onto the typed character and it moves to her person', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const alice = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: alice.userId, created: 10 });
  w.raw.character(CID(1), G, PID(1), 'Brindle', { isMain: 1, proof: 'officer' });
  w.raw.character(CID(2), G, PID(1), 'Aldric', { key: false, proof: 'hand' });     // the squat: no key, same name and realm as the roster row
  const raids = seedRaids(w, G);
  seedPersonHistory(w, G, PID(1), 'Aldric', raids, { characterId: CID(2), altId: CID(1) });
  const countsBefore = await personCounts(w, PID(1));
  w.serve(['Aldric']);
  w.logs.length = 0;
  const { statements } = await bnetSignIn(w, BNET.ann);
  const annId = userOf(w, BNET.ann);
  const person = personOf(w, annId, G);
  const aldric = w.one('SELECT * FROM characters WHERE id = ?', CID(2));
  assert.deepEqual([aldric.player_id, aldric.is_main, aldric.name, aldric.name_key, aldric.blizzard_char_id, aldric.blizzard_realm_id, aldric.namespace, aldric.owner_proof, aldric.proof_user_id, aldric.core_rank],
    [person.id, 1, 'Aldric', 'aldric', idOf('Aldric'), 4001, NS, 'bnet', annId, 'raider'], 'the typed character took the key, moved, and is proved');
  assert.deepEqual(charactersOf(w, person.id).map((row) => row.name), ['Aldric']);
  // Alice keeps Brindle (Main) and a placeholder; her history is intact
  assert.equal(w.one('SELECT is_main FROM characters WHERE id = ?', CID(1)).is_main, 1);
  assert.equal(placeholdersOf(w, PID(1)).length, 1);
  assert.deepEqual(await personCounts(w, PID(1)), countsBefore);
  assert.deepEqual(await winnersOf(w, 'Aldric'), [PID(1), PID(1)]);
  assert.equal(w.count('raid_signups', 'character_id = ?', CID(2)), 0, 'its upcoming sign-up is gone');
  // the audit: the key bound (via bnet), the character moved (collision), the person made
  assert.deepEqual(auditOf(w, 'character.rehome').map((row) => [row.after.reason, row.before.personId, row.after.personId]), [['collision', PID(1), person.id]]);
  const matched = auditOf(w, 'character.match_roster');
  assert.equal(matched.length, 1);
  assert.deepEqual([matched[0].entity_id, matched[0].after.via, matched[0].after.blizzardCharId], [CID(2), 'bnet', idOf('Aldric')]);
  assert.equal(auditOf(w, 'person.match_create').length, 1);
  assert.deepEqual(w.logs.filter((line) => /bnet match/.test(line)), [], 'nothing deferred');
  assert(statements <= 45, `${statements} statements`);
  measured.rehomeCollision = statements;
  // the Activity view reads it
  const gm = w.one('SELECT 1 AS x');
  void gm;
});

check('the name collision on an unowned person: the typed character takes the key and its person is LINKED to the account (the unowned-person path of part 2a), nobody moves', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Dunmar', 4]]);
  w.raw.person(PID(1), G, { created: 10 });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { key: false, isMain: 1, proof: 'hand' });
  w.raw.character(CID(2), G, PID(1), 'Dunmar', { key: false, proof: 'officer' });
  w.serve(['Aldric']);
  w.logs.length = 0;
  await bnetSignIn(w, BNET.ann);
  const annId = userOf(w, BNET.ann);
  assert.equal(w.one('SELECT user_id FROM players WHERE id = ?', PID(1)).user_id, annId, 'the person is the account\'s now');
  const aldric = w.one('SELECT * FROM characters WHERE id = ?', CID(1));
  assert.deepEqual([aldric.player_id, aldric.blizzard_char_id, aldric.owner_proof, aldric.proof_user_id], [PID(1), idOf('Aldric'), 'bnet', annId]);
  assert.equal(w.one('SELECT owner_proof FROM characters WHERE id = ?', CID(2)).owner_proof, 'officer', 'the other character keeps the proof it had');
  assert.equal(w.count('characters', "name_key LIKE '~ph:%'"), 0, 'no re-home');
  assert.equal(auditOf(w, 'character.rehome').length, 0);
  assert.equal(auditOf(w, 'person.match_link').length, 1);
  assert.equal(auditOf(w, 'character.match_roster').length, 1);
  assert.deepEqual(w.logs.filter((line) => /bnet match/.test(line)), []);

  // another unowned person with another typed-in name joins in later: the typed Aldric of the account's own person is just stamped
  const w2 = await makeWorld();
  const G2 = w2.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const mine = await makeAccount(w2, BNET.ann);
  w2.raw.person(PID(1), G2, { userId: mine.userId });
  w2.raw.character(CID(1), G2, PID(1), 'Brindle', { isMain: 1, proof: 'officer' });
  w2.raw.character(CID(2), G2, PID(1), 'Aldric', { key: false, proof: 'hand' });
  w2.serve(['Aldric', 'Brindle']);
  await bnetSignIn(w2, BNET.ann, mine.jar);
  assert.deepEqual(w2.rows('SELECT name, blizzard_char_id, owner_proof FROM characters WHERE player_id = ? ORDER BY name', PID(1)),
    [{ name: 'Aldric', blizzard_char_id: idOf('Aldric'), owner_proof: 'bnet' }, { name: 'Brindle', blizzard_char_id: idOf('Brindle'), owner_proof: 'bnet' }], 'on the account\'s own person: bound and stamped');
  assert.equal(w2.count('characters', "name_key LIKE '~ph:%'"), 0);
});

check('the name collision, delete-and-recreate: the roster holds a NEW Aldric and the old character with that name holds a key that left the roster; the old one becomes Former and gives the name up to a dated alias, the new one is created', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const carol = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: carol.userId, created: 10 });
  w.raw.character(CID(1), G, PID(1), 'Brindle', { isMain: 1, proof: 'officer' });
  w.raw.character(CID(2), G, PID(1), 'Aldric', { proof: 'officer', teamId: null });
  w.run('UPDATE characters SET blizzard_char_id = 6001 WHERE id = ?', CID(2)); // the key of the old Aldric: no roster row has it any more
  const raids = seedRaids(w, G);
  seedPersonHistory(w, G, PID(1), 'Aldric', raids, { characterId: CID(2), altId: CID(1) });
  const countsBefore = await personCounts(w, PID(1));
  w.serve(['Aldric']);
  w.logs.length = 0;
  await bnetSignIn(w, BNET.ann);
  const annId = userOf(w, BNET.ann);
  const old = w.one('SELECT * FROM characters WHERE id = ?', CID(2));
  assert.deepEqual([old.player_id, old.name, old.name_key, old.owner_proof, old.blizzard_char_id], [PID(1), 'Aldric', `~was:${CID(2)}`, 'officer', 6001], 'the old Aldric stays where it was, under a reserved key');
  assert(old.left_on, 'and is Former');
  assert.equal(old.left_reason, 'other');
  const created = w.one("SELECT * FROM characters WHERE name_key = 'aldric'");
  assert.deepEqual([created.player_id, created.blizzard_char_id, created.owner_proof, created.proof_user_id], [personOf(w, annId, G).id, idOf('Aldric'), 'bnet', annId], 'the new Aldric is Ann\'s, created from the roster row');
  const alias = w.rows('SELECT * FROM character_name_aliases');
  assert.deepEqual(alias.map((row) => [row.name_key, row.realm_key, row.character_id, row.renamed_at]), [['aldric', 'dreamscythe', CID(2), T0]]);
  assert.deepEqual(await personCounts(w, PID(1)), countsBefore, 'the old Aldric keeps its own evidence');
  // evidence dated before resolves to the old character, after to the new one
  assert.deepEqual(await winnersOf(w, 'Aldric'), [PID(1), PID(1)], 'the loot of the old Aldric');
  const { resolvedNameKeySql } = await load('worker/name-alias.js');
  const resolve = (at) => w.one(`SELECT ${resolvedNameKeySql({ guild: '?1', nameKey: "'aldric'", realmKey: "'dreamscythe'", at: '?2' })} AS k`, G, at).k;
  assert.equal(resolve(T0 - 5000), `~was:${CID(2)}`);
  assert.equal(resolve(T0), `~was:${CID(2)}`, 'on or before the alias date');
  assert.equal(resolve(T0 + 5000), 'aldric', 'after it: whoever carries the name now');
  assert.equal(auditOf(w, 'character.name_retire').length, 1);
  assert.equal(auditOf(w, 'character.rehome').length, 0);
  assert.equal(w.count('characters', "name_key LIKE '~ph:%'"), 0, 'the old character is no placeholder: it is a visible Former character');
  assert.deepEqual(w.logs.filter((line) => /bnet match/.test(line)), []);
  // a Former id-less character with the name behaves the same (it never binds)
  const w2 = await makeWorld();
  const G2 = w2.ingame(1, [['Aldric', 1]]);
  w2.raw.person(PID(1), G2, {});
  w2.raw.character(CID(1), G2, PID(1), 'Aldric', { key: false, isMain: 1, leftOn: '2026-12-01' });
  w2.serve(['Aldric']);
  await bnetSignIn(w2, BNET.ann);
  assert.equal(w2.one('SELECT name_key FROM characters WHERE id = ?', CID(1)).name_key, `~was:${CID(1)}`);
  assert.equal(w2.count('characters', "name_key = 'aldric'"), 1, 'a new Aldric was created');
  assert.equal(w2.one('SELECT user_id FROM players WHERE id = ?', PID(1)).user_id, null, 'and the old person is not linked');
});

check('the name collision, invalid: the roster still holds the key of the character that has the name, so it would hold two with one name and realm: logged as invalid, nothing is written', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  // a second roster row with Aldric's name on another realm slug that normalises to the same realm key (a roster the unique index cannot see through)
  w.run(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
         VALUES (?, ?, 4001, 6001, 'Aldric', 'aldric', 'dreamscythe-x', 'WARRIOR', 70, 3)`, G, NS);
  w.raw.person(PID(1), G, {});
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w.run('UPDATE characters SET blizzard_char_id = 6001 WHERE id = ?', CID(1));
  w.serve(['Aldric', 'Brindle']);
  const before = dumpAll(w);
  w.logs.length = 0;
  const { callback } = await bnetSignIn(w, BNET.ann);
  assert.equal(locationOf(callback), '/#/', 'the sign-in stands');
  assert(w.logs.includes('bnet match invalid: collision'), `logged: ${JSON.stringify(w.logs)}`);
  assert.equal(dumpAll(w), before, 'nothing written in that guild: no person, no Brindle, nothing re-keyed');
  assert.equal(w.count('players', 'user_id IS NOT NULL'), 0);
  // another guild of the same account is not held back
  const G2 = w.ingame(2, [['Brindle', 1]]);
  const jar = {};
  w.logs.length = 0;
  w.advance(1000);
  await bnetSignIn(w, BNET.ann, jar);
  assert(w.logs.includes('bnet match invalid: collision'));
  assert.equal(w.count('characters', 'guild_id = ?', G2), 1, 'the guild that is fine got its character');
  assert.equal(w.count('characters', 'guild_id = ?', G), 1, 'the invalid guild still only has what it had');
});

check('at most one re-home per callback: the best-ranked character moves first, the next sign-in moves the next one, and the deferral is logged', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 2], ['Brindle', 1], ['Cassia', 3]]);
  const bea = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: bea.userId, created: 10 });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w.raw.character(CID(2), G, PID(1), 'Brindle', { proof: 'officer' });
  w.raw.character(CID(3), G, PID(1), 'Cassia', { proof: 'officer' });
  w.serve(['Aldric', 'Brindle', 'Cassia']);
  w.logs.length = 0;
  const first = await bnetSignIn(w, BNET.ann);
  const annId = userOf(w, BNET.ann);
  const mine = () => w.rows('SELECT name FROM characters WHERE player_id = ? ORDER BY name', personOf(w, annId, G).id).map((row) => row.name);
  assert.deepEqual(mine(), ['Brindle'], 'rank 1 first');
  assert(logged(w, 'rehome'), 'the rest is deferred');
  assert(first.statements <= 45, `${first.statements} statements`);
  w.logs.length = 0;
  w.advance(1000);
  const second = await bnetSignIn(w, BNET.ann, first.jar);
  assert.deepEqual(mine(), ['Aldric', 'Brindle']);
  assert(logged(w, 'rehome'));
  w.advance(1000);
  w.logs.length = 0;
  const third = await bnetSignIn(w, BNET.ann, first.jar);
  assert.deepEqual(mine(), ['Aldric', 'Brindle', 'Cassia']);
  assert(!logged(w, 'rehome'), 'nothing left to defer');
  assert.equal(w.count('characters', "name_key LIKE '~ph:%'"), 3, 'three re-homes, three placeholders (a character that was re-homed leaves one each time)');
  assert.equal(auditOf(w, 'character.rehome').length, 3);
  for (const result of [second, third]) assert(result.statements <= 45, `${result.statements} statements`);
  measured.rehomeSecond = second.statements;
});

check('the statement budget: a callback with a re-home, a created person, inserts and a collision bind stays within 45; with no room the re-home waits (`bnet match deferred: budget`) and nothing is half-written', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2], ['Cassia', 3], ['Dunmar', 4], ['Eliora', 5], ['Fenwick', 6]]);
  const bea = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: bea.userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });                // held by another account: re-homed
  w.raw.character(CID(2), G, PID(1), 'Brindle', { key: false, proof: 'hand' });                 // typed in: a collision (the bind would be a second re-home: deferred)
  w.raw.person(PID(2), G, {});
  w.raw.character(CID(3), G, PID(2), 'Cassia', { key: false, isMain: 1, proof: 'hand' });       // typed in on an unowned person: linked
  w.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick']);
  const { statements } = await bnetSignIn(w, BNET.ann);
  assert(statements <= 45, `${statements} statements`);
  measured.rehomeHeavy = statements;
  const annId = userOf(w, BNET.ann);
  const person = personOf(w, annId, G);
  assert.equal(person.id, PID(2), 'the unowned person was linked');
  assert.deepEqual(charactersOf(w, person.id).map((row) => row.name), ['Aldric', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick'], 'with the free characters, the bound one and ONE re-homed');
  assert(logged(w, 'rehome'), 'the second re-home (Brindle, a collision on Bea\'s person) waits');

  // no room for a re-home: the reads and the guild batch run, the re-home is deferred whole
  const w2 = await makeWorld();
  const G2 = w2.ingame(1, [['Aldric', 1]]);
  const bea2 = await makeAccount(w2, BNET.bea);
  w2.raw.person(PID(1), G2, { userId: bea2.userId });
  w2.raw.character(CID(1), G2, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w2.serve(['Aldric']);
  const { runBnetMatch, CALLBACK_STATEMENT_BUDGET } = await load('worker/bnet-match.js');
  const ann = await makeAccount(w2, BNET.ann);
  w2.serve(['Aldric']);
  w2.logs.length = 0;
  const before = dumpAll(w2);
  const spent = CALLBACK_STATEMENT_BUDGET - 12; // the reads (2) + the person's create batch (about 4) fit, the re-home (up to 16) does not
  const result = await runBnetMatch({ ...w2.ctx(), env: w2.env }, { userId: ann.userId, bnetAccountId: BNET.ann.id, snapshot: snapshotFor(['Aldric']), now: T0, spent });
  assert(result.deferred.includes('budget') && result.deferred.includes('rehome'), JSON.stringify(result));
  assert(result.statements <= CALLBACK_STATEMENT_BUDGET);
  assert.equal(w2.count('characters', "name_key LIKE '~ph:%'"), 0, 'no placeholder: nothing of the re-home ran');
  assert.equal(w2.one('SELECT player_id FROM characters WHERE id = ?', CID(1)).player_id, PID(1));
  assert.notEqual(dumpAll(w2), before, 'only the account\'s own person was made');
});

check('two concurrent sign-ins: the second re-home of the same character is a no-op (its guard fails), one placeholder, one audit row, no 500', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const bea = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: bea.userId });
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w.raw.character(CID(2), G, PID(1), 'Brindle', { proof: 'officer' });
  w.serve(['Aldric']);
  const first = await bnetSignIn(w, BNET.ann);
  void first;
  // the same account signs in twice at once: the nested sign-in runs the whole match before the outer one's re-home batch
  const w2 = await makeWorld();
  const G2 = w2.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const bea2 = await makeAccount(w2, BNET.bea);
  w2.raw.person(PID(1), G2, { userId: bea2.userId });
  w2.raw.character(CID(1), G2, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w2.raw.character(CID(2), G2, PID(1), 'Brindle', { proof: 'officer' });
  const ann = await makeAccount(w2, BNET.ann);
  w2.serve(['Aldric']);
  let armed = true;
  const batch = w2.db.batch.bind(w2.db);
  w2.db.batch = async (statements) => {
    if (armed && statements.some((statement) => /INSERT INTO characters[\s\S]*'social', \?, 'other'/.test(statement.sql))) {
      armed = false;
      await bnetSignIn(w2, BNET.ann, {});
    }
    return batch(statements);
  };
  w2.logs.length = 0;
  const outer = await bnetSignIn(w2, BNET.ann, ann.jar);
  w2.db.batch = batch;
  assert.equal(locationOf(outer.callback), '/#/', 'no 500');
  assert.equal(w2.count('characters', "name_key LIKE '~ph:%'"), 1, 'one placeholder');
  assert.equal(w2.count('audit_log', "action = 'character.rehome'"), 1, 'one audit row: only the re-home that happened');
  assert.equal(w2.count('character_name_aliases'), 1);
  assert.equal(w2.count('players', 'user_id = ?', ann.userId), 1);
  assert.deepEqual(w2.logs.filter((line) => /failed/.test(line)), []);
  assert.equal(w2.one('SELECT player_id FROM characters WHERE id = ?', CID(1)).player_id, personOf(w2, ann.userId, G2).id);
  void G;
});

check('query plans on a 1,200-member roster: a re-home callback, a collision bind with its re-home and a name given up never scan characters, guild_roster or players', async () => {
  const w = await makeWorld();
  const G = w.ingame(1, []);
  w.sqlite.exec('BEGIN');
  const insertRoster = w.sqlite.prepare("INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES (?, ?, 4001, ?, ?, ?, 'dreamscythe', 'MAGE', 70, ?)");
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
  for (const [name, rank] of [['Aldric', 0], ['Brindle', 1], ['Cassia', 2], ['Dunmar', 3]]) w.raw.roster(G, name, rank);
  const bea = await makeAccount(w, BNET.bea);
  w.raw.person(PID(1), G, { userId: bea.userId });                                               // an officer-linked person: Aldric (Main), Eliora (alt), a typed-in Brindle
  w.raw.character(CID(1), G, PID(1), 'Aldric', { isMain: 1, proof: 'officer' });
  w.raw.character(CID(2), G, PID(1), 'Eliora', { proof: 'officer' });
  w.raw.character(CID(3), G, PID(1), 'Brindle', { key: false, proof: 'hand' });
  w.raw.person(PID(2), G, { created: 5 });
  w.raw.character(CID(4), G, PID(2), 'Cassia', { proof: 'officer', isMain: 1 });                // keyed, and gone from the roster after the next line
  w.run('UPDATE characters SET blizzard_char_id = 6001 WHERE id = ?', CID(4));
  w.raw.person(PID(3), G, { created: 6 });
  w.raw.character(CID(5), G, PID(3), 'Dunmar', { key: false, proof: 'hand', isMain: 1, leftOn: '2026-12-01' });
  const raids = seedRaids(w, G);
  seedPersonHistory(w, G, PID(1), 'Aldric', raids, { characterId: CID(1), altId: CID(2) });
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
        if (/^\s*DELETE FROM players\b/i.test(sql)) continue;
        found.push(`${[...tables][0]}: ${row.detail} in ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
    return found;
  };
  const probe = w.mark();
  await w.db.prepare("SELECT 1 FROM characters WHERE name LIKE '%x%'").bind().all();
  assert.equal(scans(probe).length, 1, 'a seeded scan is reported');

  // 1. Battle.net beats a link (Aldric) and the typed-in Brindle on the same person: Aldric moves first, with the person made
  w.serve(['Aldric', 'Brindle']);
  const first = await bnetSignIn(w, BNET.ann);
  assert.equal(w.count('characters', "name_key LIKE '~ph:%'"), 1, 'one re-home');
  assert.deepEqual(scans(first.mark), [], 're-home callback');
  // 2. the next sign-in: the collision bind with its re-home (Brindle)
  w.advance(1000);
  const second = await bnetSignIn(w, BNET.ann, first.jar);
  assert.equal(w.one('SELECT owner_proof FROM characters WHERE id = ?', CID(3)).owner_proof, 'bnet', 'Brindle was bound and moved');
  assert.deepEqual(scans(second.mark), [], 'collision bind + re-home callback');
  // 3. a name given up (Cassia's old key 6001 is on no roster row; the roster holds the Cassia of the snapshot) and a Former typed-in Dunmar
  w.run("UPDATE characters SET realm = 'Nightslayer', realm_key = 'nightslayer' WHERE id = ?", CID(4));
  w.run("UPDATE characters SET realm = 'Dreamscythe' WHERE id = ?", CID(5));
  w.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar']);
  w.advance(1000);
  const third = await bnetSignIn(w, BNET.ann, first.jar);
  assert.equal(w.one('SELECT name_key FROM characters WHERE id = ?', CID(4)).name_key, `~was:${CID(4)}`, 'Cassia\'s name was given up');
  assert.equal(w.one('SELECT name_key FROM characters WHERE id = ?', CID(5)).name_key, `~was:${CID(5)}`, 'and the Former Dunmar\'s');
  assert.deepEqual(scans(third.mark), [], 'two names given up, two characters created');
  measured.explainRehome = [first.statements, second.statements, third.statements];
  for (const result of [first, second, third]) assert(result.statements <= 45, `${result.statements} statements`);
});

check('the sign-in match and the cap (migration 0036): the retired placeholders use up none of the 20 - the match fills the person up to 20 VISIBLE characters (deferred `cap` for the rest, no batch fails on the trigger), and the cap of a re-home counts visible characters only', async () => {
  // 17 visible characters and 3 placeholders: three roster characters fit although the person has 20 rows.
  const fixture = async (w, roster) => {
    const G = w.ingame(1, roster);
    const account = await makeAccount(w, BNET.ann);
    w.raw.person(PID(1), G, { userId: account.userId });
    for (let i = 0; i < 17; i++) w.raw.character(CID(10 + i), G, PID(1), `Filler${String(i).padStart(2, '0')}`, { key: false, isMain: i === 0 ? 1 : 0 });
    for (let i = 0; i < 3; i++) {
      w.raw.character(CID(50 + i), G, PID(1), `Retired${i}`, { key: false, leftOn: '2026-12-01' });
      w.run('UPDATE characters SET name_key = ? WHERE id = ?', `~ph:c_hold${i}`, CID(50 + i));
    }
    assert.equal(w.count('characters', 'player_id = ?', PID(1)), 20, '17 visible characters and 3 placeholders: 20 rows');
    return { G, ...account };
  };
  const first = await makeWorld();
  const { userId, jar } = await fixture(first, [['Aldric', 1], ['Brindle', 2], ['Cassia', 3], ['Dunmar', 4]]);
  first.serve(['Aldric', 'Brindle', 'Cassia', 'Dunmar']);
  first.logs.length = 0;
  const result = await bnetSignIn(first, BNET.ann, jar);
  assert.equal(locationOf(result.callback), '/#/');
  assert.equal(first.count('characters', "player_id = ? AND name_key NOT LIKE '~ph:%'", PID(1)), 20, 'filled up to 20 visible characters');
  assert.equal(first.count('characters', 'player_id = ?', PID(1)), 23, 'on top of the 20 rows it had');
  assert.deepEqual(first.rows("SELECT name FROM characters WHERE player_id = ? AND name IN ('Aldric', 'Brindle', 'Cassia', 'Dunmar') ORDER BY name", PID(1)).map((row) => row.name), ['Aldric', 'Brindle', 'Cassia'], 'the best-ranked roster characters');
  assert(logged(first, 'cap'), 'deferred: cap');
  assert.deepEqual(first.logs.filter((line) => /failed/.test(line)), [], 'and no batch failed on the trigger');
  void userId;

  const w = await makeWorld();
  const G = w.ingame(1, [['Aldric', 1], ['Brindle', 2]]);
  const account = await makeAccount(w, BNET.ann);
  const userIdB = account.userId;
  w.raw.person(PID(1), G, { userId: userIdB });
  for (let i = 0; i < 17; i++) w.raw.character(CID(10 + i), G, PID(1), `Filler${String(i).padStart(2, '0')}`, { key: false, isMain: i === 0 ? 1 : 0 });
  for (let i = 0; i < 3; i++) {
    w.raw.character(CID(50 + i), G, PID(1), `Retired${i}`, { key: false, leftOn: '2026-12-01' });
    w.run('UPDATE characters SET name_key = ? WHERE id = ?', `~ph:c_hold${i}`, CID(50 + i));
  }

  // a re-home into that person is refused only by the VISIBLE count: 17 visible + 3 placeholders takes three more
  const bea = await makeAccount(w, BNET.bea);
  for (const [n, name] of [[1, 'Cassia'], [2, 'Dunmar'], [3, 'Eliora'], [4, 'Fenwick']]) {
    w.raw.roster(G, name, 5);
    w.raw.person(PID(100 + n), G, { userId: n === 1 ? bea.userId : null });
    w.raw.character(CID(100 + n), G, PID(100 + n), name, { isMain: 1, proof: 'officer' });
  }
  const { rehomeStatements } = await load('worker/rehome.js');
  const move = async (characterId) => {
    const plan = await rehomeStatements(w.db, { guildId: G, characterId, toPersonId: PID(1), actorUserId: userIdB, now: w.clock.now, reason: 'gm_claim', randomBytes: w.randomBytes });
    const results = await w.db.batch(plan.statements);
    return results[plan.appliedIndex].meta.changes === 1;
  };
  for (const n of [1, 2, 3]) assert.equal(await move(CID(100 + n)), true, `character ${n} fits: ${17 + n} visible`);
  assert.equal(w.count('characters', "player_id = ? AND name_key NOT LIKE '~ph:%'", PID(1)), 20);
  await assert.rejects(() => move(CID(104)), (error) => error.code === 'rehome_too_many_characters', 'the 21st visible character is refused');
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
