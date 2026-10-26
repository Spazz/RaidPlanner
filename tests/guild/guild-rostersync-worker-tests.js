/**
 * Raidsmith guild tracker - hierarchy build, lane B4a-code: the Battle.net roster fetch contract, the atomic-replace roster sync, its lease and scheduler, the
 * on-demand route, the daily retention jobs and the pin-only officer roster import.
 * Run: node tests/guild/guild-rostersync-worker-tests.js [name-filter]
 *
 * Drives the Worker over the node:sqlite D1 stand-in (tests/guild-world.js). Blizzard is an injected fetch that answers the client-credentials token and the guild
 * roster with FIXTURES (net.roster); nothing here touches the network, and no real guild, character or id is used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, adminOf, memberOf, makeWorld, signIn, person, ROOT } = require('../guild-world');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;
const TZ = 'America/New_York';
const NS = 'profile-classicann-us';
const SERVER = '900000000000000041';
const PEOPLE = { gm: person(61, 'Syncgm'), officer: person(62, 'Syncofficer'), member: person(63, 'Syncmember') };

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const filter = process.argv[2] || '';

let cached = null;
async function M() {
  if (cached) return cached;
  const [bn, rs, rt, pin, sched, rl, imp, rd] = await Promise.all([
    load('worker/battlenet.js'), load('worker/roster-sync.js'), load('worker/retention.js'), load('worker/roster-pin.js'),
    load('worker/scheduler.js'), load('worker/ratelimit.js'), load('worker/routes/bnet-import.js'), load('worker/roster-data.js'),
  ]);
  cached = { bn, rs, rt, pin, sched, rl, imp, rd };
  return cached;
}

// ---------------------------------------------------------------------------
// Blizzard fixtures (Blizzard's shapes, invented content)

const CLASS_IDS = [1, 2, 3, 4, 5, 7, 8, 9, 11];
// Letters only, so the same names can be roster characters (names are letters): Raaa, Raab, ...
const nameOf = (i) => 'R' + String.fromCharCode(97 + (Math.floor(i / 676) % 26), 97 + (Math.floor(i / 26) % 26), 97 + (i % 26));
const idOf = (i) => 9000 + i;

function memberEntry(i, { realmId = 4001, realmSlug = 'dreamscythe' } = {}) {
  return {
    character: {
      name: nameOf(i), id: idOf(i), realm: { id: realmId, slug: realmSlug }, level: 70,
      playable_class: { id: CLASS_IDS[i % CLASS_IDS.length] }, playable_race: { id: 2 }, faction: { type: 'HORDE' },
    },
    rank: i === 0 ? 0 : 1 + (i % 9),
  };
}

// A roster answer: member 0 is the Guild Master (rank 0), the rest hold ranks 1-9.
function rosterBody(count = 12, { guildId = 3000, realmId = 4001, realmSlug = 'dreamscythe', edit } = {}) {
  const body = {
    guild: { name: 'Ember', id: guildId, realm: { id: realmId, slug: realmSlug }, faction: { type: 'HORDE' } },
    members: Array.from({ length: count }, (_, i) => memberEntry(i, { realmId, realmSlug })),
  };
  if (edit) edit(body);
  return body;
}

// ---------------------------------------------------------------------------
// A guild with a Guild Master (+ optional Officer and Member), over a fetch that answers Blizzard from net.roster.

async function scenario({ teams = 1, pin = true, rankSource = null, officer = false, member = false, env = {}, guildName = 'Display Zzz', realm = 'Nightslayer' } = {}) {
  const net = { calls: [], roster: rosterBody(), tokenCalls: 0 };
  const w = await makeWorld({
    env: { BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret', BNET_REDIRECT_URI: 'https://raidsmith.test/auth/bnet/callback', ...env },
    wrapFetch: (discordFetch) => async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.hostname === 'oauth.battle.net' && u.pathname === '/token') {
        net.tokenCalls++;
        return Response.json({ access_token: 'fixture-token', token_type: 'bearer', expires_in: 86399 });
      }
      const roster = /^\/data\/wow\/guild\/([^/]+)\/([^/]+)\/roster$/.exec(u.pathname);
      if (roster && u.hostname.endsWith('.api.blizzard.com')) {
        const call = { region: u.hostname.split('.')[0], realmSlug: decodeURIComponent(roster[1]), guildSlug: decodeURIComponent(roster[2]), namespace: u.searchParams.get('namespace'), n: net.calls.length };
        net.calls.push(call);
        const answer = typeof net.roster === 'function' ? await net.roster(call) : net.roster;
        if (answer instanceof Response) return answer;
        if (answer && typeof answer.status === 'number' && !answer.members && !answer.guild) return new Response('{}', { status: answer.status });
        return Response.json(answer);
      }
      return discordFetch(url, init);
    },
  });
  const { bn } = await M();
  bn.resetBnetTokenCache();
  const jars = { gm: (await signIn(w, PEOPLE.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: guildName, gameVersion: 'tbc', region: 'US', realm, timeZone: TZ,
    multipleTeams: teams > 1, ...(teams > 1 ? { teamNames: ['Alpha', 'Bravo', 'Charlie'].slice(0, teams) } : {}),
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  const uids = {};
  uids.gm = (await w.call(jars.gm, 'GET', '/auth/me')).json.user.id;
  for (const key of [...(officer ? ['officer'] : []), ...(member ? ['member'] : [])]) {
    jars[key] = (await signIn(w, PEOPLE[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  if (officer) assert.equal((await w.call(jars.gm, 'PUT', `/api/guild/${gid}/people/${uids.officer}/roles`, { officer: true, teamLeadTeamIds: [] })).status, 200);
  const s = {
    w, net, gid, tids, jars, uids, base: `/api/guild/${gid}`, logs: [],
    advance: (ms) => w.advance(ms),
    call(who, method, tail, body) { return w.call(jars[who], method, `${s.base}${tail}`, body); },
    sql: (text, ...values) => w.db.sqlite.prepare(text).run(...values),
    rows: (text, ...values) => w.rows(text, ...values),
    // The deps the sync takes (the Worker's ctx minus the session); now() follows the world's clock unless a test fixes it.
    deps({ now, db } = {}) {
      return { db: db || w.db, env: w.env, fetch: w.fetch, now: now || (() => w.clock.now), randomBytes: w.randomBytes, log: (line) => s.logs.push(line) };
    },
    async sync(opts) { return (await M()).rs.syncGuild(s.deps(opts), gid); },
    pinTo(columns = {}) {
      const c = { rank_source: rankSource, slug: 'ember', realm: 'dreamscythe', ns: NS, guildId: 3000, realmId: 4001, ...columns };
      s.sql('UPDATE guilds SET rank_source = ?, pinned_guild_slug = ?, pinned_realm_slug = ?, pinned_namespace = ?, blizzard_guild_id = ?, blizzard_realm_id = ? WHERE id = ?',
        c.rank_source, c.slug, c.realm, c.ns, c.guildId, c.realmId, gid);
    },
    async snap() {
      return {
        roster: await s.rows('SELECT * FROM guild_roster WHERE guild_id = ? ORDER BY blizzard_realm_id, blizzard_char_id', gid),
        guild: (await s.rows('SELECT roster_hash, last_good_sync_id, last_good_fetched_at, next_sync_at, rank_source FROM guilds WHERE id = ?', gid))[0],
        characters: await s.rows('SELECT id, name, name_key, left_on, left_reason, updated_at, namespace, blizzard_realm_id, blizzard_char_id FROM characters WHERE guild_id = ? ORDER BY id', gid),
        aliases: await s.rows('SELECT character_id, name_key, realm_key, renamed_at FROM character_name_aliases WHERE guild_id = ? ORDER BY character_id, name_key', gid),
        raids: await s.rows('SELECT id, policy_fp, version FROM raids WHERE guild_id = ? ORDER BY id', gid),
      };
    },
    syncRows: () => s.rows('SELECT id, good, http_status, reason, counts, started_at FROM roster_syncs WHERE guild_id = ? ORDER BY started_at, id', gid),
  };
  if (pin) s.pinTo();
  return s;
}

// Another guild in the same world (own Guild Master and Discord server), pinned to the Blizzard guild slug/id given.
async function extraGuild(s, n, { pin = null, partial = false } = {}) {
  const server = `9000000000000000${50 + n}`;
  const jar = (await signIn(s.w, person(70 + n, `Syncgm${n}`), [adminOf(server)])).jar;
  const made = await s.w.call(jar, 'POST', '/api/guild', { serverId: server, name: `Extra ${n}`, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: TZ, multipleTeams: false });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  if (pin) {
    s.sql('UPDATE guilds SET pinned_guild_slug = ?, pinned_realm_slug = ?, pinned_namespace = ?, blizzard_guild_id = ?, blizzard_realm_id = ? WHERE id = ?',
      pin.slug, 'dreamscythe', NS, partial ? null : pin.guildId, partial ? null : 4001, gid);
  }
  return gid;
}

const until = async (predicate, what) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// A db whose batch() runs with statement `index` replaced by one that cannot run: "an injected failure in this statement".
function failingDb(db, index) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements) => {
          const copy = statements.slice();
          copy[index] = target.prepare('SELECT * FROM table_that_does_not_exist_for_the_test');
          return target.batch(copy);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// A db that records the size of every batch (and optionally refuses it).
function spyDb(db, { refuse = false } = {}) {
  const sizes = [];
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements) => {
          sizes.push(statements.length);
          if (refuse) throw new Error('refused by the test');
          return target.batch(statements);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, sizes };
}

// ---------------------------------------------------------------------------
// The fetch contract (pure)

check('contract: a roster answer is read into members with character id, realm id, namespace, name, realm slug, class, level and rank, plus the guild id, realm id and a truncation flag', async () => {
  const { bn } = await M();
  const parsed = bn.parseGuildRoster(rosterBody(12), NS);
  assert.deepEqual([parsed.guildId, parsed.guildRealmId, parsed.truncated, parsed.entries, parsed.nonTbc, parsed.membersPresent], [3000, 4001, false, 12, 0, true]);
  assert.deepEqual(parsed.problems, {});
  assert.deepEqual(parsed.members[0], { characterId: 9000, realmId: 4001, namespace: NS, name: nameOf(0), nameKey: nameOf(0).toLowerCase(), realmSlug: 'dreamscythe', class: 'WARRIOR', level: 70, rank: 0 });
  assert.deepEqual(parsed.members[1], { characterId: 9001, realmId: 4001, namespace: NS, name: nameOf(1), nameKey: nameOf(1).toLowerCase(), realmSlug: 'dreamscythe', class: 'PALADIN', level: 70, rank: 2 });
  assert.deepEqual(bn.assessRoster(parsed, { guildId: 3000, realmId: 4001 }), { good: true });
  assert.deepEqual(bn.assessRoster(parsed, null), { good: true }, 'an unpinned guild has no pin to compare with');
});

// One test per validity rule. edit(body) breaks the base answer in exactly one way; reason is what assessRoster answers.
const RULES = [
  ['the members array is missing', (b) => { delete b.members; }, 'members_missing'],
  ['members is not an array', (b) => { b.members = { a: 1 }; }, 'members_missing'],
  ['the Blizzard guild id differs from the pin', (b) => { b.guild.id = 3001; }, 'guild_id_mismatch'],
  ['the response names no guild id', (b) => { delete b.guild.id; }, 'guild_id_mismatch'],
  ['the Blizzard realm id differs from the pin', (b) => { b.guild.realm.id = 4002; }, 'realm_id_mismatch'],
  ['the response lists more than 1,200 members (truncated)', (b) => { b.members = Array.from({ length: 1201 }, (_, i) => memberEntry(i)); }, 'truncated'],
  ['a rank is null (it used to become rank 0)', (b) => { b.members[3].rank = null; }, 'rank_invalid'],
  ['a rank is missing', (b) => { delete b.members[3].rank; }, 'rank_invalid'],
  ['a rank is a numeric string', (b) => { b.members[3].rank = '3'; }, 'rank_invalid'],
  ['a rank is above 9', (b) => { b.members[3].rank = 10; }, 'rank_invalid'],
  ['a rank is negative', (b) => { b.members[3].rank = -1; }, 'rank_invalid'],
  ['a rank is fractional', (b) => { b.members[3].rank = 2.5; }, 'rank_invalid'],
  ['a character id is missing', (b) => { delete b.members[3].character.id; }, 'ids_invalid'],
  ['a character id is zero', (b) => { b.members[3].character.id = 0; }, 'ids_invalid'],
  ['a character id is a string', (b) => { b.members[3].character.id = '9003'; }, 'ids_invalid'],
  ['a character id is fractional', (b) => { b.members[3].character.id = 9003.5; }, 'ids_invalid'],
  ['a member realm id is missing', (b) => { delete b.members[3].character.realm.id; }, 'ids_invalid'],
  ['a member realm id is zero', (b) => { b.members[3].character.realm.id = 0; }, 'ids_invalid'],
  ['two members share a character id and realm id', (b) => { b.members[5].character.id = b.members[4].character.id; }, 'duplicate_id'],
  ['a member has no playable class (not the same as a class the roster does not know)', (b) => { delete b.members[3].character.playable_class; }, 'class_invalid'],
  ['a member realm is not a plain slug', (b) => { b.members[3].character.realm.slug = 'Faraway Isle'; }, 'realm_invalid'],
  ['a member name is empty', (b) => { b.members[3].character.name = '   '; }, 'name_invalid'],
  ['a member is not an object', (b) => { b.members[3] = null; }, 'shape_invalid'],
  ['no member holds rank 0', (b) => { b.members[0].rank = 1; }, 'no_rank_zero'],
  ['two members hold rank 0', (b) => { b.members[2].rank = 0; }, 'several_rank_zero'],
  ['two members share a name and realm slug (any letter case)', (b) => { b.members[6].character.name = nameOf(5).toUpperCase(); }, 'duplicate_name'],
];
for (const [rule, edit, reason] of RULES) {
  check(`validity: ${rule} -> not GOOD (${reason})`, async () => {
    const { bn } = await M();
    const body = rosterBody(12);
    edit(body);
    const verdict = bn.assessRoster(bn.parseGuildRoster(body, NS), { guildId: 3000, realmId: 4001 });
    assert.deepEqual(verdict, { good: false, reason });
  });
}

check('validity: a rank null is never read as rank 0 and a truncated answer reads only the first 1,200 members', async () => {
  const { bn } = await M();
  const nullRank = bn.parseGuildRoster(rosterBody(12, { edit: (b) => { b.members[3].rank = null; } }), NS);
  assert.equal(nullRank.members.length, 11);
  assert.equal(nullRank.members.filter((m) => m.rank === 0).length, 1, 'only the real Guild Master holds rank 0');
  assert.deepEqual(nullRank.problems, { rank: 1 });
  const big = bn.parseGuildRoster(rosterBody(0, { edit: (b) => { b.members = Array.from({ length: 1300 }, (_, i) => memberEntry(i)); } }), NS);
  assert.deepEqual([big.truncated, big.entries, big.members.length], [true, 1300, 1200]);
});

check('validity: rows are rejected only for classes the roster does not know (a Death Knight, a Monk): the answer is still GOOD and the count is reported', async () => {
  const { bn } = await M();
  const body = rosterBody(12, { edit: (b) => {
    b.members.push({ character: { name: 'Gravewalk', id: 9100, realm: { id: 4001, slug: 'dreamscythe' }, level: 70, playable_class: { id: 6 } }, rank: 3 });
    b.members.push({ character: { name: 'Monkish', id: 9101, realm: { id: 4001, slug: 'dreamscythe' }, level: 70, playable_class: { id: 10 } }, rank: null });
  } });
  const parsed = bn.parseGuildRoster(body, NS);
  assert.deepEqual([parsed.members.length, parsed.nonTbc, parsed.entries], [12, 2, 14]);
  assert.deepEqual(bn.assessRoster(parsed, { guildId: 3000, realmId: 4001 }), { good: true });
});

check('fetchAccountCharacters also returns the character id, realm id and namespace; the callers\' fields are unchanged', async () => {
  const { bn } = await M();
  const profile = { wow_accounts: [{ id: 5, characters: [
    { name: 'Aldric', id: 7000, realm: { id: 4001, name: 'Dreamscythe', slug: 'dreamscythe' }, playable_class: { id: 1 }, level: 70 },
    { name: 'Noids', realm: { name: 'Dreamscythe', slug: 'dreamscythe' }, playable_class: { id: 2 } },
  ] }] };
  const ctx = { env: { BNET_CLIENT_ID: 'x', BNET_CLIENT_SECRET: 'y' }, now: () => T0, fetch: async () => Response.json(profile) };
  const found = await bn.fetchAccountCharacters(ctx, 'member-token', 'US', NS);
  assert.deepEqual(found[0], { name: 'Aldric', realmName: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'WARRIOR', level: 70, characterId: 7000, realmId: 4001, namespace: NS });
  assert.deepEqual([found[1].characterId, found[1].realmId, found[1].namespace, found[1].name], [null, null, NS, 'Noids'], 'a missing id is null, the character is still listed');
});

check('rosterHash: equal whatever order Blizzard lists the members in, different when anything the roster stores changes', async () => {
  const { bn, rs } = await M();
  const parse = (b) => bn.parseGuildRoster(b, NS);
  const base = await rs.rosterHash(parse(rosterBody(12)));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await rs.rosterHash(parse(rosterBody(12, { edit: (b) => b.members.reverse() }))), base);
  assert.notEqual(await rs.rosterHash(parse(rosterBody(12, { edit: (b) => { b.members[4].rank = 9; } }))), base);
  assert.notEqual(await rs.rosterHash(parse(rosterBody(12, { edit: (b) => { b.members[4].character.level = 69; } }))), base);
  assert.notEqual(await rs.rosterHash(parse(rosterBody(12, { edit: (b) => { b.members[4].character.name = 'Rzzz'; } }))), base);
  assert.notEqual(await rs.rosterHash(parse(rosterBody(11))), base);
});

// ---------------------------------------------------------------------------
// The sync

check('a good sync stores the roster; two consecutive good syncs keep every member; an unchanged answer writes a roster_syncs row and moves only the guard value', async () => {
  const s = await scenario();
  const first = await s.sync();
  assert.deepEqual([first.status, first.members], ['applied', 12]);
  let snap = await s.snap();
  assert.equal(snap.roster.length, 12);
  assert.deepEqual(snap.roster[0], {
    guild_id: s.gid, namespace: NS, blizzard_realm_id: 4001, blizzard_char_id: 9000, name: nameOf(0), name_key: nameOf(0).toLowerCase(), realm_slug: 'dreamscythe', class: 'WARRIOR', level: 70, rank: 0,
  });
  assert.equal(snap.guild.last_good_sync_id, first.syncId);
  assert.equal(snap.guild.last_good_fetched_at, T0);
  assert.match(snap.guild.roster_hash, /^[0-9a-f]{64}$/);
  // The Guild Master's call went to the PINNED target: realm and guild slug from the pin, the profile namespace from the pin.
  assert.deepEqual(s.net.calls.map((c) => [c.region, c.realmSlug, c.guildSlug, c.namespace]), [['us', 'dreamscythe', 'ember', NS]]);

  // A second good sync with one rank changed and one member added: every member is still there.
  s.advance(6 * HOUR);
  s.net.roster = rosterBody(13, { edit: (b) => { b.members[4].rank = 9; } });
  const second = await s.sync();
  assert.equal(second.status, 'applied');
  snap = await s.snap();
  assert.equal(snap.roster.length, 13, 'every member kept, the new one added');
  assert.equal(snap.roster.find((r) => r.blizzard_char_id === 9004).rank, 9);
  assert.equal(snap.guild.last_good_sync_id, second.syncId);

  // Unchanged answer: the roster_syncs row, and the guard value moves to this fetch; the roster, hash and sync pointer (the dry-run token's) stay.
  s.advance(6 * HOUR);
  const before = await s.snap();
  const mark = s.w.db.statementLog.length;
  const third = await s.sync();
  assert.deepEqual([third.status, third.members], ['unchanged', 13]);
  const after = await s.snap();
  assert.equal(after.guild.last_good_fetched_at, T0 + 12 * HOUR, 'the guard value advanced to this fetch');
  assert.deepEqual({ ...after, guild: { ...after.guild, last_good_fetched_at: null } }, { ...before, guild: { ...before.guild, last_good_fetched_at: null } },
    'roster, hash, sync pointer and everything else untouched');
  assert.equal(after.guild.last_good_sync_id, second.syncId);
  const writes = s.w.db.statementLog.slice(mark).filter((entry) => !/^\s*(SELECT|WITH\s+\w+\s+AS\s*\(\s*SELECT)/i.test(entry.sql)).map((entry) => entry.sql.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.deepEqual(writes, ['INSERT INTO roster_syncs', 'UPDATE guilds SET']);
  const rows = await s.syncRows();
  assert.deepEqual(rows.map((r) => [r.good, r.reason]), [[1, null], [1, null], [1, null]]);
  assert.equal(JSON.parse(rows[2].counts).unchanged, true);
});

check('a response that is not GOOD (null rank, wrong guild id, truncated) writes only a roster_syncs row with the reason; Blizzard refusing or failing does the same', async () => {
  const s = await scenario();
  await s.sync();
  const before = await s.snap();
  const attempts = [
    [rosterBody(12, { edit: (b) => { b.members[3].rank = null; } }), 'rank_invalid', 200],
    [rosterBody(12, { guildId: 3999 }), 'guild_id_mismatch', 200],
    [rosterBody(12, { realmId: 4999 }), 'realm_id_mismatch', 200],
    [rosterBody(0, { edit: (b) => { b.members = Array.from({ length: 1201 }, (_, i) => memberEntry(i)); } }), 'truncated', 200],
    [{ status: 403 }, 'bnet_denied', 403],
    [{ status: 404 }, 'bnet_not_found', 404],
    [{ status: 500 }, 'bnet_unavailable', 500],
  ];
  for (const [answer, reason, http] of attempts) {
    s.advance(HOUR);
    s.net.roster = answer;
    const result = await s.sync();
    assert.deepEqual([result.status, result.reason], ['failed', reason]);
    assert.deepEqual(await s.snap(), before, `${reason}: nothing but the sync log changed`);
    const last = (await s.syncRows()).pop();
    assert.deepEqual([last.good, last.reason, last.http_status], [0, reason, http]);
  }
  assert.equal((await s.syncRows()).length, 1 + attempts.length);
});

check('not configured (no Battle.net credentials) and a pin that no longer matches the guild\'s version and region are recorded as failures without calling Blizzard', async () => {
  const s = await scenario({ env: { BNET_CLIENT_ID: '' } });
  assert.equal((await s.sync()).reason, 'not_configured');
  const t = await scenario();
  t.pinTo({ ns: 'profile-classicann-eu' });
  assert.equal((await t.sync()).reason, 'pin_namespace_mismatch');
  assert.deepEqual([s.net.calls.length, t.net.calls.length], [0, 0]);
});

check('an injected failure in ANY statement of the batch leaves the roster, the characters, the aliases, the raids and the guild unchanged', async () => {
  const s = await scenario({ teams: 2, rankSource: 'ingame' });
  const ids = [];
  for (const [i, team] of [[1, 0], [2, 0], [3, 1]]) {
    const res = await s.call('gm', 'POST', '/roster', { teamId: s.tids[team], name: nameOf(i), class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
    ids.push(res.json.characters[0].id);
    s.sql('UPDATE characters SET namespace = ?, blizzard_realm_id = 4001, blizzard_char_id = ? WHERE id = ?', NS, idOf(i), res.json.characters[0].id);
  }
  assert.equal((await s.sync()).status, 'applied');
  s.sql("UPDATE raids SET policy_fp = 'fp'");
  s.sql("INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, policy_fp, version, created_at, updated_at) VALUES ('ra_manual', ?, ?, '2027-01-02', ?, 'manual', 'no log', 'fp', 5, 1, 1)", s.gid, s.tids[0], T0);
  s.advance(6 * HOUR);
  s.net.roster = rosterBody(12, { edit: (b) => { b.members[1].character.name = 'Rrenamed'; b.members.splice(2, 1); } });
  const spy = spyDb(s.w.db, { refuse: true });
  await s.sync({ db: spy.db });
  const total = spy.sizes[0];
  assert.equal(total, 5 + 1 + 1 + 1 + 1, 'stale, alias, rename, Former, returning + delete + one insert chunk + sync row + guild update');
  const before = await s.snap();
  const logged = (await s.syncRows()).length;
  for (let i = 0; i < total; i++) {
    s.advance(1000);
    const result = await s.sync({ db: failingDb(s.w.db, i) });
    assert.deepEqual([result.status, result.reason], ['failed', 'batch_failed'], `statement ${i}`);
    assert.deepEqual(await s.snap(), before, `a failure in statement ${i} rolled everything back`);
  }
  assert.equal((await s.syncRows()).length, logged + total, 'each failed attempt left one roster_syncs row');
  // And the same answer applies cleanly afterwards: the rename, the alias, the Former mark and the stale marking all land.
  s.advance(1000);
  assert.equal((await s.sync()).status, 'applied');
  const after = await s.snap();
  assert.equal(after.roster.length, 11);
  assert.equal(after.characters.find((c) => c.id === ids[0]).name, 'Rrenamed');
  assert.deepEqual(after.aliases.map((a) => [a.character_id, a.name_key]), [[ids[0], nameOf(1).toLowerCase()]]);
  assert.notEqual(after.characters.find((c) => c.id === ids[1]).left_on, null);
  assert.equal(after.raids.find((r) => r.id === 'ra_manual').policy_fp, '');
});

check('two overlapping runs end with one whole roster; an older fetch applied last changes nothing, in either order', async () => {
  const s = await scenario();
  const older = rosterBody(12, { edit: (b) => { b.members[3].rank = 5; } });
  const newer = rosterBody(14, { edit: (b) => { b.members[3].rank = 7; } });
  const gates = {};
  s.net.roster = (call) => new Promise((resolve) => { gates[call.n] = () => resolve(call.n === 0 ? older : newer); });
  const a = s.sync({ now: () => T0 + 1000 });
  await until(() => gates[0], 'the first fetch');
  const b = s.sync({ now: () => T0 + 5000 });
  await until(() => gates[1], 'the second fetch');
  gates[1]();
  const rb = await b;
  assert.equal(rb.status, 'applied');
  const afterNewer = await s.snap();
  gates[0]();
  const ra = await a;
  assert.deepEqual([ra.status, ra.reason], ['superseded', 'superseded']);
  assert.deepEqual(await s.snap(), afterNewer, 'the older fetch, applied last, changed nothing');
  assert.equal(afterNewer.roster.length, 14, 'one whole roster: the newer one');
  assert.equal(afterNewer.roster.find((r) => r.blizzard_char_id === 9003).rank, 7);
  assert.equal(afterNewer.guild.last_good_fetched_at, T0 + 5000);
  const rows = await s.syncRows();
  assert.deepEqual(rows.map((r) => [r.good, r.reason]).sort(), [[0, 'superseded'], [1, null]]);

  // The other order (older lands first, newer second): both apply, the newer roster is what stays.
  const t = await scenario();
  t.net.roster = (call) => Promise.resolve(call.n === 0 ? older : newer);
  assert.equal((await t.sync({ now: () => T0 + 1000 })).status, 'applied');
  assert.equal((await t.sync({ now: () => T0 + 5000 })).status, 'applied');
  const final = await t.snap();
  assert.equal(final.roster.length, 14);
  // The same fetch time twice is not "newer": the second one changes nothing.
  assert.equal((await t.sync({ now: () => T0 + 5000 })).status, 'unchanged', 'same answer, same hash');
  t.net.roster = rosterBody(15);
  const same = await t.sync({ now: () => T0 + 5000 });
  assert.deepEqual([same.status, same.reason], ['superseded', 'superseded']);
  assert.equal((await t.snap()).roster.length, 14);
});

check('a pin that changes under a running fetch (the Blizzard guild id no longer matches) makes the batch refuse', async () => {
  const s = await scenario();
  let release;
  s.net.roster = () => new Promise((resolve) => { release = () => resolve(rosterBody(12)); });
  const run = s.sync();
  await until(() => release, 'the fetch');
  s.sql('UPDATE guilds SET blizzard_guild_id = NULL WHERE id = ?', s.gid);
  release();
  const result = await run;
  assert.deepEqual([result.status, result.reason], ['superseded', 'superseded']);
  assert.equal((await s.snap()).roster.length, 0);
});

check('a 1,200-member roster fits the D1 limits: a fixed number of statements, none over 100 parameters or 100 KB; an unchanged one costs a read and one insert', async () => {
  const { rs } = await M();
  const s = await scenario({ rankSource: 'ingame' });
  s.net.roster = rosterBody(1200);
  const spy = spyDb(s.w.db);
  const mark = s.w.db.statementLog.length;
  const result = await s.sync({ db: spy.db });
  assert.deepEqual([result.status, result.members], ['applied', 1200]);
  assert.deepEqual(spy.sizes, [12], 'ONE batch of 12 statements: 5 character-side, 1 delete, 4 insert chunks of 300, the sync row, the guild update');
  const log = s.w.db.statementLog.slice(mark);
  assert.equal(log.length, 1 + 12, 'one pin read + the batch');
  assert(log.every((entry) => entry.values.length <= 100 && Buffer.byteLength(entry.sql) < 100_000));
  assert.equal(rs.ROSTER_INSERT_CHUNK * 4, 1200);
  assert.equal((await s.snap()).roster.length, 1200);
  // An unchanged 1,200-member answer: the pin read and one batch of two (the roster_syncs insert, the guard-value update), nothing else.
  s.advance(6 * HOUR);
  const mark2 = s.w.db.statementLog.length;
  spy.sizes.length = 0;
  assert.equal((await s.sync({ db: spy.db })).status, 'unchanged');
  assert.equal(s.w.db.statementLog.length - mark2, 3);
  assert.deepEqual(spy.sizes, [2]);
});

check('a newer UNCHANGED fetch advances the guard value, so an older changed fetch applied after it changes nothing (roster_hash and last_good_sync_id stay)', async () => {
  const s = await scenario();
  const first = await s.sync({ now: () => T0 + 1000 });
  assert.equal(first.status, 'applied');
  const stored = await s.snap();
  const older = rosterBody(14, { edit: (b) => { b.members[3].rank = 7; } });
  const gates = {};
  const base = s.net.calls.length;
  s.net.roster = (call) => new Promise((resolve) => { gates[call.n] = () => resolve(call.n === base ? older : rosterBody(12)); });
  const a = s.sync({ now: () => T0 + 3000 });
  await until(() => gates[base], 'the older, changed fetch');
  const b = s.sync({ now: () => T0 + 5000 });
  await until(() => gates[base + 1], 'the newer, unchanged fetch');
  gates[base + 1]();
  assert.equal((await b).status, 'unchanged');
  const afterUnchanged = await s.snap();
  assert.equal(afterUnchanged.guild.last_good_fetched_at, T0 + 5000, 'the guard value moved to the newer fetch');
  assert.equal(afterUnchanged.guild.last_good_sync_id, first.syncId, 'the dry-run token\'s sync id did not move');
  assert.equal(afterUnchanged.guild.roster_hash, stored.guild.roster_hash);
  assert.deepEqual(afterUnchanged.roster, stored.roster);
  gates[base]();
  const ra = await a;
  assert.deepEqual([ra.status, ra.reason], ['superseded', 'superseded']);
  assert.deepEqual(await s.snap(), afterUnchanged, 'the older changed fetch, applied last, changed nothing');
  assert.equal(afterUnchanged.roster.length, 12);
  // An older UNCHANGED fetch never moves the guard value backwards.
  s.net.roster = rosterBody(12);
  assert.equal((await s.sync({ now: () => T0 + 4000 })).status, 'unchanged');
  assert.equal((await s.snap()).guild.last_good_fetched_at, T0 + 5000);
});

check('before the flip the batch writes only guild_roster, roster_syncs and the guild\'s sync columns; characters, aliases and raids stay as they were', async () => {
  const s = await scenario({ teams: 2, rankSource: null });
  const r1 = await s.call('gm', 'POST', '/roster', { teamId: s.tids[0], name: nameOf(1), class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  const r2 = await s.call('gm', 'POST', '/roster', { teamId: s.tids[0], name: nameOf(2), class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  for (const [res, i] of [[r1, 1], [r2, 2]]) s.sql('UPDATE characters SET namespace = ?, blizzard_realm_id = 4001, blizzard_char_id = ? WHERE id = ?', NS, idOf(i), res.json.characters[0].id);
  s.sql("INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, policy_fp, version, created_at, updated_at) VALUES ('ra_manual', ?, ?, '2027-01-02', ?, 'manual', 'no log', 'fp', 5, 1, 1)", s.gid, s.tids[0], T0);
  await s.sync();
  s.advance(6 * HOUR);
  const before = await s.snap();
  s.net.roster = rosterBody(12, { edit: (b) => { b.members[1].character.name = 'Rrenamed'; b.members.splice(2, 1); } });
  assert.equal((await s.sync()).status, 'applied');
  const after = await s.snap();
  assert.deepEqual(after.characters, before.characters, 'no rename, no Former mark');
  assert.deepEqual(after.aliases, []);
  assert.deepEqual(after.raids, before.raids, 'no raid marked stale');
  assert.equal(after.roster.length, 11);
  assert.notEqual(after.guild.roster_hash, before.guild.roster_hash);
});

check('in-game guild: a rename keeps its old name as a dated alias, a character that left the roster becomes Former, one that returns is cleared, one never seen on the roster is left alone', async () => {
  const { rd } = await M();
  const s = await scenario({ teams: 2, rankSource: 'ingame' });
  const make = async (i, team, name = nameOf(i)) => {
    const res = await s.call('gm', 'POST', '/roster', { teamId: s.tids[team], name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
    assert.equal(res.status, 201, res.text);
    return res.json.characters[0].id;
  };
  const ren = await make(1, 0);
  const left = await make(2, 0);
  const stay = await make(3, 1);
  const back = await make(4, 1);
  const never = await make(5, 1, 'Nobody');
  const phantom = await make(6, 1, 'Phantom');
  for (const [id, i] of [[ren, 1], [left, 2], [stay, 3], [back, 4]]) s.sql('UPDATE characters SET namespace = ?, blizzard_realm_id = 4001, blizzard_char_id = ? WHERE id = ?', NS, idOf(i), id);
  s.sql('UPDATE characters SET namespace = ?, blizzard_realm_id = 4001, blizzard_char_id = 9777 WHERE id = ?', NS, phantom); // an identity key that is on no roster, ever
  s.sql("UPDATE characters SET left_on = '2026-12-01' WHERE id = ?", back);
  assert.equal((await s.sync()).status, 'applied');
  const base = await s.snap();
  const row = (snap, id) => snap.characters.find((c) => c.id === id);
  s.advance(6 * HOUR);
  s.net.roster = rosterBody(12, { edit: (b) => { b.members[1].character.name = 'Rrenamed'; b.members.splice(2, 1); } });
  assert.equal((await s.sync()).status, 'applied');
  const snap = await s.snap();
  const now = T0 + 6 * HOUR;
  assert.deepEqual([row(snap, ren).name, row(snap, ren).name_key], ['Rrenamed', 'rrenamed']);
  assert.deepEqual(snap.aliases, [{ character_id: ren, name_key: nameOf(1).toLowerCase(), realm_key: 'nightslayer', renamed_at: now }]);
  assert.equal(row(snap, left).left_on, rd.todayIn(TZ, now), 'left the roster: Former as of today');
  assert.equal(row(snap, left).left_reason, null);
  assert.equal(row(snap, back).left_on, null, 'its key is on the roster again: Former cleared');
  assert.deepEqual(row(snap, stay), row(base, stay), 'untouched');
  assert.deepEqual(row(snap, never), row(base, never), 'a character without an identity key is not made Former');
  assert.deepEqual([row(base, phantom).left_on, row(snap, phantom).left_on], [null, null], 'nor is one whose identity key was never in a stored roster (Social, not Former), in the first sync or the next');
  // The Former one returns: cleared.
  s.advance(6 * HOUR);
  s.net.roster = rosterBody(12, { edit: (b) => { b.members[1].character.name = 'Rrenamed'; } });
  assert.equal((await s.sync()).status, 'applied');
  assert.equal(row(await s.snap(), left).left_on, null);
});

check('a rename onto a name another character already holds is skipped (no alias, no error); the sync still applies', async () => {
  const s = await scenario({ rankSource: 'ingame' });
  const a = await s.call('gm', 'POST', '/roster', { teamId: s.tids[0], name: nameOf(1), class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  const taken = await s.call('gm', 'POST', '/roster', { teamId: s.tids[0], name: 'Rtaken', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  assert.equal(taken.status, 201, taken.text);
  s.sql('UPDATE characters SET namespace = ?, blizzard_realm_id = 4001, blizzard_char_id = ? WHERE id = ?', NS, idOf(1), a.json.characters[0].id);
  await s.sync();
  s.advance(6 * HOUR);
  s.net.roster = rosterBody(12, { edit: (b) => { b.members[1].character.name = 'Rtaken'; } });
  assert.equal((await s.sync()).status, 'applied');
  const snap = await s.snap();
  assert.equal(snap.characters.find((c) => c.id === a.json.characters[0].id).name, nameOf(1));
  assert.deepEqual(snap.aliases, []);
  assert.equal(snap.roster.find((r) => r.blizzard_char_id === idOf(1)).name, 'Rtaken', 'the stored roster still follows Blizzard');
});

check('stale marking: a sync-applied rename / Former / return marks the same raids stale as the manual rename path (markRaidsStale) does', async () => {
  const seed = async () => {
    const s = await scenario({ teams: 2, rankSource: 'ingame' });
    const res = await s.call('gm', 'POST', '/roster', { teamId: s.tids[0], name: nameOf(1), class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
    const cid = res.json.characters[0].id;
    s.sql('UPDATE characters SET namespace = ?, blizzard_realm_id = 4001, blizzard_char_id = ? WHERE id = ?', NS, idOf(1), cid);
    // Raids: A1 (team A, manual log = evidence), A2 (team A, no evidence), B1 (team B, its log names the old name), B2 (team B, nothing).
    const raid = (id, team, on, mode) => s.sql('INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, policy_fp, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, 1, 1)',
      id, s.gid, s.tids[team], on, T0, mode, mode === 'manual' ? 'no log' : null, 'fp');
    raid('ra_A1', 0, '2027-01-01', 'manual');
    raid('ra_A2', 0, '2027-01-02', 'log');
    raid('ra_B1', 1, '2027-01-01', 'log');
    raid('ra_B2', 1, '2027-01-02', 'log');
    s.sql("INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('ra_B1', ?, 'ABCDEFGHIJKLMNOP', 'fresh', 1, 1)", s.gid);
    s.sql("INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (1, 'ra_B1', 'ABCDEFGHIJKLMNOP', 1, 100, 'Boss', 1, 1, 2)");
    s.sql("INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm_key) VALUES (1, 'ra_B1', ?, ?, ?, 'nightslayer')", s.gid, nameOf(1), nameOf(1).toLowerCase());
    return { s, cid };
  };
  const marked = async (s) => (await s.rows("SELECT id FROM raids WHERE guild_id = ? AND policy_fp = '' ORDER BY id", s.gid)).map((r) => r.id);
  const versions = async (s) => (await s.rows('SELECT id, version FROM raids WHERE guild_id = ? ORDER BY id', s.gid)).map((r) => [r.id, r.version]);

  const { s } = await seed();
  assert.equal((await s.sync()).status, 'applied');
  assert.deepEqual(await marked(s), [], 'the first sync renames nothing and marks nothing');
  s.advance(6 * HOUR);
  s.net.roster = rosterBody(12, { edit: (b) => { b.members[1].character.name = 'Rrenamed'; } });
  assert.equal((await s.sync()).status, 'applied');
  const bySync = await marked(s);
  const versionsBySync = await versions(s);

  // The manual path on an identical world: roster.js's rename marks the old and new name keys and the character's team.
  const { s: t } = await seed();
  const { attendance } = { attendance: await load('worker/attendance-store.js') };
  await t.w.db.batch([attendance.markRaidsStale(t.w.db, t.gid, [nameOf(1).toLowerCase(), 'rrenamed'], null, [t.tids[0]])]);
  assert.deepEqual(bySync, await marked(t), 'the same raids');
  assert.deepEqual(bySync, ['ra_A1', 'ra_B1']);
  assert.deepEqual(versionsBySync, await versions(t), 'and the same version bumps');
});

check('the hook for B4b\'s applyRankMap exists and adds no statement yet; replaceGuards hands it the two guards', async () => {
  const { rs } = await M();
  const s = await scenario();
  assert.deepEqual(rs.applyRankMapStatements(s.w.db, {}, rs.replaceGuards({ guildId: 'g', blizzardGuildId: 1, blizzardRealmId: 2, namespace: NS, fetchedAt: 3 })), []);
  const guards = rs.replaceGuards({ guildId: 'g', blizzardGuildId: 1, blizzardRealmId: 2, namespace: NS, fetchedAt: 3 });
  assert.deepEqual([guards.monotonic.params, guards.ingame.params], [['g', 1, 2, NS, 3], ['g']]);
});

// ---------------------------------------------------------------------------
// Lease and scheduler

check('lease: the cron claim moves next_sync_at six hours on and only one of two simultaneous claims wins; an unpinned or half-pinned guild can never be claimed', async () => {
  const { rs } = await M();
  const s = await scenario();
  const results = await Promise.all([rs.claimSyncLease(s.w.db, s.gid, T0), rs.claimSyncLease(s.w.db, s.gid, T0)]);
  assert.deepEqual(results.slice().sort(), [false, true]);
  assert.equal((await s.snap()).guild.next_sync_at, T0 + 6 * HOUR);
  assert.equal(await rs.claimSyncLease(s.w.db, s.gid, T0 + 6 * HOUR - 1), false, 'not due yet');
  assert.equal(await rs.claimSyncLease(s.w.db, s.gid, T0 + 6 * HOUR), true, 'due');
  const unpinned = await scenario({ pin: false });
  assert.equal(await rs.claimSyncLease(unpinned.w.db, unpinned.gid, T0), false);
  assert.equal((await unpinned.snap()).guild.next_sync_at, 0);
  const half = await scenario({ pin: false });
  half.sql("UPDATE guilds SET pinned_guild_slug = 'ember', pinned_realm_slug = 'dreamscythe', pinned_namespace = ? WHERE id = ?", NS, half.gid);
  assert.equal(await rs.claimSyncLease(half.w.db, half.gid, T0), false, 'slug, realm and namespace without the Blizzard ids cannot be validated, so it is not synced');
});

check('lease: an on-demand claim needs the last claim to be at least an hour old, and then takes the same column', async () => {
  const { rs } = await M();
  const s = await scenario();
  assert.equal(await rs.claimSyncLease(s.w.db, s.gid, T0, { onDemand: true }), true, 'a never-synced guild');
  assert.equal(await rs.claimSyncLease(s.w.db, s.gid, T0 + HOUR - 1, { onDemand: true }), false);
  assert.equal(await rs.onDemandRetryAfter(s.w.db, s.gid, T0 + HOUR - 60000), 60);
  assert.equal(await rs.claimSyncLease(s.w.db, s.gid, T0 + HOUR, { onDemand: true }), true, 'exactly an hour later');
  assert.equal((await s.snap()).guild.next_sync_at, T0 + HOUR + 6 * HOUR, 'and the cron\'s next run moves with it');
  assert.equal(await rs.claimSyncLease(s.w.db, s.gid, T0 + HOUR + 6 * HOUR - 1), false, 'the cron sees the on-demand claim');
});

check('scheduler: the 15-minute run syncs only pinned guilds, in next_sync_at order, and a second run right after syncs nothing; unpinned and half-pinned guilds are skipped', async () => {
  const s = await scenario();
  const second = await extraGuild(s, 1, { pin: { slug: 'ember-two', guildId: 3001 } });
  const unpinned = await extraGuild(s, 2);
  const half = await extraGuild(s, 3, { pin: { slug: 'ember-half', guildId: 3002 }, partial: true });
  s.sql('UPDATE guilds SET next_sync_at = ? WHERE id = ?', T0 - 2 * HOUR, s.gid);
  s.sql('UPDATE guilds SET next_sync_at = ? WHERE id = ?', T0 - 5 * HOUR, second);
  const ids = { ember: 3000, 'ember-two': 3001 };
  s.net.roster = (call) => rosterBody(12, { guildId: ids[call.guildSlug] });
  const { sched } = await M();
  const deps = s.deps();
  // One guild per tick (SYNC_GUILDS_PER_RUN = 1, the Workers Free query limit): the longest-waiting first, the other next tick.
  await sched.runCron({ ...deps, cron: sched.FREQUENT_CRON });
  assert.deepEqual(s.net.calls.map((c) => c.guildSlug), ['ember-two'], 'the longest-waiting guild first');
  assert(s.logs.includes('roster sync: 1 guild attempted, 1 replaced, 0 unchanged, 0 not applied'), s.logs.join(' | '));
  await sched.runCron({ ...deps, cron: sched.FREQUENT_CRON });
  assert.deepEqual(s.net.calls.map((c) => c.guildSlug), ['ember-two', 'ember'], 'the other guild on the next tick');
  assert.deepEqual((await s.rows('SELECT guild_id, good FROM roster_syncs ORDER BY started_at, guild_id')).map((r) => r.good), [1, 1]);
  assert.equal((await s.rows('SELECT next_sync_at FROM guilds WHERE id = ?', unpinned))[0].next_sync_at, 0, 'unpinned: never leased');
  assert.equal((await s.rows('SELECT next_sync_at FROM guilds WHERE id = ?', half))[0].next_sync_at, 0, 'half-pinned: never leased');
  assert.equal(await s.w.count('roster_syncs', 'guild_id IN (?, ?)', unpinned, half), 0);
  // A third run (or a retried invocation) finds nothing due.
  s.net.calls.length = 0;
  await sched.runCron({ ...deps, cron: sched.FREQUENT_CRON });
  assert.equal(s.net.calls.length, 0);
  // Six hours later both are due again, one per tick.
  s.advance(6 * HOUR);
  await sched.runCron({ ...s.deps(), cron: sched.FREQUENT_CRON });
  await sched.runCron({ ...s.deps(), cron: sched.FREQUENT_CRON });
  assert.equal(s.net.calls.length, 2);
});

check('scheduler: a platform with no pinned guild logs and fetches nothing; the guild budget and the time budget cut a run short, the rest wait for the next tick', async () => {
  const { rs, sched } = await M();
  const none = await scenario({ pin: false });
  await sched.runCron({ ...none.deps(), cron: sched.FREQUENT_CRON });
  assert.deepEqual([none.net.calls.length, none.logs.filter((l) => /roster sync/.test(l))], [0, []]);

  const s = await scenario();
  const g2 = await extraGuild(s, 1, { pin: { slug: 'ember-two', guildId: 3001 } });
  const g3 = await extraGuild(s, 2, { pin: { slug: 'ember-three', guildId: 3002 } });
  s.sql('UPDATE guilds SET next_sync_at = ? WHERE id = ?', 1, s.gid);
  s.sql('UPDATE guilds SET next_sync_at = ? WHERE id = ?', 2, g2);
  s.sql('UPDATE guilds SET next_sync_at = ? WHERE id = ?', 3, g3);
  const ids = { ember: 3000, 'ember-two': 3001, 'ember-three': 3002 };
  s.net.roster = (call) => rosterBody(12, { guildId: ids[call.guildSlug] });
  const summary = await rs.runRosterSyncs(s.deps(), { guilds: 2 });
  assert.equal(summary.attempted, 2);
  assert.deepEqual(s.net.calls.map((c) => c.guildSlug), ['ember', 'ember-two'], 'the two longest-waiting');
  // Time budget: every fetch takes 30 s on the clock, the budget is 20 s: one guild per run.
  s.net.roster = async (call) => { s.w.clock.now += 30_000; return rosterBody(12, { guildId: ids[call.guildSlug] }); };
  s.net.calls.length = 0;
  const timed = await rs.runRosterSyncs(s.deps(), { guilds: 5, budgetMs: 20_000 });
  assert.equal(timed.attempted, 1);
  assert.deepEqual(s.net.calls.map((c) => c.guildSlug), ['ember-three'], 'the only one still due; the next tick takes the rest');
});

check('scheduler: the roster sync has its own try/catch (a failing run is logged and never thrown) and runs after the Discord half; an unknown cron is a no-op that logs', async () => {
  const { sched } = await M();
  const s = await scenario();
  const broken = new Proxy(s.w.db, { get(target, prop) { if (prop === 'prepare') return (sql) => { if (/FROM guilds WHERE next_sync_at/.test(sql)) throw new Error('boom'); return target.prepare(sql); }; const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; } });
  const result = await sched.runCron({ ...s.deps({ db: broken }), cron: sched.FREQUENT_CRON });
  assert(result && result.refresh && result.posts, 'the Discord half still reports');
  assert(s.logs.some((line) => line === 'roster sync run failed: boom'), s.logs.join(' | '));
  s.logs.length = 0;
  assert.equal(await sched.runCron({ ...s.deps(), cron: '1 2 3 4 5' }), null);
  assert.deepEqual(s.logs, ['scheduler: unknown cron "1 2 3 4 5" ignored']);
  assert.equal(s.net.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Routes

check('POST /roster-sync: only the Guild Master, POST only; a first click syncs, the second within the hour is 429 with Retry-After, an hour later it syncs again', async () => {
  const s = await scenario({ officer: true, member: true });
  const url = '/roster-sync';
  assert.equal((await s.w.call({}, 'POST', `${s.base}${url}`, {})).status, 401);
  assert.equal((await s.call('officer', 'POST', url, {})).status, 403);
  assert.equal((await s.call('member', 'POST', url, {})).status, 403);
  assert.equal(s.net.calls.length, 0, 'refused before any Blizzard call');
  assert.equal((await s.call('gm', 'PUT', url, {})).status, 405);
  assert.equal((await s.call('gm', 'DELETE', url, {})).status, 405);

  const first = await s.call('gm', 'POST', url, {});
  assert.equal(first.status, 200, first.text);
  assert.deepEqual([first.json.status, first.json.members, first.json.reason], ['applied', 12, null]);
  assert.equal(first.json.sync.rosterMembers, 12);
  assert.equal(first.json.sync.lastGood.syncId, first.json.syncId);
  const again = await s.call('gm', 'POST', url, {});
  assert.deepEqual([again.status, again.json.error], [429, 'sync_too_soon']);
  assert(Number(again.headers.get('Retry-After')) > 3000, `Retry-After ${again.headers.get('Retry-After')}`);
  assert.equal(s.net.calls.length, 1);
  s.advance(HOUR);
  const later = await s.call('gm', 'POST', url, {});
  assert.equal(later.status, 200, later.text);
  assert.equal(later.json.status, 'unchanged');
  assert.equal(s.net.calls.length, 2);
  // The cron lease moved with the on-demand claim.
  assert.equal((await s.snap()).guild.next_sync_at, T0 + HOUR + 6 * HOUR);
});

check('POST /roster-sync: an unpinned guild is 409 not_pinned, an unconfigured server 503; the failClosed per-account limit answers 429, and 503 when the limiter itself is down', async () => {
  const unpinned = await scenario({ pin: false });
  const res = await unpinned.call('gm', 'POST', '/roster-sync', {});
  assert.deepEqual([res.status, res.json.error], [409, 'not_pinned']);
  const bare = await scenario({ env: { BNET_CLIENT_ID: '' } });
  assert.deepEqual([(await bare.call('gm', 'POST', '/roster-sync', {})).status, (await bare.call('gm', 'POST', '/roster-sync', {})).json.error], [503, 'bnet_not_configured']);

  const s = await scenario();
  s.sql('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 6)', `rsync:${s.uids.gm}`, T0);
  const limited = await s.call('gm', 'POST', '/roster-sync', {});
  assert.deepEqual([limited.status, limited.json.error], [429, 'rate_limited']);
  assert.match(limited.json.message, /roster syncs/i);
  assert.equal(s.net.calls.length, 0);

  const t = await scenario();
  t.sql('DROP TABLE rate_limits');
  const down = await t.call('gm', 'POST', '/roster-sync', {});
  assert.deepEqual([down.status, down.json.error], [503, 'rate_limited'], 'failClosed: no limiter, no outbound fetch');
  assert.equal(t.net.calls.length, 0);
});

check('GET /roster-sync: the guild-edit permission reads last good sync, last attempt with its reason and the next sync; a member and a signed-out visitor do not; no names or hashes leave', async () => {
  const s = await scenario({ officer: true, member: true });
  const fresh = await s.call('officer', 'GET', '/roster-sync');
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual(fresh.json, { pinned: true, rankSource: null, nextSyncAt: 0, rosterMembers: 0, lastGood: null, lastAttempt: null });
  assert.equal((await s.call('member', 'GET', '/roster-sync')).status, 403);
  assert.equal((await s.w.call({}, 'GET', `${s.base}/roster-sync`)).status, 401);
  const done = await s.sync();
  s.advance(HOUR);
  s.net.roster = { status: 403 };
  const failed = await s.sync();
  const status = (await s.call('officer', 'GET', '/roster-sync')).json;
  assert.deepEqual(status.lastGood, { syncId: done.syncId, fetchedAt: T0, members: 12 });
  assert.deepEqual([status.lastAttempt.id, status.lastAttempt.good, status.lastAttempt.reason, status.lastAttempt.httpStatus], [failed.syncId, false, 'bnet_denied', 403]);
  assert.equal(status.rosterMembers, 12);
  const text = JSON.stringify(status);
  assert(!text.includes(nameOf(1)) && !/roster_hash|[0-9a-f]{64}/.test(text), 'no member names, no hash');
  assert.equal((await unpinnedStatus()).pinned, false);
  async function unpinnedStatus() { const u = await scenario({ pin: false }); return (await u.call('gm', 'GET', '/roster-sync')).json; }
});

// ---------------------------------------------------------------------------
// Pin-only target and the officer import

check('pinned target: a pinned guild\'s fetch reads only the pinned slugs and namespace - guild.name, the saved Battle.net name and guild.realm_slug are never used; a half pin is refused, not completed', async () => {
  const { imp } = await M();
  const s = await scenario({ officer: true, guildName: 'Zzz Display Name' });
  s.sql("UPDATE guilds SET bnet_guild_name = 'Typed Name', bnet_realm_slug = NULL WHERE id = ?", s.gid);
  // The sync and the officer preview both ask for /dreamscythe/ember.
  await s.sync();
  const team = s.tids[0];
  s.advance(HOUR);
  const preview = await s.call('officer', 'POST', '/roster/import/bnet/preview', { teamId: team });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(s.net.calls.map((c) => [c.realmSlug, c.guildSlug, c.namespace]), [['dreamscythe', 'ember', NS], ['dreamscythe', 'ember', NS]]);
  assert.equal(preview.json.guild.name, 'Ember', 'the name shown is the one Blizzard answered');
  // rosterTarget itself.
  const { pin } = await M();
  const guild = { game_version: 'tbc', region: 'US', realm_kind: 'realm', realm_slug: 'nightslayer', realm: 'Nightslayer', name: 'Zzz Display Name' };
  const settings = { guildName: 'Typed Name', realmSlug: null };
  const row = (over) => ({ rank_source: null, pinned_guild_slug: 'ember', pinned_realm_slug: 'dreamscythe', pinned_namespace: NS, blizzard_guild_id: 3000, blizzard_realm_id: 4001, ...over });
  const target = imp.rosterTarget(guild, settings, pin.pinOf(row({})));
  assert.deepEqual([target.realmSlug, target.guildSlug, target.guildName, target.pinned, target.support.namespace], ['dreamscythe', 'ember', null, true, NS]);
  assert.throws(() => imp.rosterTarget(guild, settings, pin.pinOf(row({ pinned_realm_slug: null }))), (e) => e.status === 409 && e.code === 'bnet_pin_incomplete');
  assert.throws(() => imp.rosterTarget(guild, settings, pin.pinOf(row({ pinned_namespace: 'profile-classicann-eu' }))), (e) => e.status === 409 && e.code === 'bnet_pin_mismatch');
  // Without any pin column the old rule holds (the saved name, else the guild name).
  const legacy = imp.rosterTarget(guild, settings, pin.pinOf(row({ pinned_guild_slug: null, pinned_realm_slug: null, pinned_namespace: null, blizzard_guild_id: null, blizzard_realm_id: null })));
  assert.deepEqual([legacy.realmSlug, legacy.guildSlug, legacy.pinned], ['nightslayer', 'typed-name', false]);
});

check('officer roster import: refused for an in-game guild (preview and commit, before any Blizzard call or rate-limit use); a manual guild and a legacy guild still import', async () => {
  const s = await scenario({ officer: true, rankSource: 'ingame' });
  const team = s.tids[0];
  for (const [route, body] of [['preview', { teamId: team }], ['commit', { teamId: team, defaultStatus: 'raider', members: [] }]]) {
    const res = await s.call('officer', 'POST', `/roster/import/bnet/${route}`, body);
    assert.deepEqual([res.status, res.json.error], [409, 'bnet_import_ingame'], route);
  }
  assert.equal(s.net.calls.length, 0);
  assert.equal(await s.w.count('rate_limits', "key LIKE 'imp:%'"), 0, 'refused before the import rate limit');
  s.sql("UPDATE guilds SET rank_source = 'manual' WHERE id = ?", s.gid);
  assert.equal((await s.call('officer', 'POST', '/roster/import/bnet/preview', { teamId: team })).status, 200);
  s.sql('UPDATE guilds SET rank_source = NULL WHERE id = ?', s.gid);
  s.advance(HOUR);
  assert.equal((await s.call('officer', 'POST', '/roster/import/bnet/preview', { teamId: team })).status, 200);
});

check('officer roster import: an unpinned legacy guild\'s commit stamps namespace + realm id + character id from the same fetch; a character already holding that identity under another name is refused; an invalid answer is refused', async () => {
  const s = await scenario({ officer: true, pin: false, realm: 'Nightslayer' });
  s.sql("UPDATE guilds SET bnet_guild_name = 'Ember' WHERE id = ?", s.gid);
  const here = (edit) => rosterBody(12, { realmId: 4002, realmSlug: 'nightslayer', edit });
  s.net.roster = here();
  const team = s.tids[0];
  const commit = (names) => s.call('officer', 'POST', '/roster/import/bnet/commit', { teamId: team, defaultStatus: 'raider', members: names.map((name) => ({ name, realmSlug: 'nightslayer' })) });
  // The identity key goes in with the character (lane B2): one atomic batch holds the INSERT that carries it, and no separate UPDATE follows.
  const batches = [];
  const prepared = [];
  const realBatch = s.w.db.batch.bind(s.w.db);
  const realPrepare = s.w.db.prepare.bind(s.w.db);
  s.w.db.batch = async (statements) => { batches.push(statements.map((statement) => statement.sql)); return realBatch(statements); };
  s.w.db.prepare = (sql) => { prepared.push(sql); return realPrepare(sql); };
  const done = await commit([nameOf(2), nameOf(3)]);
  s.w.db.batch = realBatch;
  s.w.db.prepare = realPrepare;
  assert.equal(done.status, 201, done.text);
  assert.equal(prepared.filter((sql) => /^\s*UPDATE characters\s+SET\s+namespace/i.test(sql)).length, 0, 'no separate identity UPDATE');
  assert.equal(batches.filter((statements) => statements.some((sql) => /INSERT INTO characters[^]*blizzard_char_id/.test(sql))).length, 1, 'the identity travels in the characters INSERT, in one batch');
  const rows = await s.rows('SELECT name, namespace, blizzard_realm_id, blizzard_char_id FROM characters WHERE guild_id = ? ORDER BY name', s.gid);
  assert.deepEqual(rows, [
    { name: nameOf(2), namespace: NS, blizzard_realm_id: 4002, blizzard_char_id: idOf(2) },
    { name: nameOf(3), namespace: NS, blizzard_realm_id: 4002, blizzard_char_id: idOf(3) },
  ]);
  // Member 2 is renamed in game; importing the new name would collide with the identity the first import stamped.
  s.advance(HOUR);
  s.net.roster = here((b) => { b.members[2].character.name = 'Rrenamed'; });
  const taken = await commit(['Rrenamed']);
  assert.deepEqual([taken.status, taken.json.error], [409, 'roster_identity_taken']);
  assert.equal(await s.w.count('characters'), 2, 'nothing was written');
  // An answer that is not GOOD is refused for the import too (the same rules; a null rank was a rank 0 before).
  s.advance(HOUR);
  s.net.roster = here((b) => { b.members[4].rank = null; });
  const bad = await s.call('officer', 'POST', '/roster/import/bnet/preview', { teamId: team });
  assert.deepEqual([bad.status, bad.json.error], [502, 'bnet_roster_invalid']);
});

// ---------------------------------------------------------------------------
// Retention

check('retention: roster_syncs older than 90 days go - except the row last_good_sync_id names; a hundred days of failed syncs leave the roster and the guild\'s access unchanged', async () => {
  const { rt } = await M();
  const s = await scenario();
  const good = await s.sync();
  s.sql('UPDATE roster_syncs SET started_at = ? WHERE id = ?', T0 - 100 * DAY, good.syncId);
  const insert = (id, ageDays, good = 0) => s.sql("INSERT INTO roster_syncs (id, guild_id, started_at, finished_at, good, http_status, reason, counts) VALUES (?, ?, ?, ?, ?, 403, 'bnet_denied', '{}')", id, s.gid, T0 - ageDays * DAY, T0 - ageDays * DAY, good);
  for (let d = 91; d <= 190; d++) insert(`rs_old_${d}`, d);
  insert('rs_89', 89);
  insert('rs_91_good', 91, 1);
  insert('rs_1', 1);
  const before = await s.snap();
  const deleted = await rt.runRetention({ db: s.w.db, now: () => T0, log: (l) => s.logs.push(l) });
  assert.equal(deleted.rosterSyncs, 100 + 1, '100 old failed rows and the 91-day-old good one; the named row stays');
  const left = (await s.rows('SELECT id FROM roster_syncs WHERE guild_id = ? ORDER BY id', s.gid)).map((r) => r.id);
  assert.deepEqual(left.sort(), [good.syncId, 'rs_1', 'rs_89'].sort());
  assert.deepEqual(await s.snap(), before, 'members, hash and pointers unchanged');
  assert.equal((await s.call('gm', 'GET', '')).status, 200, 'the Guild Master still has access');
  // When the guild moves on to a newer good sync the old named row is no longer protected.
  s.advance(6 * HOUR);
  s.net.roster = rosterBody(13);
  const newer = await s.sync();
  assert.equal((await rt.runRetention({ db: s.w.db, now: () => T0 + 6 * HOUR, log: () => {} })).rosterSyncs, 1);
  assert.equal(await s.w.count('roster_syncs', 'id = ?', good.syncId), 0);
  assert.equal(await s.w.count('roster_syncs', 'id = ?', newer.syncId), 1);
});

check('retention: rate_limits rows older than the longest window go and no *_WINDOW_MS the Worker passes to the limiter is longer than that', async () => {
  const { rt, rl } = await M();
  const s = await scenario();
  const put = (key, age) => s.sql('INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)', key, T0 - age);
  put('old', rl.LONGEST_WINDOW_MS + 1);
  put('edge', rl.LONGEST_WINDOW_MS);
  put('fresh', 1000);
  s.sql("DELETE FROM rate_limits WHERE key LIKE 'w:%'");
  const deleted = await rt.runRetention({ db: s.w.db, now: () => T0, log: () => {} });
  assert.equal(deleted.rateLimits, 1);
  assert.deepEqual((await s.rows('SELECT key FROM rate_limits ORDER BY key')).map((r) => r.key), ['edge', 'fresh']);
  // Every window a caller hands the limiter fits under LONGEST_WINDOW_MS (a longer one would lose its counter early).
  const files = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.js')) files.push(full); } };
  walk(path.join(ROOT, 'worker'));
  const sources = files.map((f) => fs.readFileSync(f, 'utf8'));
  const constants = new Map();
  for (const text of sources) for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*([0-9*\s]+);/g)) constants.set(m[1], Function(`return ${m[2]}`)());
  const used = new Set();
  for (const text of sources) for (const m of text.matchAll(/windowMs:\s*([A-Za-z0-9_]+)/g)) used.add(m[1]);
  assert(used.size >= 8, `found ${used.size} windows`);
  for (const name of used) {
    const value = /^\d+$/.test(name) ? Number(name) : constants.get(name);
    if (name === 'windowMs') continue; // the limiter's own parameter name
    assert(Number.isFinite(value), `could not resolve ${name}`);
    assert(value <= rl.LONGEST_WINDOW_MS, `${name} (${value}) is longer than LONGEST_WINDOW_MS`);
  }
});

check('retention: fresh_act_markers older than 15 minutes, consumed dry_run_approvals older than 30 days (and expired unused ones), oauth_state_nonces older than their 10-minute TTL', async () => {
  const { rt } = await M();
  const s = await scenario();
  const marker = (id, age) => s.sql("INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at) VALUES (?, 'h', 'claim', ?)", id, T0 - age);
  marker('m_old', 15 * 60000 + 1); marker('m_edge', 15 * 60000); marker('m_new', 14 * 60000);
  const approval = (hash, { used = null, expires }) => s.sql("INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at) VALUES (?, ?, ?, 'm', 'rs_x', ?, ?, ?)",
    hash, s.gid, s.uids.gm, T0 - 40 * DAY, expires, used);
  approval('a_used_old', { used: T0 - 31 * DAY, expires: T0 - 31 * DAY });
  approval('a_used_recent', { used: T0 - 29 * DAY, expires: T0 - 29 * DAY });
  approval('a_unused_dead', { expires: T0 - 31 * DAY });
  approval('a_unused_live', { expires: T0 + 600000 });
  const nonce = (hash, age) => s.sql('INSERT INTO oauth_state_nonces (nonce_hash, created_at, used_at) VALUES (?, ?, NULL)', hash, T0 - age);
  nonce('n_old', 10 * 60000 + 1); nonce('n_edge', 10 * 60000); nonce('n_new', 9 * 60000);
  const deleted = await rt.runRetention({ db: s.w.db, now: () => T0, log: () => {} });
  assert.deepEqual([deleted.freshActMarkers, deleted.dryRunApprovals, deleted.oauthStateNonces], [1, 2, 1]);
  assert.deepEqual((await s.rows('SELECT act_id FROM fresh_act_markers ORDER BY act_id')).map((r) => r.act_id), ['m_edge', 'm_new']);
  assert.deepEqual((await s.rows('SELECT token_hash FROM dry_run_approvals ORDER BY token_hash')).map((r) => r.token_hash), ['a_unused_live', 'a_used_recent']);
  assert.deepEqual((await s.rows('SELECT nonce_hash FROM oauth_state_nonces ORDER BY nonce_hash')).map((r) => r.nonce_hash), ['n_edge', 'n_new']);
});

check('retention: the daily cron runs the jobs, one failing rule does not stop the others and is logged; bnet-purge and the daily run never delete guild_roster', async () => {
  const { sched, rt } = await M();
  const s = await scenario();
  await s.sync();
  s.sql("INSERT INTO fresh_act_markers (act_id, session_token_hash, purpose, at) VALUES ('m_old', 'h', 'claim', ?)", T0 - DAY);
  s.sql("INSERT INTO oauth_state_nonces (nonce_hash, created_at) VALUES ('n_old', ?)", T0 - DAY);
  const bnetPurge = await load('worker/bnet-purge.js');
  await bnetPurge.purgeExpiredBnetData(s.w.db, T0 + 400 * DAY);
  assert.equal((await s.snap()).roster.length, 12, 'bnet-purge keeps guild_roster');
  await sched.runCron({ ...s.deps(), cron: sched.DAILY_CRON });
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  assert.equal(await s.w.count('oauth_state_nonces'), 0);
  assert.equal((await s.snap()).roster.length, 12, 'the daily run keeps guild_roster');
  // A rule whose table is gone fails alone.
  s.sql("INSERT INTO oauth_state_nonces (nonce_hash, created_at) VALUES ('n_old', ?)", T0 - DAY);
  s.sql('DROP TABLE fresh_act_markers');
  s.logs.length = 0;
  const deleted = await rt.runRetention({ db: s.w.db, now: () => T0, log: (l) => s.logs.push(l) });
  assert.deepEqual([deleted.freshActMarkers, deleted.oauthStateNonces], [null, 1]);
  assert(s.logs.some((l) => /^retention: freshActMarkers failed/.test(l)));
});

check('ids: roster sync attempts get rs_ ids; the 0031 columns the sync writes exist', async () => {
  const { bn } = await M();
  const ids = await load('worker/ids.js');
  const id = ids.newId('rs', (n) => new Uint8Array(n).fill(7));
  assert(ids.isId('rs', id));
  assert(typeof bn.ROSTER_FETCH_LIMIT === 'number' && bn.ROSTER_FETCH_LIMIT === 1200);
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  let passed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String((error && error.stack) || error).split('\n').slice(0, 10).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
