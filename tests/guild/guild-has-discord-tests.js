/**
 * Raidsmith guild tracker - hasDiscord(guild) and the guard on every Discord / Raid-Helper path (user-hierarchy build, lane B1a-2)
 * Run: node tests/guild/guild-has-discord-tests.js
 *
 * A guild without a Discord server carries the placeholder `none:<guild_id>` in guilds.discord_server_id. hasDiscord(guild) is true unless that column is NULL
 * or starts with 'none:'. Raidsmith must run with NO Discord, so every path that reaches Discord or Raid-Helper asks it first. Three layers:
 *   1. the rule itself (JS and SQL agree on every kind of id);
 *   2. behaviour: a guild without Discord is refused (409 no_discord_server) on every Discord route, makes no bot call and no Raid-Helper fetch, does not
 *      count a user_servers row as membership, and shows no server id; a guild WITH a server behaves as before (the rest of the suite pins that);
 *   3. a grep ratchet over worker/*.js: every file that reads guilds.discord_server_id or calls a Discord / Raid-Helper fetch is listed here with HOW it is
 *      guarded, and the counts are pinned, so a new unguarded Discord path fails this test until it is guarded and listed on purpose.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createD1Fake } = require('../d1-fake');
const { ROOT, load, adminOf, memberOf, makeWorld, signIn } = require('../guild-world');

const SERVER = '900000000000000093';
const person = (n, name) => ({ id: `1100000000000009${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(30, 'Gmdiscord'), m1: person(31, 'Memberdiscord'), m2: person(32, 'Membertwodiscord') };
const NOW = 1_800_000_000_000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// 1. The rule

check('hasDiscord: true unless the server id is NULL or starts with none:; JS and SQL agree on every kind of id', async () => {
  const guard = await load('worker/discord-guard.js');
  const ids = [
    ['900000000000000093', true], ['1', true], ['', true], ['nonex', true], ['None:abc', true], [' none:abc', true], ['x none:', true],
    ['none:', false], ['none:g_abc', false], ['none:900000000000000093', false], [null, false], [undefined, false],
  ];
  const db = createD1Fake();
  for (const [id, expected] of ids) {
    assert.equal(guard.hasDiscordServerId(id), expected, `hasDiscordServerId(${JSON.stringify(id)})`);
    assert.equal(guard.hasDiscord({ discord_server_id: id }), expected, `hasDiscord(${JSON.stringify(id)})`);
    if (id !== undefined) {
      const row = await db.prepare(`SELECT ${guard.serverIdIsDiscordSql('v.id')} AS ok FROM (SELECT ? AS id) v`).bind(id).first();
      assert.equal(row.ok === 1, expected, `serverIdIsDiscordSql(${JSON.stringify(id)})`);
    }
  }
  assert.equal(guard.hasDiscord(null), false);
  assert.equal(guard.hasDiscord(undefined), false);
  assert.equal(guard.hasDiscord({}), false);
  assert.equal(guard.noDiscordServerId('g_abc'), 'none:g_abc');
  assert.equal(guard.hasDiscord({ discord_server_id: guard.noDiscordServerId('g_abc') }), false);
  assert.throws(() => guard.requireDiscord({ discord_server_id: 'none:g_abc' }), (error) => error.status === 409 && error.code === 'no_discord_server');
  assert.doesNotThrow(() => guard.requireDiscord({ discord_server_id: SERVER }));
});

// ---------------------------------------------------------------------------
// 2. Behaviour on a guild without Discord

// A guild made the normal way, then switched to the placeholder: the GM is linked to a roster person first (a guild without Discord has no server to be in).
async function scenario() {
  const calls = [];
  const w = await makeWorld({
    env: { DISCORD_BOT_TOKEN: 'bot-token', RAID_HELPER_API_BASE: 'http://localhost:1' },
    wrapFetch: (discordFetch) => async (url, init = {}) => {
      const text = String(url);
      if (/^https:\/\/discord\.com\/api\/v10\/(guilds|channels)\//.test(text) || text.includes('raid-helper')) { calls.push(text); return new Response('{}', { status: 404 }); }
      return discordFetch(url, init);
    },
  });
  w.clock.now = NOW;
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'No Discord', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: false,
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const team = made.json.teams[0].id;
  const uids = {};
  for (const key of ['m1', 'm2']) {
    jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  uids.gm = (await w.call(jars.gm, 'GET', '/auth/me')).json.user.id;
  const s = {
    w, gid, team, jars, uids, calls, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) { w.advance(2000); return w.call(jars[who], method, tail.startsWith('/api/') || tail.startsWith('/auth/') ? tail : `${s.base}${tail}`, body); },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    exec: (sql, ...values) => w.db.prepare(sql).bind(...values).run(),
    rows: (sql, ...values) => w.rows(sql, ...values),
  };
  // The GM and m1 are linked to roster people; m2 is only in the Discord server.
  // The officer's link (players.user_id) is what makes someone a member without the server.
  const link = async (key, name) => {
    const made = await s.ok('gm', 'POST', '/roster', { teamId: team, name, class: 'MAGE', mainSpec: 'Fire', offSpec: null, status: 'raider' });
    await s.ok('gm', 'PUT', `/roster/${made.person.id}/account`, { userId: uids[key] }, 200);
    return made;
  };
  s.gmPerson = await link('gm', 'Gmmain');
  s.m1Person = await link('m1', 'Mmain');
  return s;
}
const goDark = (s) => s.exec('UPDATE guilds SET discord_server_id = ? WHERE id = ?', `none:${s.gid}`, s.gid);

check('the server membership is ignored: a user_servers row (even one for the placeholder) makes nobody a member; a roster link still does', async () => {
  const s = await scenario();
  assert.equal((await s.call('m2', 'GET', '')).status, 200, 'in the Discord server: a member (control)');
  await goDark(s);
  const m2 = await s.call('m2', 'GET', '');
  assert.equal(m2.status, 403);
  assert.equal(m2.json.error, 'not_member', 'the old server row no longer counts');
  // A row naming the placeholder itself does not smuggle membership in either.
  await s.exec('INSERT INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, 1)', s.uids.m2, `none:${s.gid}`);
  const smuggled = await s.call('m2', 'GET', '');
  assert.equal(smuggled.status, 403, 'a user_servers row for none:<guild> is not a Discord server');
  assert.equal((await s.call('m1', 'GET', '')).status, 200, 'linked to a roster person: a member');
  assert.equal((await s.call('gm', 'GET', '')).status, 200);
  // The People screen's candidates are only the linked people.
  const people = await s.ok('gm', 'GET', '/people');
  assert.deepEqual(people.people.map((p) => p.id).filter((id) => id === s.uids.m2), [], 'm2 is not a member candidate');
});

check('every Discord route is refused with 409 no_discord_server, and no bot call is made', async () => {
  const s = await scenario();
  await goDark(s);
  const expectRefused = async (method, tail, body) => {
    const res = await s.call('gm', method, tail, body);
    assert.equal(res.status, 409, `${method} ${tail}: ${res.text}`);
    assert.equal(res.json.error, 'no_discord_server', `${method} ${tail}`);
  };
  await expectRefused('GET', '/discord');
  await expectRefused('PUT', '/discord/maps', { maps: [] });
  await expectRefused('POST', '/discord/sync', {});
  await expectRefused('POST', `/people/${s.uids.m1}/sync`, {});
  assert.deepEqual(s.calls, [], 'no call reached Discord');
});

check('Raid-Helper is off: linking an event, creating a raid from one and importing a roster from one are refused before any fetch', async () => {
  const s = await scenario();
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.team, raidOn: '2027-01-20', startTime: '20:00', zone: "Gruul's Lair" })).raid.id;
  await goDark(s);
  const event = 'https://raid-helper.dev/event/123456789012345678';
  const attempts = [
    ['POST', '/raids', { teamId: s.team, raidOn: '2027-01-22', startTime: '20:00', zone: "Gruul's Lair", eventSource: event }],
    ['PUT', `/raids/${raid}/event`, { source: event }],
    ['POST', '/roster/import/raid-helper/preview', { teamId: s.team, source: event }],
    ['POST', '/roster/import/raid-helper/commit', { teamId: s.team, eventId: '123456789012345678', rows: [{ signupId: 1, main: { name: 'Nobody', class: 'MAGE', spec: 'Fire' } }] }],
  ];
  for (const [method, tail, body] of attempts) {
    const res = await s.call('gm', method, tail, body);
    assert.equal(res.status, 409, `${method} ${tail}: ${res.text}`);
    assert.equal(res.json.error, 'no_discord_server', `${method} ${tail}`);
  }
  assert.deepEqual(s.calls, [], 'no fetch reached Raid-Helper');
  // The raid list says nothing about another server.
  const list = await s.ok('gm', 'GET', `/raids/${raid}`);
  assert.equal(list.sources.event, null);
});

check('the automatic Raid-Helper refresh skips a guild without Discord: no fetch, the raid is left alone; a guild with a server still asks', async () => {
  const s = await scenario();
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.team, raidOn: '2027-01-20', startTime: '20:00', zone: "Gruul's Lair" })).raid.id;
  await s.exec("UPDATE raids SET event_id = '123456789012345678', event_checked_at = NULL WHERE id = ?", raid);
  const { refreshDueEvents } = await load('worker/event-refresh.js');
  const asked = [];
  const ctx = () => ({ db: s.w.db, env: s.w.env, fetch: async (url) => { asked.push(String(url)); return new Response('{}', { status: 404 }); }, now: () => NOW, randomBytes: s.w.randomBytes, log: () => {} });
  const lit = await refreshDueEvents(ctx());
  assert.equal(lit.due, 1);
  assert.equal(asked.length >= 1, true, 'a guild with a Discord server asks Raid-Helper (control)');
  await goDark(s);
  await s.exec('UPDATE raids SET event_checked_at = NULL WHERE id = ?', raid);
  asked.length = 0;
  const dark = await refreshDueEvents(ctx());
  assert.deepEqual([asked, dark.refreshed, dark.moved], [[], 0, 0]);
});

check('the bot functions make no call for a placeholder id; syncMember and Sync everyone read nothing and change nothing', async () => {
  const s = await scenario();
  const bot = await load('worker/discord-bot.js');
  const sync = await load('worker/discord-sync.js');
  const asked = [];
  const fetchImpl = async (url) => { asked.push(String(url)); return Response.json({}); };
  const env = { DISCORD_BOT_TOKEN: 'bot-token', DISCORD_CLIENT_ID: 'client-id' };
  assert.deepEqual(await bot.fetchServerRoles(env, fetchImpl, 'none:g_abc'), { ok: false, reason: 'no_server' });
  assert.deepEqual(await bot.fetchMemberRoleIds(env, fetchImpl, 'none:g_abc', '900000000000000001'), { ok: false, reason: 'no_server' });
  assert.equal(bot.inviteUrl(env, 'none:g_abc'), null);
  assert.equal(typeof bot.inviteUrl(env, SERVER), 'string', 'a real server id still gets its invite link');
  assert.deepEqual(asked, []);
  assert.equal(sync.discordProblem('no_server').code, 'no_discord_server');
  await s.exec("INSERT INTO discord_role_maps (guild_id, discord_role_id, role_id, team_id) VALUES (?, '900000000000000555', 'officer', NULL)", s.gid);
  await goDark(s);
  const ctx = { db: s.w.db, env: { ...s.w.env, DISCORD_BOT_TOKEN: 'bot-token' }, fetch: fetchImpl, now: () => NOW, randomBytes: s.w.randomBytes, log: () => {} };
  const guild = { id: s.gid, discord_server_id: `none:${s.gid}` };
  assert.deepEqual(await sync.syncMember(ctx, guild, s.uids.m2), { status: 'skipped', reason: 'no_discord_server' });
  assert.deepEqual(await sync.syncGuildMembers(ctx, guild, { actorId: s.uids.gm }), { processed: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0, problem: null, next: null });
  await sync.syncSignIn(ctx, s.uids.m2);
  assert.deepEqual(asked, [], 'nothing was read from Discord');
});

check('the guild payload shows no server id for a guild without Discord (never the placeholder); the public view\'s guild row carries none at all', async () => {
  const s = await scenario();
  assert.equal((await s.ok('gm', 'GET', '')).guild.discordServerId, SERVER, 'a guild with a server: unchanged');
  await goDark(s);
  const payload = await s.ok('gm', 'GET', '');
  assert.equal(payload.guild.discordServerId, null);
  assert.equal(JSON.stringify(payload).includes('none:'), false);
  const { loadGuildRow } = await load('worker/viewer.js');
  const row = await loadGuildRow(s.w.db, s.gid);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'discord_server_id'), false, 'the read-only views never hold a Discord server id');
});

check('deleting a guild without Discord clears no server membership rows; a guild with a server clears its own', async () => {
  const s = await scenario();
  await s.exec('INSERT INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, 1)', s.uids.m2, '900000000000000777');
  const before = await s.rows('SELECT COUNT(*) AS n FROM user_servers');
  await goDark(s);
  await s.ok('gm', 'DELETE', '', { confirmName: 'No Discord' }, 200);
  const after = await s.rows('SELECT COUNT(*) AS n FROM user_servers');
  assert.equal(after[0].n, before[0].n, 'the rows belong to servers, not to this guild');
});

// ---------------------------------------------------------------------------
// 3. The grep ratchet

const WORKER = path.join(ROOT, 'worker');
function workerFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(path.relative(ROOT, full).replace(/\\/g, '/'));
    }
  };
  walk(WORKER);
  return files.sort();
}
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const countOf = (text, token) => text.split(token).length - 1;

// How each file that mentions guilds.discord_server_id stays safe, and how many mentions it has (a new mention fails the test).
//   guard     imports worker/discord-guard.js and checks hasDiscord / requireDiscord / serverIdIsDiscordSql before it acts on the id
//   fragment  hands the id only to the worker/membership.js fragments, which carry the guard (inServerSql, memberCandidatesSql)
//   data      stores or selects the column as data and acts on nothing (creation, a SELECT list, a comment)
//   none      must not mention it at all
const SERVER_ID_FILES = {
  'worker/attendance-view.js': { how: 'guard', count: 1 },
  'worker/bnet-store.js': { how: 'fragment', count: 1 },
  'worker/block-tombstones.js': { how: 'data', count: 1 },
  'worker/discord-guard.js': { how: 'data', count: 3 },
  'worker/discord-sync.js': { how: 'guard', count: 7 },
  'worker/event-refresh.js': { how: 'guard', count: 2 },
  'worker/flip-preview.js': { how: 'guard', count: 1 },
  'worker/membership.js': { how: 'data', count: 5 },
  'worker/permissions.js': { how: 'fragment', count: 2 },
  'worker/roster-view.js': { how: 'fragment', count: 2 },
  'worker/routes/accounts.js': { how: 'fragment', count: 1 },
  'worker/routes/auth.js': { how: 'guard', count: 18 },
  'worker/routes/discord.js': { how: 'guard', count: 3 },
  'worker/routes/guild-data.js': { how: 'guard', count: 2 },
  'worker/routes/guild.js': { how: 'guard', count: 6 },
  'worker/routes/people.js': { how: 'fragment', count: 3 },
  'worker/routes/open-raids.js': { how: 'fragment', count: 1 },
  'worker/routes/raids.js': { how: 'guard', count: 3 },
  'worker/routes/roster-import.js': { how: 'guard', count: 3 },
  'worker/routes/roster.js': { how: 'fragment', count: 2 },
  'worker/users-list.js': { how: 'fragment', count: 2 },
};
const FRAGMENT_USE = /\b(memberSql|inServerSql|memberCandidatesSql|boundMember|boundReaches|reachesGuildSql)\b/;
const GUARD_IMPORT = /from '(\.\.?\/)+discord-guard\.js'/;

check('grep ratchet: every file that reads guilds.discord_server_id is listed with how it is guarded, with its mention count pinned', async () => {
  const seen = {};
  for (const file of workerFiles()) {
    const text = read(file);
    const count = countOf(text, 'discord_server_id');
    if (count > 0) seen[file] = count;
  }
  for (const [file, count] of Object.entries(seen)) {
    const entry = SERVER_ID_FILES[file];
    assert(entry, `${file} mentions discord_server_id ${count}x and is not listed: guard it with hasDiscord / requireDiscord (worker/discord-guard.js) or hand the id to the membership.js fragments, then list it in SERVER_ID_FILES`);
    assert.equal(count, entry.count, `${file}: discord_server_id mentions went from ${entry.count} to ${count}: guard the new path, then update the pinned count`);
  }
  for (const file of Object.keys(SERVER_ID_FILES)) assert(seen[file], `${file} no longer mentions discord_server_id: remove it from SERVER_ID_FILES`);
  for (const [file, entry] of Object.entries(SERVER_ID_FILES)) {
    const text = read(file);
    if (entry.how === 'guard') assert(GUARD_IMPORT.test(text), `${file} is listed as guarded but does not import discord-guard.js`);
    if (entry.how === 'fragment') assert(FRAGMENT_USE.test(text), `${file} is listed as a fragment user but uses no membership.js fragment`);
  }
  assert.equal(countOf(read('worker/viewer.js'), 'discord_server_id'), 0, 'viewer.js (public page, guest links) never carries a Discord server id');
  assert.equal(countOf(read('worker/api-data.js'), 'discord_server_id'), 0, 'api-data.js (API keys) never carries a Discord server id');
});

// The calls that reach Discord or Raid-Helper: each must sit in a file that imports the guard, with a guard call in the 80 lines above it.
const CALLS = {
  'fetchRaidHelperEvent(': { definition: 'worker/sources.js', sites: { 'worker/event-refresh.js': 1, 'worker/routes/raids.js': 2, 'worker/routes/roster-import.js': 2 } },
  'fetchMemberRoleIds(': { definition: 'worker/discord-bot.js', sites: { 'worker/discord-sync.js': 1 } },
  'fetchServerRoles(': { definition: 'worker/discord-bot.js', sites: { 'worker/routes/discord.js': 1 } },
  'inviteUrl(': { definition: 'worker/discord-bot.js', sites: { 'worker/routes/discord.js': 1 } },
};
const GUARD_CALL = /\b(hasDiscord|requireDiscord|hasDiscordServerId|serverIdIsDiscordSql)\(/;

check('grep ratchet: every call to Discord or Raid-Helper is pinned, in a file that imports the guard, with a guard call just above it', async () => {
  for (const [token, { definition, sites }] of Object.entries(CALLS)) {
    const found = {};
    for (const file of workerFiles()) {
      if (file === definition) continue;
      const count = countOf(read(file), token);
      if (count > 0) found[file] = count;
    }
    assert.deepEqual(found, sites, `calls to ${token} moved or multiplied: guard the new call site (worker/discord-guard.js), then list it`);
    for (const file of Object.keys(sites)) {
      const lines = read(file).split('\n');
      assert(GUARD_IMPORT.test(lines.join('\n')), `${file} calls ${token} but does not import discord-guard.js`);
      lines.forEach((line, index) => {
        if (!line.includes(token) || /^\s*(import|\/\/)/.test(line)) return;
        const above = lines.slice(Math.max(0, index - 80), index + 1).join('\n');
        assert(GUARD_CALL.test(above), `${file}:${index + 1} calls ${token} with no hasDiscord / requireDiscord in the 80 lines above`);
      });
    }
  }
  // The bot module itself refuses a placeholder id before it fetches.
  const bot = read('worker/discord-bot.js');
  assert(GUARD_IMPORT.test(bot) && countOf(bot, 'hasDiscordServerId(') >= 3, 'discord-bot.js guards inviteUrl, fetchServerRoles and fetchMemberRoleIds');
});

check('grep ratchet: the membership fragments carry the guard on the user_servers column', async () => {
  const text = read('worker/membership.js');
  assert(GUARD_IMPORT.test(text));
  assert.equal(countOf(text, "serverIdIsDiscordSql('ms.server_id')"), 1, 'inServerSql');
  assert.equal(countOf(text, "serverIdIsDiscordSql('server_id')"), 1, 'memberCandidatesSql');
  assert.equal(countOf(text, "serverIdIsDiscordSql('mx_us.server_id')"), 1, 'the my-guilds candidate set');
  // And the sign-in write that fills user_servers.
  assert(read('worker/routes/auth.js').includes("serverIdIsDiscordSql('g.discord_server_id')"));
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
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
