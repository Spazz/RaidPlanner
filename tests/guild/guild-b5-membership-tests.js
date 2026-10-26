/**
 * Raidsmith guild tracker - lane B5 of the user-hierarchy build: guild membership per rank source (worker/membership.js), "my guilds", and the flip dry run
 * (worker/flip-preview.js, worker/routes/flip.js)
 * Run: node tests/guild/guild-b5-membership-tests.js
 *
 *   rank_source NULL (legacy)   NOT blocked AND (in the guild's Discord server OR linked by players.user_id)          unchanged
 *   rank_source 'manual'        NOT blocked AND linked by players.user_id                                             (today's rule minus Discord)
 *   rank_source 'ingame'        NOT blocked AND (the Owner OR linked to a person with a character on the in-game roster that is not Former)
 * Checked here:
 *   - the pure forms (reachesOf / membershipOf) and the SQL fragments agree on every combination of source and facts, and "my guilds" (candidate driven) equals a pass over every guild;
 *   - the rule per source through the real routes: loadGuildContext (403 not_member, its message per source), GET /auth/me, loadMemberGuilds; a sync that makes a person all-Former
 *     removes the guild at once; stored roles grant nothing while membership fails; a Social character on the roster keeps membership; the Owner exemption; blocked wins;
 *   - EXPLAIN QUERY PLAN: "my guilds" never scans the guilds table on a 2,000-guild database;
 *   - the flip dry run (POST /flip/dry-run): Owner only, rate limited, 409 once in-game, lists who loses and gains access and the Discord-owned persons it would link, its token
 *     is a 'flip:' token that no rank-map call accepts (and the other way round);
 *   - a CI grep: no worker file outside membership.js reads user_servers or players.user_id for a membership decision (an allowlist, one reason per entry).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { NAMESPACE, REALM_ID, seatOnRoster } = require('../guild-seat');
const { flip, makeProven } = require('../guild-ingame');

const ROOT = path.join(__dirname, '..', '..');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const SOURCES = [null, 'manual', 'ingame', 'someday'];
const sourceLabel = (source) => (source === null ? 'legacy (NULL)' : source);

// ---------------------------------------------------------------------------
// Raw fixtures: guilds, accounts, people and roster rows written straight into the D1 stand-in.

function rawDb(db) {
  const run = (sql, ...values) => db.sqlite.prepare(sql).run(...values);
  const raw = {
    run,
    guild(id, { source = null, owner = null } = {}) {
      run(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source, owner_user_id)
           VALUES (?, ?, 'Nightslayer', 'realm', 'US', ?, 'America/New_York', 'tbc', 1, ?, ?)`, id, `Guild ${id}`, `7${id.replace(/\D/g, '').padStart(17, '0')}`, source, owner);
      return { id, server: `7${id.replace(/\D/g, '').padStart(17, '0')}` };
    },
    user(id, discordId = null) {
      run('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)', id, id, discordId, id);
    },
    inServer(userId, serverId) { run('INSERT OR REPLACE INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, 1)', userId, serverId); },
    block(guildId, userId) { run('INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES (?, ?, 1)', guildId, userId); },
    gm(guildId, userId) {
      run("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_at) VALUES (?, ?, ?, 'guild_master', NULL, 1)", `ra_${guildId}_${userId}`, guildId, userId);
    },
    // A person; userId links the account (players.user_id), discordUserId carries a Discord ID.
    person(id, guildId, { userId = null, discordUserId = null } = {}) {
      run("INSERT INTO players (id, guild_id, status, user_id, discord_user_id, created_at, updated_at) VALUES (?, ?, 'raider', ?, ?, 1, 1)", id, guildId, userId, discordUserId);
    },
    // Proves a character by Battle.net for the account (worker/owner.js: a VALID proof keeps an in-game Owner live): the Battle.net link and the proof columns.
    prove(characterId, userId, bnetId) {
      run("INSERT OR REPLACE INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)", userId, String(bnetId), `Tag${bnetId}#1`);
      run("UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = ?, proof_at = 1 WHERE id = ?", userId, String(bnetId), characterId);
    },
    // A character of the person. key = the blizzard_char_id it carries (null = unkeyed); leftOn = a date for a Former one.
    character(id, guildId, personId, { key = null, leftOn = null, coreRank = 'raider', isMain = 1 } = {}) {
      run(`INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on, namespace, blizzard_realm_id, blizzard_char_id)
           VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', ?, 1, 1, ?, ?, ?, ?, ?)`,
      id, guildId, personId, id, id.toLowerCase(), isMain, coreRank, leftOn, key === null ? null : NAMESPACE, key === null ? null : REALM_ID, key);
    },
    rosterRow(guildId, key, rank = 4) {
      run(`INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
           VALUES (?, ?, ?, ?, ?, ?, 'nightslayer', 'MAGE', 70, ?)`, guildId, NAMESPACE, REALM_ID, key, `Row${key}`, `row${key}`, rank);
    },
  };
  return raw;
}

const one = async (db, sql, ...values) => db.prepare(sql).bind(...values).first();

// ---------------------------------------------------------------------------
// 1. The pure forms and the SQL agree

const CHAR_STATES = ['none', 'unkeyed', 'offRoster', 'onRoster', 'formerOnRoster', 'provenOnRoster'];

check('reachesOf / membershipOf mirror memberSql / reachesGuildSql on every source and every combination of facts (an unknown source reads as legacy)', async () => {
  const m = await load('worker/membership.js');
  const { ownerOf } = await load('worker/owner.js');
  const s = await scenario();
  const raw = rawDb(s.w.db);
  const cases = [];
  let n = 0;
  for (const source of SOURCES) {
    for (const ownerMode of ['none', 'seat', 'gmrow']) {
      for (const inServer of [false, true]) {
        for (const linked of [false, true]) {
          for (const state of linked ? CHAR_STATES : ['none']) {
            for (const blocked of [false, true]) {
              n++;
              const gid = `g_m${n}`;
              const uid = `u_m${n}`;
              raw.user(uid, `5${String(n).padStart(17, '0')}`);
              const guild = raw.guild(gid, { source, owner: ownerMode === 'seat' ? uid : null });
              if (ownerMode === 'gmrow') raw.gm(gid, uid);
              if (inServer) raw.inServer(uid, guild.server);
              if (linked) {
                raw.person(`p_m${n}`, gid, { userId: uid });
                if (state !== 'none') {
                  raw.character(`c_m${n}`, gid, `p_m${n}`, { key: state === 'unkeyed' ? null : 1000 + n, leftOn: state === 'formerOnRoster' ? '2026-10-01' : null });
                  if (state === 'onRoster' || state === 'formerOnRoster' || state === 'provenOnRoster') raw.rosterRow(gid, 1000 + n);
                  if (state === 'provenOnRoster') raw.prove(`c_m${n}`, uid, 800000 + n);
                  if (state === 'offRoster') raw.rosterRow(gid, 500000 + n);
                }
              }
              if (blocked) raw.block(gid, uid);
              // The Owner of the in-game rule is the UNSUSPENDED one (worker/owner.js): the seat holder with a valid proven character on the roster; a stored Guild Master row is
              // the Owner only while the guild has neither a seat nor a rank source.
              const owner = ownerOf({ userId: uid, ownerUserId: ownerMode === 'seat' ? uid : null, rankSource: source, storedMasterUserId: ownerMode === 'gmrow' ? uid : null,
                hasValidProvenCharacter: linked && state === 'provenOnRoster' });
              cases.push({ gid, uid, source, owner, inServer, linked, state, blocked });
            }
          }
        }
      }
    }
  }
  assert(cases.length > 250, `the matrix has ${cases.length} cases`);
  for (const c of cases) {
    const row = await one(s.w.db,
      `SELECT ${m.memberSql('u.id', 'g.id', 'g.discord_server_id')} AS member, ${m.reachesGuildSql('u.id', 'g.id', 'g.discord_server_id')} AS reaches, ${m.blockedSql('u.id', 'g.id')} AS blocked
         FROM users u, guilds g WHERE u.id = ? AND g.id = ?`, c.uid, c.gid);
    const facts = { source: c.source, inServer: c.inServer, linked: c.linked, owner: c.owner, rosterCharacter: c.linked && (c.state === 'onRoster' || c.state === 'provenOnRoster') };
    const where = JSON.stringify(c);
    // A block row on the unsuspended Owner is ignored (lane B6b part 2a: an Owner who is not suspended cannot be blocked).
    const effectivelyBlocked = c.blocked && !c.owner;
    assert.equal(row.blocked === 1, effectivelyBlocked, where);
    assert.equal(row.reaches === 1, m.reachesOf(facts), `reaches: ${where}`);
    assert.equal(m.membershipOf({ blocked: c.blocked, ...facts }), effectivelyBlocked ? 'blocked' : (m.reachesOf(facts) ? 'member' : 'none'));
    assert.equal(row.member === 1, m.membershipOf({ blocked: c.blocked, ...facts }) === 'member', `member: ${where}`);
    // The bound forms carry their own values and say the same.
    const guard = m.boundMember(c.uid, c.gid, (await one(s.w.db, 'SELECT discord_server_id AS sid FROM guilds WHERE id = ?', c.gid)).sid);
    assert.equal((await s.w.db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first()).ok === 1, row.member === 1, `boundMember: ${where}`);
  }
  // A few anchors, spelled out.
  assert.equal(m.reachesOf({ source: null, inServer: true }), true);
  assert.equal(m.reachesOf({ source: 'manual', inServer: true }), false);
  assert.equal(m.reachesOf({ source: 'ingame', inServer: true, linked: true }), false, 'linked with no roster character');
  assert.equal(m.reachesOf({ source: 'ingame', owner: true }), true);
  assert.equal(m.membershipOf({ blocked: true, source: 'ingame', owner: true }), 'member', 'a block row on the unsuspended Owner is ignored');
  assert.equal(m.membershipOf({ blocked: true, source: 'ingame', owner: false, linked: true, rosterCharacter: true }), 'blocked', 'and blocks everyone else');
});

check('"my guilds" driven from the account\'s candidates equals a pass over every guild with memberSql, for every account of the matrix; memberCandidatesSql covers every member', async () => {
  const m = await load('worker/membership.js');
  const s = await scenario();
  const raw = rawDb(s.w.db);
  // Three accounts, a dozen guilds of every source, each reachable in several ways at once.
  const users = ['u_a', 'u_b', 'u_c'];
  users.forEach((id, i) => raw.user(id, `61${i}`));
  let n = 0;
  for (const source of SOURCES) {
    for (const how of ['server', 'link', 'linkRoster', 'seat', 'gmrow', 'none', 'blockedServer']) {
      for (const uid of users) {
        n++;
        const gid = `g_h${n}`;
        const guild = raw.guild(gid, { source, owner: how === 'seat' ? uid : null });
        if (how === 'server' || how === 'blockedServer') raw.inServer(uid, guild.server);
        if (how === 'link' || how === 'linkRoster') {
          raw.person(`p_h${n}`, gid, { userId: uid });
          raw.character(`c_h${n}`, gid, `p_h${n}`, { key: 2000 + n });
          if (how === 'linkRoster') raw.rosterRow(gid, 2000 + n);
        }
        if (how === 'gmrow') raw.gm(gid, uid);
        if (how === 'blockedServer') raw.block(gid, uid);
        // Another account sits in this guild's server too: it must not leak into this account's list.
        raw.inServer(users[(users.indexOf(uid) + 1) % users.length], guild.server);
      }
    }
  }
  for (const uid of users) {
    const scan = (await s.w.db.prepare(`SELECT g.id FROM guilds g WHERE ${m.memberSql('?1', 'g.id', 'g.discord_server_id')} ORDER BY g.name, g.id`).bind(uid).all()).results.map((r) => r.id);
    const driven = (await m.memberGuildsStatement(s.w.db, uid).all()).results.map((r) => r.id);
    assert(scan.length > 10, `${uid} is a member of ${scan.length} guilds`);
    assert.deepEqual(driven, scan, uid);
    // Every member of every guild is among that guild's candidates.
    const candidateRows = (await s.w.db.prepare(
      `SELECT g.id AS gid FROM guilds g WHERE ${m.memberSql('?1', 'g.id', 'g.discord_server_id')}
         AND NOT EXISTS (SELECT 1 FROM (${m.memberCandidatesSql('g.id', 'g.discord_server_id')}) c WHERE c.user_id = ?1)`).bind(uid).all()).results;
    assert.deepEqual(candidateRows, [], `${uid}: a member that memberCandidatesSql misses`);
  }
});

// ---------------------------------------------------------------------------
// 2. The rule through the real routes

const guildGet = (s, who) => s.call(who, 'GET', '');
const memberGuildIds = async (s, who) => (await s.ok(who, 'GET', '/auth/me')).guilds.map((guild) => guild.id);
const setSource = (s, source) => s.exec(`UPDATE guilds SET rank_source = ${source ? `'${source}'` : 'NULL'} WHERE id = '${s.gid}'`);
const mention = (text) => /discord/i.test(text);
const block = (s, key) => s.exec(`INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES ('${s.gid}', '${s.uids[key]}', 1)`);
const keyCharacter = (s, characterId, key) => s.exec(`UPDATE characters SET namespace = '${NAMESPACE}', blizzard_realm_id = ${REALM_ID}, blizzard_char_id = ${key} WHERE id = '${characterId}'`);

// A legacy guild whose Guild Master is the Owner (the stored row, no seat yet) and whose accounts are all in its Discord server.
async function world() {
  const s = await scenario();
  for (const [key, name] of [['seated', 'Seated'], ['social', 'Socialrank'], ['offroster', 'Offroster'], ['discordonly', 'Discordonly'], ['officer', 'Officerlinked']]) await s.member(key, name);
  return s;
}
// The in-game switch for a test that goes on acting as the Guild Master afterwards: the Owner seat on 'gm', LIVE (a person linked to the account whose character is proven by
// Battle.net and on the roster), the stored Guild Master row gone - what the flip leaves behind. Do it BEFORE the switch (the routes need the stored Guild Master).
async function goIngame(s, id = 69000) {
  const owned = await s.person({ name: 'Gmownerx' });
  await s.link(owned.pid, 'gm');
  makeProven(s, 'gm', owned, { rank: 4, id });
  flip(s, { owner: 'gm' });
}
const seat = (s, key, name, id, extra = {}) => seatOnRoster({ call: s.call, sqlite: s.w.db.sqlite, guildId: s.gid, teamId: s.tids[0], userId: s.uids[key] }, { name, id, ...extra });

check('legacy guilds are unchanged: the Discord server alone lets an account in, a link alone does too, the message still names the Discord server; a block wins', async () => {
  const s = await world();
  await s.outsider('outsider', 'Outsider');
  assert.equal((await guildGet(s, 'discordonly')).status, 200, 'in the server: a member');
  const linked = await s.person({ name: 'Linkedone' });
  await s.link(linked.pid, 'outsider');
  assert.equal((await guildGet(s, 'outsider')).status, 200, 'linked, not in the server: a member');
  await s.outsider('stranger', 'Stranger');
  const refused = await guildGet(s, 'stranger');
  assert.deepEqual([refused.status, refused.json.error], [403, 'not_member']);
  assert(/Discord server/.test(refused.json.message), 'the legacy message keeps naming the server');
  assert.deepEqual(await memberGuildIds(s, 'outsider'), [s.gid]);
  block(s, 'discordonly');
  const gone = await guildGet(s, 'discordonly');
  assert.deepEqual([gone.status, gone.json.error], [403, 'access_removed']);
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), [], 'a blocked account has no guild');
});

check("'manual': the Discord server grants nothing, a link to a person does; the message does not name the Discord server; the Guild Master needs a link too (U R3-Q7)", async () => {
  const s = await world();
  const linked = await s.person({ name: 'Manuallinked' });
  await s.link(linked.pid, 'seated');
  const gmPerson = await s.person({ name: 'Gmperson' });
  await s.link(gmPerson.pid, 'gm');
  setSource(s, 'manual');
  assert.equal((await guildGet(s, 'seated')).status, 200, 'linked: a member');
  assert.equal((await guildGet(s, 'gm')).status, 200, 'the Guild Master is linked');
  const refused = await guildGet(s, 'discordonly');
  assert.deepEqual([refused.status, refused.json.error], [403, 'not_member']);
  assert(!mention(refused.json.message), refused.json.message);
  assert(/linked to your account|link your account/i.test(refused.json.message), refused.json.message);
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), []);
  assert.deepEqual(await memberGuildIds(s, 'seated'), [s.gid]);
  const { loadMemberGuilds } = await load('worker/bnet-store.js');
  assert.deepEqual((await loadMemberGuilds(s.w.db, s.uids.discordonly)).map((g) => g.id), []);
  assert.deepEqual((await loadMemberGuilds(s.w.db, s.uids.seated)).map((g) => g.id), [s.gid]);
  // No link, no entry: the rule is "linked", the same for everyone (there is no Owner exemption in a manual guild).
  s.exec(`UPDATE players SET user_id = NULL WHERE id = '${gmPerson.pid}'`);
  assert.equal((await guildGet(s, 'gm')).status, 403);
});

check("'ingame': a Discord-server-only account is not a member (the message names the roster, not the Discord server); a Discord ID on a person does not link anyone", async () => {
  const s = await world();
  await seat(s, 'seated', 'Seatedmain', 61001);
  await goIngame(s);
  assert.equal((await guildGet(s, 'seated')).status, 200);
  const refused = await guildGet(s, 'discordonly');
  assert.deepEqual([refused.status, refused.json.error], [403, 'not_member']);
  assert(!mention(refused.json.message), refused.json.message);
  assert(/in-game roster/.test(refused.json.message), refused.json.message);
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), []);
  assert.deepEqual(await memberGuildIds(s, 'seated'), [s.gid]);
  // A person that carries the account's Discord ID and sits on the roster is still not the account's: only players.user_id counts.
  const owned = await s.person({ name: 'Discordowned' });
  keyCharacter(s, owned.cid, 61002);
  rawDb(s.w.db).rosterRow(s.gid, 61002);
  s.exec(`UPDATE players SET discord_user_id = (SELECT discord_id FROM users WHERE id = '${s.uids.discordonly}') WHERE id = '${owned.pid}'`);
  assert.equal((await guildGet(s, 'discordonly')).status, 403, 'a Discord ID match is not a link');
  s.exec(`UPDATE players SET user_id = '${s.uids.discordonly}' WHERE id = '${owned.pid}'`);
  assert.equal((await guildGet(s, 'discordonly')).status, 200, 'linked by players.user_id: a member');
});

check("'ingame': an off-roster officer-linked person is not a member; a Social-ranked character on the roster keeps membership; a Former or unkeyed one does not", async () => {
  const s = await world();
  const off = await s.person({ name: 'Offmain' });
  keyCharacter(s, off.cid, 62001);
  await s.link(off.pid, 'offroster');
  await seat(s, 'social', 'Socialmain', 62002);
  s.exec("UPDATE characters SET core_rank = 'social' WHERE name = 'Socialmain'");
  await goIngame(s);
  const offRoster = await guildGet(s, 'offroster');
  assert.deepEqual([offRoster.status, offRoster.json.error], [403, 'not_member'], 'linked by an officer, character not on the roster');
  assert.equal((await guildGet(s, 'social')).status, 200, 'Social on the roster: a member');
  // The character comes onto the roster: the same account is let in; it goes Former: out again.
  rawDb(s.w.db).rosterRow(s.gid, 62001);
  assert.equal((await guildGet(s, 'offroster')).status, 200);
  s.exec(`UPDATE characters SET left_on = '2026-10-20' WHERE id = '${off.cid}'`);
  assert.equal((await guildGet(s, 'offroster')).status, 403);
  // An unkeyed character (a hand-added one, no identity key) is on no roster.
  s.exec(`UPDATE characters SET left_on = NULL, namespace = NULL, blizzard_realm_id = NULL, blizzard_char_id = NULL WHERE id = '${off.cid}'`);
  assert.equal((await guildGet(s, 'offroster')).status, 403);
  // One character on the roster is enough, whatever the Main is.
  const alt = await s.alt(off.pid, 'Offalt');
  keyCharacter(s, alt, 62001);
  assert.equal((await guildGet(s, 'offroster')).status, 200, 'any one character');
});

check("'ingame': roles stored for a person grant nothing while membership fails, and are back the moment it returns", async () => {
  const s = await world();
  const off = await s.person({ name: 'Officermain' });
  keyCharacter(s, off.cid, 63001);
  await s.link(off.pid, 'officer');
  await s.ok('gm', 'PUT', `/people/${s.uids.officer}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  assert.equal((await s.ok('officer', 'GET', '')).me.roles.some((r) => r.role === 'officer'), true);
  setSource(s, 'ingame');
  assert.equal((await s.rows("SELECT id FROM role_assignments WHERE user_id = ? AND role_id = 'officer'", s.uids.officer)).length, 1, 'the row is stored');
  for (const [method, tail] of [['GET', ''], ['GET', '/people'], ['GET', `/roster?team=${s.tids[0]}`], ['PUT', `/people/${s.uids.discordonly}/roles`]]) {
    const refused = await s.call('officer', method, tail, method === 'PUT' ? { officer: true, teamLeadTeamIds: [] } : undefined);
    assert.deepEqual([refused.status, refused.json.error], [403, 'not_member'], `${method} ${tail}`);
  }
  assert.deepEqual(await memberGuildIds(s, 'officer'), [], 'not in My guilds');
  rawDb(s.w.db).rosterRow(s.gid, 63001);
  assert.equal((await s.ok('officer', 'GET', '')).me.roles.some((r) => r.role === 'officer'), true, 'the stored Officer role works again');
  assert.deepEqual(await memberGuildIds(s, 'officer'), [s.gid]);
});

check("'ingame': the Owner passes while LIVE (a valid Battle.net-proven character on the stored roster) even without a usable roster character, and not while suspended; a stored Guild Master row counts for nothing; a block row on the live Owner is ignored, and counts once the Owner is suspended", async () => {
  const s = await world();
  setSource(s, 'ingame');
  const stored = await guildGet(s, 'gm');
  assert.deepEqual([stored.status, stored.json.error], [403, 'not_member'], 'the stored Guild Master row stops counting once the guild has a rank source (finding B4b/B5 F1)');
  // The seat on an account with no person: SUSPENDED (nothing proves a character on the roster), so it keeps the seat and no exemption.
  await s.setOwner('discordonly');
  const suspended = await guildGet(s, 'discordonly');
  assert.deepEqual([suspended.status, suspended.json.error], [403, 'not_member'], 'a suspended Owner is not let in by the seat');
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), [], 'and the guild is not in their list');
  // Back on the roster: a person linked to the account whose character is on the roster and proven by Battle.net, but marked Former (left_on), so the roster rule alone would
  // not let it in - the Owner exemption does, because the proof (a, b, d) still holds.
  const raw = rawDb(s.w.db);
  raw.person('p_seatowner', s.gid, { userId: s.uids.discordonly });
  raw.character('c_seatowner', s.gid, 'p_seatowner', { key: 64100, leftOn: '2026-10-01' });
  raw.rosterRow(s.gid, 64100);
  assert.equal((await guildGet(s, 'discordonly')).status, 403, 'on the roster but not proven: neither the roster rule (Former) nor the exemption (suspended)');
  raw.prove('c_seatowner', s.uids.discordonly, 640001);
  assert.equal((await guildGet(s, 'discordonly')).status, 200, 'proven: the Owner is live, the seat is a member');
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), [s.gid], 'and the guild is in their list (the owner candidate set)');
  const derived = await guildGet(s, 'gm');
  assert.deepEqual([derived.status, derived.json.error], [403, 'not_member'], 'the former Guild Master has no roster character');
  // A block row on the LIVE Owner is ignored (lane B6b part 2a): an Owner who is not suspended cannot be blocked.
  block(s, 'discordonly');
  assert.equal((await guildGet(s, 'discordonly')).status, 200, 'a block row on the unsuspended Owner changes nothing');
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), [s.gid]);
  // Suspended again (the proof is gone), the same row blocks: a suspended Owner is blockable (U R4-Q3).
  s.w.db.sqlite.prepare("UPDATE characters SET owner_proof = 'officer' WHERE id = 'c_seatowner'").run();
  const blocked = await guildGet(s, 'discordonly');
  assert.deepEqual([blocked.status, blocked.json.error], [403, 'access_removed']);
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), []);
});

check('blocked wins in every source: a block removes a member of a legacy, a manual and an in-game guild, and the guild leaves My guilds', async () => {
  for (const source of [null, 'manual', 'ingame']) {
    const s = await world();
    await seat(s, 'seated', 'Blockedmain', 64001);
    setSource(s, source);
    assert.equal((await guildGet(s, 'seated')).status, 200, sourceLabel(source));
    block(s, 'seated');
    const refused = await guildGet(s, 'seated');
    assert.deepEqual([refused.status, refused.json.error], [403, 'access_removed'], sourceLabel(source));
    assert.deepEqual(await memberGuildIds(s, 'seated'), [], sourceLabel(source));
  }
});

// A real sync over a faked Blizzard: the roster of the pinned guild comes from net.roster.
const CLASS_IDS = [1, 2, 3, 4, 5, 7, 8, 9, 11];
const rosterName = (i) => `R${String.fromCharCode(97 + (Math.floor(i / 676) % 26), 97 + (Math.floor(i / 26) % 26), 97 + (i % 26))}`;
const rosterKey = (i) => 9000 + i;
function blizzardRoster(indexes) {
  return {
    guild: { name: 'Ember', id: 3000, realm: { id: REALM_ID, slug: 'dreamscythe' }, faction: { type: 'HORDE' } },
    members: indexes.map((i) => ({
      character: {
        name: rosterName(i), id: rosterKey(i), realm: { id: REALM_ID, slug: 'dreamscythe' }, level: 70,
        playable_class: { id: CLASS_IDS[i % CLASS_IDS.length] }, playable_race: { id: 2 }, faction: { type: 'HORDE' },
      },
      rank: i === 0 ? 0 : 1 + (i % 9),
    })),
  };
}

check("'ingame': a sync that marks all of a person's characters Former makes the next guild request answer 403 not_member and drops the guild from me() and loadMemberGuilds", async () => {
  const net = { roster: blizzardRoster([0, 1, 2, 3]) };
  const s = await scenario({
    env: { BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret', BNET_REDIRECT_URI: 'https://raidsmith.test/auth/bnet/callback' },
    wrapFetch: (discordFetch) => async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.hostname === 'oauth.battle.net' && u.pathname === '/token') return Response.json({ access_token: 'fixture-token', token_type: 'bearer', expires_in: 86399 });
      if (/^\/data\/wow\/guild\/[^/]+\/[^/]+\/roster$/.test(u.pathname) && u.hostname.endsWith('.api.blizzard.com')) return Response.json(net.roster);
      return discordFetch(url, init);
    },
  });
  await s.member('raab', 'Raabplayer');
  await s.member('raac', 'Raacplayer');
  s.exec(`UPDATE guilds SET pinned_guild_slug = 'ember', pinned_realm_slug = 'dreamscythe', pinned_namespace = '${NAMESPACE}', blizzard_guild_id = 3000, blizzard_realm_id = ${REALM_ID} WHERE id = '${s.gid}'`);
  // Two persons (one character each) bound to roster members 1 and 2, and a stored Officer row on the first. Made as the Owner (the stored Guild Master row).
  const made = {};
  for (const [key, i] of [['raab', 1], ['raac', 2]]) {
    const person = await s.person({ name: rosterName(i) });
    keyCharacter(s, person.cid, rosterKey(i));
    await s.link(person.pid, key);
    made[key] = person;
  }
  await s.ok('gm', 'PUT', `/people/${s.uids.raab}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  setSource(s, 'ingame');
  const rs = await load('worker/roster-sync.js');
  const deps = () => ({ db: s.w.db, env: s.w.env, fetch: s.w.fetch, now: () => s.w.clock.now, randomBytes: s.w.randomBytes, log: () => {} });
  s.w.advance(1000);
  assert.equal((await rs.syncGuild(deps(), s.gid)).status, 'applied');
  assert.equal((await guildGet(s, 'raab')).status, 200, 'on the stored roster: a member');
  assert.equal((await guildGet(s, 'raac')).status, 200);
  assert.deepEqual(await memberGuildIds(s, 'raab'), [s.gid]);
  // The next good sync no longer lists member 1 (and keeps member 2): the sync sets left_on on its character - the person is all-Former.
  net.roster = blizzardRoster([0, 2, 3]);
  s.w.advance(7 * 60 * 60 * 1000);
  assert.equal((await rs.syncGuild(deps(), s.gid)).status, 'applied');
  assert((await s.one('SELECT left_on FROM characters WHERE id = ?', made.raab.cid)).left_on, 'the sync marked the character Former');
  const refused = await guildGet(s, 'raab');
  assert.deepEqual([refused.status, refused.json.error], [403, 'not_member']);
  assert(!mention(refused.json.message), refused.json.message);
  assert.deepEqual(await memberGuildIds(s, 'raab'), [], 'gone from me()');
  const { loadMemberGuilds } = await load('worker/bnet-store.js');
  assert.deepEqual((await loadMemberGuilds(s.w.db, s.uids.raab)).map((g) => g.id), [], 'gone from loadMemberGuilds');
  assert.equal((await s.rows("SELECT id FROM role_assignments WHERE user_id = ? AND role_id = 'officer'", s.uids.raab)).length, 1, 'the stored Officer row is still there and grants nothing');
  assert.equal((await s.call('raab', 'GET', '/people')).status, 403);
  assert.equal((await guildGet(s, 'raac')).status, 200, 'the other person is untouched');
  // The character comes back on the roster: the sync clears left_on and the person is let in again.
  net.roster = blizzardRoster([0, 1, 2, 3]);
  s.w.advance(7 * 60 * 60 * 1000);
  assert.equal((await rs.syncGuild(deps(), s.gid)).status, 'applied');
  assert.equal((await guildGet(s, 'raab')).status, 200);
  assert.deepEqual(await memberGuildIds(s, 'raab'), [s.gid]);
});

// ---------------------------------------------------------------------------
// 3. Query plans: "my guilds" never passes over every guild

// Every table alias a statement gives a table (and the table's own name): the names a plan row can call it.
function namesOf(sql, table) {
  const skip = /^(WHERE|JOIN|ON|LEFT|INNER|SET|GROUP|ORDER|LIMIT|USING|CROSS|AND|OR|UNION|SELECT|INDEXED|NOT|AS|VALUES)$/i;
  const names = new Set([table]);
  for (const match of sql.matchAll(new RegExp(`(?:\\b(?:FROM|JOIN)\\s+|,\\s*)${table}\\b(?:\\s+(?:AS\\s+)?([a-z_]\\w*))?`, 'gi'))) if (match[1] && !skip.test(match[1])) names.add(match[1]);
  return names;
}

// The tables this lane keeps off the full-scan path (plan "Read budgets"): the guilds themselves and the tables behind the per-source rule.
const GUARDED_TABLES = ['guilds', 'players', 'characters', 'guild_roster', 'role_assignments'];

// The statements a request ran (from the log position `from`) whose plan walks a whole guarded table: [{ table, detail, sql }].
function scansSince(db, from) {
  const found = [];
  // The views (effective_roles and friends, migration 0035) call their tables by their own aliases, which a plan row then carries: read those names too.
  const viewSql = db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'view'").all().map((row) => row.sql).join('\n');
  for (const { sql, values } of db.statementLog.slice(from)) {
    if (!/\b(guilds|players|characters|guild_roster|role_assignments|effective_roles\w*|ingame_proven_characters)\b/.test(sql)) continue;
    const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
    for (const table of GUARDED_TABLES) {
      const names = namesOf(`${sql}\n${viewSql}`, table);
      for (const row of plan) {
        const target = /^SCAN (?:TABLE )?(\S+)/.exec(row.detail);
        if (target && names.has(target[1])) found.push({ table, detail: row.detail, sql: sql.replace(/\s+/g, ' ').slice(0, 120) });
      }
    }
  }
  return found;
}

check('the plan checker sees a scan: a seeded full pass over guilds is reported, an index lookup is not', async () => {
  const s = await scenario();
  const from = s.w.db.statementLog.length;
  await s.w.db.prepare("SELECT g.id FROM guilds g WHERE g.name LIKE '%x%'").bind().all();
  await s.w.db.prepare('SELECT g.id FROM guilds g WHERE g.id = ?').bind(s.gid).all();
  await s.w.db.prepare('SELECT 1 FROM players WHERE user_id = ?').bind('u_x').all();
  const found = scansSince(s.w.db, from);
  assert.deepEqual(found.map((entry) => [entry.table, entry.detail]), [['guilds', 'SCAN g']]);
});

check('"my guilds" on a 2,000-guild database: GET /auth/me, the guild payload, PATCH /auth/prefs and loadMemberGuilds never scan guilds (or players, characters, guild_roster, role_assignments), and list exactly the guilds the rule lets the account into', async () => {
  const s = await scenario();
  const probe = await s.member('probe', 'Probeone');
  const raw = rawDb(s.w.db);
  const gb = (i) => `g_B${String(i).padStart(21, '0')}`;
  // 2,000 other guilds of every source, each in its own Discord server.
  s.w.db.sqlite.exec('BEGIN');
  for (let i = 0; i < 2000; i++) {
    s.w.db.sqlite.prepare(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source)
                           VALUES (?, ?, 'Nightslayer', 'realm', 'US', ?, 'America/New_York', 'tbc', 1, ?)`)
      .run(gb(i), `Big ${String(i).padStart(4, '0')}`, `8${String(i).padStart(17, '0')}`, [null, 'manual', 'ingame'][i % 3]);
  }
  s.w.db.sqlite.exec('COMMIT');
  const serverOf = (i) => `8${String(i).padStart(17, '0')}`;
  // The probe's ways in: g_big0 legacy + server (member), g_big1 manual + server (not), g_big4 manual + linked (member), g_big2 ingame + linked on the roster (member),
  // g_big5 ingame + linked off the roster (not), g_big8 ingame + the Owner seat (member), g_big11 ingame + server only (not).
  raw.inServer(probe, serverOf(0));
  raw.inServer(probe, serverOf(1));
  raw.inServer(probe, serverOf(11));
  raw.person('p_big4', gb(4), { userId: probe });
  raw.character('c_big4', gb(4), 'p_big4', { key: 3004 });
  raw.person('p_big2', gb(2), { userId: probe });
  raw.character('c_big2', gb(2), 'p_big2', { key: 3002 });
  raw.rosterRow(gb(2), 3002);
  raw.person('p_big5', gb(5), { userId: probe });
  raw.character('c_big5', gb(5), 'p_big5', { key: 3005 });
  // The Owner seat of an in-game guild, LIVE: a proven character on the roster that is marked Former, so only the Owner exemption lets the account in.
  raw.person('p_big8', gb(8), { userId: probe });
  raw.character('c_big8', gb(8), 'p_big8', { key: 3008, leftOn: '2026-10-01' });
  raw.rosterRow(gb(8), 3008);
  raw.prove('c_big8', probe, 880008);
  s.w.db.sqlite.prepare('UPDATE guilds SET owner_user_id = ? WHERE id = ?').run(probe, gb(8));
  // Other accounts crowd the same tables.
  for (let i = 0; i < 200; i++) {
    raw.user(`u_crowd${i}`, `4${String(i).padStart(17, '0')}`);
    raw.inServer(`u_crowd${i}`, serverOf(i));
    raw.person(`p_crowd${i}`, gb(i), { userId: `u_crowd${i}` });
    raw.character(`c_crowd${i}`, gb(i), `p_crowd${i}`, { key: 5000 + i });
  }
  const expected = [gb(0), gb(2), gb(4), gb(8), s.gid].sort();
  const db = s.w.db;

  let from = db.statementLog.length;
  const me = await s.ok('probe', 'GET', '/auth/me');
  assert.deepEqual(me.guilds.map((guild) => guild.id).sort(), expected, 'GET /auth/me lists exactly the guilds the rule allows');
  assert(db.statementLog.slice(from).some((entry) => /JOIN guilds g ON g\.id = mx_c\.guild_id/.test(entry.sql)), 'the candidate-driven statement ran');
  assert.deepEqual(scansSince(db, from), [], 'GET /auth/me');

  from = db.statementLog.length;
  assert.equal((await s.call('probe', 'GET', '')).status, 200);
  assert.deepEqual(scansSince(db, from), [], 'loadGuildContext (GET /api/guild/:gid)');
  from = db.statementLog.length;
  assert.equal((await s.call('probe', 'GET', '/auth/me').then(() => s.call('probe', 'GET', '/people'))).status, 403, 'a plain member may not list people');
  assert.deepEqual(scansSince(db, from), [], 'loadGuildContext on a refusal');

  for (const [guild, status] of [[gb(8), 200], [gb(2), 200], [gb(5), 400], [gb(11), 400], [gb(1), 400]]) {
    from = db.statementLog.length;
    const res = await s.call('probe', 'PATCH', '/auth/prefs', { lastGuildId: guild });
    assert.equal(res.status, status, `PATCH /auth/prefs lastGuildId ${guild}: ${res.text}`);
    assert.deepEqual(scansSince(db, from), [], `PATCH /auth/prefs ${guild}`);
  }

  from = db.statementLog.length;
  const { loadMemberGuilds } = await load('worker/bnet-store.js');
  assert.deepEqual((await loadMemberGuilds(db, probe)).map((guild) => guild.id).sort(), expected, 'loadMemberGuilds');
  assert.deepEqual(scansSince(db, from), [], 'loadMemberGuilds');

  // The account that leads a guild (Delete my data's impact list) is driven from its own role rows too.
  raw.gm(gb(3), probe);
  raw.inServer(probe, serverOf(3));
  from = db.statementLog.length;
  await s.ok('probe', 'GET', '/auth/me');
  assert.deepEqual(scansSince(db, from), [], 'GET /auth/me for a Guild Master of another guild');
});

// ---------------------------------------------------------------------------
// 4. CI grep: ONE definition of membership

const { sqlLiterals, workerFiles } = require('../worker-sql');

// Reading user_servers or players.user_id anywhere but worker/membership.js is allowed only for a reason that is not a membership decision. A file is listed with the
// number of SQL statements that touch the table (a new one fails the test: say what it is for, or fold it into the fragment).
const touchesUserServers = (sql) => /\buser_servers\b/.test(sql);
const touchesPlayersUserId = (sql) => /\bplayers\b/.test(sql) && /\buser_id\b/.test(sql);

const USER_SERVERS_ALLOWED = {
  'worker/block-tombstones.js': { count: 1, reason: 'the tombstone match at a Discord sign-in or link: which guilds with tombstones the account could reach, so the match runs there; it decides nothing about membership' },
  'worker/discord-sync.js': { count: 3, reason: 'Discord ROLE sync: "is the account in the Discord server" decides whether to call Discord for its roles (and who to sync), not who is in the guild; a stored role grants nothing while membership fails' },
  'worker/flip-preview.js': { count: 1, reason: 'the flip dry run lists the accounts of the guild\'s Discord server as candidates; today\'s rule is applied by memberSql, the in-game rule by the roster fragments' },
  'worker/routes/accounts.js': { count: 1, reason: 'write: disconnecting Discord clears the account\'s server rows' },
  'worker/routes/auth.js': { count: 3, reason: 'writes: a Discord sign-in or link replaces the account\'s server rows; servers that no longer have a guild are pruned' },
  'worker/routes/guild-data.js': { count: 1, reason: 'write: deleting a guild prunes the server rows of its Discord server' },
  'worker/routes/guild.js': { count: 2, reason: 'writes: creating or claiming a guild records its creator in the guild\'s server' },
};

const PLAYERS_USER_ID_ALLOWED = {
  'worker/bnet-match.js': { count: 9, reason: 'the Battle.net sign-in match: which person is the signing-in account\'s (players.user_id), the person it creates or is linked to, and the stamping of that person\'s characters; membership itself stays memberSql (a person on the roster is what makes the roster rule true)' },
  'worker/routes/person-blocks.js': { count: 1, reason: 'blocking a roster person: the person must have no account (players.user_id NULL and no user holding its Discord id); the block target is judged by the guild_blocks / person_blocks rows, not by membership' },
  'worker/block-tombstones.js': { count: 1, reason: 'the tombstone match: the guilds where the account has a person, to run the match there (the block itself is judged by guild_blocks and memberSql)' },
  'worker/bnet-store.js': { count: 2, reason: 'claim planning: which person is the claimant\'s own (ownership of a person; the member test is memberSql)' },
  'worker/claim-apply.js': { count: 3, reason: 'writes and guards of an applied claim: the person is still the claimant\'s' },
  'worker/flip-preview.js': { count: 3, reason: 'the flip dry run: the person each account has today and would have after the flip links the Discord-owned ones' },
  'worker/person-join.js': { count: 2, reason: 'the person join: whose person each one is (the refusal when two accounts own them, the survivor) and the account a carried block lands on; not a membership decision' },
  'worker/roster-view.js': { count: 4, reason: 'person pages and roster rows: the accounts linked to a person and the signed-in marker (memberSql decides who counts)' },
  'worker/routes/accounts.js': { count: 3, reason: 'an officer links or unlinks an account (writes) and the "already another person\'s" check' },
  'worker/routes/applications.js': { count: 1, reason: 'write: an accepted application makes a person linked to the applicant' },
  'worker/routes/attendance.js': { count: 2, reason: 'select lists: the person columns the attendance views show' },
  'worker/routes/auth.js': { count: 4, reason: 'identity guards: a Discord link must not put two people of a guild on one account; Delete my data unlinks the account\'s people, and first puts the account\'s block on its person (the person_blocks marker and its audit row)' },
  'worker/routes/bnet-claims.js': { count: 1, reason: 'guard of an approved claim: the person is still the claimant\'s' },
  'worker/routes/bnet.js': { count: 1, reason: 'claim fixtures: who owns the characters a Battle.net list names' },
  'worker/routes/loot.js': { count: 1, reason: 'select list: the person columns of a loot award' },
  'worker/routes/people.js': { count: 1, reason: 'People and roles: the roster entry shown next to each account' },
  'worker/routes/roster.js': { count: 2, reason: 'the "already another person\'s" check of a Discord link and the list of members with no person yet (memberSql decides who is a member)' },
  'worker/routes/team-requests.js': { count: 1, reason: 'ownership: the asker\'s account still owns the character\'s person' },
  'worker/seniority.js': { count: 1, reason: 'the account of a person (players.user_id, else the Discord ID match): the Seniority guard' },
};

function touchesOutsideMembership(detector) {
  const found = {};
  for (const file of workerFiles()) {
    if (file === 'worker/membership.js') continue;
    const hits = sqlLiterals(file).filter(({ sql }) => detector(sql)).length;
    if (hits) found[file] = hits;
  }
  return found;
}

check('CI grep: the detectors see what they must (seeded SQL)', () => {
  assert(touchesUserServers('SELECT 1 FROM user_servers us WHERE us.user_id = ?'));
  assert(touchesUserServers('DELETE FROM user_servers WHERE user_id = ?'));
  assert(!touchesUserServers('SELECT 1 FROM guild_blocks WHERE user_id = ?'));
  assert(touchesPlayersUserId('SELECT 1 FROM players p WHERE p.user_id = ?'));
  assert(touchesPlayersUserId('SELECT id FROM players WHERE guild_id = ? AND user_id = ?'));
  assert(touchesPlayersUserId('UPDATE players SET user_id = NULL WHERE id = ?'));
  assert(!touchesPlayersUserId('UPDATE players SET version = version + 1 WHERE id = ?'));
  assert(!touchesPlayersUserId('SELECT 1 FROM guild_blocks WHERE user_id = ?'));
});

check('CI grep: no worker file outside membership.js reads user_servers or players.user_id for a membership decision (every other touch is listed with its reason)', () => {
  const check1 = (found, allowed, label) => {
    for (const [file, count] of Object.entries(found)) {
      const entry = allowed[file];
      assert(entry, `${file} touches ${label} in ${count} statement(s) and is not listed: fold the membership decision into worker/membership.js, or list the file with its reason`);
      assert.equal(count, entry.count, `${file}: ${label} statements went from ${entry.count} to ${count}: say what the new one is for (not a membership decision), then update the count`);
    }
    for (const file of Object.keys(allowed)) assert(found[file], `${file} no longer touches ${label}: remove it from the allowlist`);
    for (const [file, entry] of Object.entries(allowed)) assert(entry.reason && entry.reason.length > 20, `${file}: a reason is required`);
  };
  check1(touchesOutsideMembership(touchesUserServers), USER_SERVERS_ALLOWED, 'user_servers');
  check1(touchesOutsideMembership(touchesPlayersUserId), PLAYERS_USER_ID_ALLOWED, 'players.user_id');
  // The pure form is not a second copy in use: no worker file but membership.js calls it.
  const users = workerFiles().filter((file) => file !== 'worker/membership.js' && /\b(membershipOf|reachesOf)\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')));
  assert.deepEqual(users, [], 'the SQL fragment is the decision; the pure forms mirror it for tests');
});

runChecks(checks);
