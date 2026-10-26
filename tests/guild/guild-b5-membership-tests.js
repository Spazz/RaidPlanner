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

const CHAR_STATES = ['none', 'unkeyed', 'offRoster', 'onRoster', 'formerOnRoster'];

check('reachesOf / membershipOf mirror memberSql / reachesGuildSql on every source and every combination of facts (an unknown source reads as legacy)', async () => {
  const m = await load('worker/membership.js');
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
                  if (state === 'onRoster' || state === 'formerOnRoster') raw.rosterRow(gid, 1000 + n);
                  if (state === 'offRoster') raw.rosterRow(gid, 500000 + n);
                }
              }
              if (blocked) raw.block(gid, uid);
              cases.push({ gid, uid, source, owner: ownerMode !== 'none', inServer, linked, state, blocked });
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
    const facts = { source: c.source, inServer: c.inServer, linked: c.linked, owner: c.owner, rosterCharacter: c.linked && c.state === 'onRoster' };
    const where = JSON.stringify(c);
    assert.equal(row.blocked === 1, c.blocked, where);
    assert.equal(row.reaches === 1, m.reachesOf(facts), `reaches: ${where}`);
    assert.equal(m.membershipOf({ blocked: c.blocked, ...facts }), c.blocked ? 'blocked' : (m.reachesOf(facts) ? 'member' : 'none'));
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
  assert.equal(m.membershipOf({ blocked: true, source: 'ingame', owner: true }), 'blocked');
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
  setSource(s, 'ingame');
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
  setSource(s, 'ingame');
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

check("'ingame': the Owner passes without a roster character; a Guild Master by role who does not hold the seat does not; a block beats the Owner exemption", async () => {
  const s = await world();
  setSource(s, 'ingame');
  assert.equal((await guildGet(s, 'gm')).status, 200, 'the stored Guild Master is the Owner while the seat is NULL');
  // The seat on another account that has no person: the Owner exemption; the Guild Master by role loses it.
  await s.setOwner('discordonly');
  assert.equal((await guildGet(s, 'discordonly')).status, 200, 'the seat holder is a member with no roster character');
  assert.deepEqual(await memberGuildIds(s, 'discordonly'), [s.gid], 'and the guild is in their list (the owner candidate set)');
  const derived = await guildGet(s, 'gm');
  assert.deepEqual([derived.status, derived.json.error], [403, 'not_member'], 'a derived Guild Master with no roster character');
  block(s, 'discordonly');
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

runChecks(checks);
