/**
 * Raidsmith guild tracker - PM wave 8 Worker tests (WoW Forever launch readiness: two-part character names, raid duties and the log nudge, the Launch funnel,
 * guest sign-up links, a pasted raid roster).
 * Run: node tests/guild/guild-wave8-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/guild-world.js) with a fixed clock. Discord webhooks and Warcraft Logs are faked by an injected
 * fetch that RECORDS what the Worker posts or answers: nothing touches the network. The pure rules (names, the pasted-roster parser, the funnel) are pinned
 * directly; the routes and the SQL run over HTTP.
 */
const assert = require('node:assert/strict');
const { ownPerson } = require('../guild-owner-fixture');
const { load, adminOf, memberOf, makeWorld, signIn, newJar } = require('../guild-world');

const SERVER = '900000000000000081';
const person = (n, name) => ({ id: `1100000000000008${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(1, 'Gmeight'), m1: person(3, 'Memberone'), m2: person(4, 'Membertwo') };
const NOW = 1_800_000_000_000; // 2027-01-15T08:00Z (Friday 03:00 in New York)
const HOUR = 3600000;
const DAY = 24 * HOUR;
const TZ = 'America/New_York';
const HOOK = 'https://discord.com/api/webhooks/987654321098765432/abcdefghijklmnopqrstuvwxyz0123456789ABCDE';
const WCL = { id: 'wcl-id', secret: 'wcl-secret' };
const CRON = '*/15 * * * *';
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const filter = process.argv[2] || '';

// A Warcraft Logs report as the GraphQL answers it. actors: [id, name, subType]; fights: [id, name, encounterID, kill, startOffset, seconds, [actor ids]].
function wclReport({ startTime, actors, fights }) {
  return {
    startTime, endTime: startTime + 4 * HOUR, zone: { name: 'Gruul' }, owner: { name: 'Uploader' },
    fights: fights.map(([id, name, encounterID, kill, start, seconds, friendlyPlayers]) => ({ id, name, encounterID, kill, startTime: start, endTime: start + seconds * 1000, friendlyPlayers })),
    masterData: { actors: actors.map(([id, name, subType]) => ({ id, name, subType, server: 'Nightslayer' })) },
  };
}

// A guild of the given game version with a Guild Master, members (signed in) and one team "Alpha", over a fetch that records webhook posts and answers WCL.
async function scenario({ version = 'tbc', members = [], teams = 1 } = {}) {
  const net = { posts: [], reports: new Map(), tokens: new Set() };
  const w = await makeWorld({
    env: { WCL_CLIENT_ID: WCL.id, WCL_CLIENT_SECRET: WCL.secret },
    wrapFetch: (discordFetch) => async (url, init = {}) => {
      const text = String(url);
      if (text.startsWith('https://discord.com/api/webhooks/')) {
        net.posts.push({ url: text, body: JSON.parse(init.body), at: w.clock.now });
        return new Response(null, { status: 204 });
      }
      const wcl = /^https:\/\/(www|classic|fresh)\.warcraftlogs\.com(\/.*)$/.exec(text);
      if (wcl) {
        if (wcl[2] === '/oauth/token') {
          net.tokens.add('tok');
          return Response.json({ access_token: 'tok', expires_in: 3600 });
        }
        const payload = JSON.parse(init.body);
        const report = net.reports.has(payload.variables.code) ? net.reports.get(payload.variables.code) : null;
        return Response.json({ data: { reportData: { report } } });
      }
      return discordFetch(url, init);
    },
  });
  w.clock.now = NOW;
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Wave Eight', gameVersion: version, region: 'US', ...(version === 'forever' ? { realm: 'Normal' } : { realm: 'Nightslayer' }), timeZone: TZ,
    multipleTeams: teams > 1, ...(teams > 1 ? { teamNames: ['Alpha', 'Bravo'] } : {}),
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  if (teams === 1) assert.equal((await w.call(jars.gm, 'PATCH', `/api/guild/${gid}/teams/${tids[0]}`, { name: 'Alpha' })).status, 200);
  const uids = {};
  for (const key of members) {
    jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  const s = {
    w, net, gid, tids, tid: tids[0], jars, uids, base: `/api/guild/${gid}`, version, lines: [],
    async call(who, method, tail, body) { w.advance(STEP); return w.call(jars[who], method, `${s.base}${tail}`, body); },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    exec: (sql, ...values) => w.db.prepare(sql).bind(...values).run(),
    async person(name, { team = tids[0], cls = 'WARRIOR', status = 'raider', link = null, spec = null } = {}) {
      const specs = { WARRIOR: 'Arms', MAGE: 'Fire', PRIEST: 'Holy', ROGUE: 'Combat', DRUID: 'Restoration' };
      const res = await s.ok('gm', 'POST', '/roster', { teamId: team, name, class: cls, mainSpec: spec || specs[cls], offSpec: null, status, joinedOn: '2026-09-01', ...(link ? { linkUserId: uids[link] } : {}) });
      if (link) ownPerson(w.db.sqlite, res.person.id, uids[link]); // the account owns it (players.user_id): linkUserId only records the Discord ID since the identity split
      return { pid: res.person.id, cid: res.characters[0].id };
    },
    // A raid on a guild-local date and time, made through the API.
    async raid(raidOn, { team = tids[0], startTime = '20:00', zone = version === 'forever' ? 'Barrow Deeps' : "Gruul's Lair", title } = {}) {
      const res = await s.ok('gm', 'POST', '/raids', { teamId: team, raidOn, startTime, zone, ...(title ? { title } : {}) });
      return res.raid.id;
    },
    async audits(action) { return s.rows('SELECT actor_user_id, entity_type, entity_id, before, after FROM audit_log WHERE guild_id = ? AND action = ? ORDER BY created_at, id', gid, action); },
    async run(cron = CRON) {
      const { runCron } = await load('worker/scheduler.js');
      const { defaultRandomBytes } = await load('worker/ids.js');
      return runCron({ cron, db: w.db, env: w.env, fetch: w.fetch, now: () => w.clock.now, randomBytes: defaultRandomBytes, log: (line) => s.lines.push(line) });
    },
    async notify(patch, team = tids[0]) { return s.ok('gm', 'PUT', `/teams/${team}/notifications`, patch); },
  };
  return s;
}

// ===========================================================================
// 1. Two-part character names

check('names: a Forever name is one or two words of 2 to 12 letters, one space; every other version is one word as before', async () => {
  const { cleanCharacterName, nameKey, allowsSurname } = await load('worker/roster-data.js');
  assert.equal(allowsSurname('forever'), true);
  for (const version of ['tbc', 'classic', undefined]) assert.equal(allowsSurname(version), false);
  assert.equal(cleanCharacterName('thrall stormrage', 'forever'), 'Thrall Stormrage');
  assert.equal(cleanCharacterName('  THRALL   Stormrage ', 'forever'), 'Thrall Stormrage', 'runs of spaces are one space');
  assert.equal(cleanCharacterName('Thrall', 'forever'), 'Thrall', 'a Forever character may have no surname');
  assert.equal(cleanCharacterName('Thrall Stormrage Jr', 'forever'), null, 'three words are not a name');
  assert.equal(cleanCharacterName('A Stormrage', 'forever'), null, 'each word is 2 to 12 letters');
  assert.equal(cleanCharacterName('Thrall Stormragexyzabc', 'forever'), null);
  assert.equal(cleanCharacterName('Thrall Storm1', 'forever'), null);
  assert.equal(cleanCharacterName('Thr-all Stormrage', 'forever'), null);
  assert.equal(cleanCharacterName('Thrall Stormrage', 'tbc'), null, 'TBC: one word');
  assert.equal(cleanCharacterName('Thrall Stormrage'), null, 'no version: one word');
  assert.equal(cleanCharacterName('Thrall', 'tbc'), 'Thrall');
  assert.equal(cleanCharacterName('térra', 'tbc'), 'Térra');
  assert.equal(nameKey('Thrall Stormrage'), 'thrall stormrage', 'the key is the lower-cased full name, with the space');
  // The Planner's name for a sign-up: a Discord nickname that is the first word of an Alt's name picks that Alt (after the full-name match).
  const { plannerName } = await load('worker/signups-data.js');
  const characters = [
    { name: 'Thrall Stormrage', class: 'SHAMAN', is_main: 1 }, { name: 'Jaina Proudmoore', class: 'MAGE', is_main: 0 }, { name: 'Aaron Zed', class: 'MAGE', is_main: 0 },
  ];
  const mage = { class_name: 'Mage', spec_name: 'Fire' };
  assert.equal(plannerName({ nickname: 'Jaina', ...mage }, characters), 'Jaina Proudmoore');
  assert.equal(plannerName({ nickname: 'jaina proudmoore', ...mage }, characters), 'Jaina Proudmoore');
  assert.equal(plannerName({ nickname: 'Someone', ...mage }, characters), 'Aaron Zed', 'no match: the first Alt of the class by name, as before');
});

check('names: a one-word name resolves to the one character with that first word - after the full name; two candidates leave it alone', async () => {
  const { loadSurnameIndex, resolveName } = await load('worker/name-resolve.js');
  const s = await scenario({ version: 'forever' });
  await s.person('Thrall Stormrage');
  await s.person('Jaina Proudmoore', { cls: 'MAGE' });
  await s.person('Jaina Windrunner', { cls: 'MAGE' });
  await s.person('Arthas', { cls: 'PRIEST' });
  await s.person('Arthas Menethil', { cls: 'PRIEST' });
  const guild = { id: s.gid, game_version: 'forever' };
  const index = await loadSurnameIndex(s.w.db, guild);
  assert.equal(resolveName(index, 'Thrall', ''), 'Thrall Stormrage');
  assert.equal(resolveName(index, 'thrall', ''), 'Thrall Stormrage');
  assert.equal(resolveName(index, 'Jaina', ''), 'Jaina', 'two Jainas: ambiguous, left as it is');
  assert.equal(resolveName(index, 'Arthas', ''), 'Arthas', 'the full name comes first: a character that is just Arthas wins');
  assert.equal(resolveName(index, 'Thrall Stormrage', ''), 'Thrall Stormrage');
  assert.equal(resolveName(index, 'Nobody', ''), 'Nobody');
  assert.equal(resolveName(index, 'Thrall', 'otherrealm'), 'Thrall', 'another realm key is another character');
  assert.equal(resolveName(null, 'Thrall', ''), 'Thrall', 'no index: unchanged');
  const tbc = await scenario({ version: 'tbc' });
  assert.equal(await loadSurnameIndex(tbc.w.db, { id: tbc.gid, game_version: 'tbc' }), null, 'a TBC guild has no index at all');
});

check('names: the roster takes a surname on a Forever guild only; a surname makes a different character; the same full name is taken', async () => {
  const f = await scenario({ version: 'forever' });
  const made = await f.ok('gm', 'POST', '/roster', { teamId: f.tid, name: 'thrall stormrage', class: 'SHAMAN', mainSpec: 'Enhancement', offSpec: null, status: 'raider' });
  assert.equal(made.characters[0].name, 'Thrall Stormrage');
  assert.deepEqual((await f.rows('SELECT name, name_key FROM characters WHERE guild_id = ?', f.gid)).map((row) => [row.name, row.name_key]), [['Thrall Stormrage', 'thrall stormrage']]);
  const same = await f.call('gm', 'POST', '/roster', { teamId: f.tid, name: 'THRALL STORMRAGE', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  assert.equal(same.status, 409, same.text);
  await f.ok('gm', 'POST', '/roster', { teamId: f.tid, name: 'Thrall', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' }); // a different character
  const three = await f.call('gm', 'POST', '/roster', { teamId: f.tid, name: 'Thrall Stormrage Jr', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' });
  assert.equal(three.status, 400);
  assert.match(three.json.message, /first name and a surname/);
  const rename = await f.call('gm', 'PATCH', `/roster/${made.person.id}/characters/${made.characters[0].id}`, { name: 'Thrall Doomhammer' });
  assert.equal(rename.status, 200, rename.text);
  assert.equal((await f.rows('SELECT name_key FROM characters WHERE id = ?', made.characters[0].id))[0].name_key, 'thrall doomhammer');
  // TBC, same input: refused as before.
  const t = await scenario({ version: 'tbc' });
  const refused = await t.call('gm', 'POST', '/roster', { teamId: t.tid, name: 'Thrall Stormrage', class: 'SHAMAN', mainSpec: 'Enhancement', offSpec: null, status: 'raider' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.message, 'A character name is 2 to 12 letters.');
});

check('names: a plan keeps a full name, resolves a unique first word to it, and refuses a repeated one; a TBC plan refuses a space', async () => {
  const f = await scenario({ version: 'forever' });
  const thrall = await f.person('Thrall Stormrage');
  await f.person('Jaina Proudmoore', { cls: 'MAGE' });
  await f.person('Jaina Windrunner', { cls: 'MAGE' });
  const rid = await f.raid('2027-01-12');
  const put = (players) => f.call('gm', 'PUT', `/raids/${rid}/plan`, { label: 'Plan', players });
  const ok = await put([{ name: 'Thrall', group: 1 }, { name: 'Jaina', group: 1 }, { name: 'Arthas Menethil', group: 2 }, { name: 'Sylvanas', group: 0 }]);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual((await f.rows('SELECT name, name_key, group_number FROM raid_plan WHERE raid_id = ? ORDER BY rowid', rid)).map((row) => [row.name, row.name_key, row.group_number]), [
    ['Thrall Stormrage', 'thrall stormrage', 1], ['Jaina', 'jaina', 1], ['Arthas Menethil', 'arthas menethil', 2], ['Sylvanas', 'sylvanas', 0],
  ]);
  // The plan matches the person by the full key, so the attendance and the plan card know them.
  const detail = await f.ok('gm', 'GET', `/raids/${rid}`);
  assert.deepEqual(detail.sources.plan.unmatched.sort(), ['Arthas Menethil', 'Jaina', 'Sylvanas']);
  assert.equal(detail.sources.plan.players, 4);
  const twice = await put([{ name: 'Thrall', group: 1 }, { name: 'Thrall Stormrage', group: 2 }]);
  assert.equal(twice.status, 400);
  assert.match(twice.json.message, /in the plan twice/);
  const bad = await put([{ name: 'Thrall Stormrage Jr', group: 1 }]);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.index, 0);
  assert.equal(thrall.pid.startsWith('p_'), true);
  const t = await scenario({ version: 'tbc' });
  await t.person('Thrall');
  const trid = await t.raid('2027-01-12');
  const refused = await t.call('gm', 'PUT', `/raids/${trid}/plan`, { label: 'Plan', players: [{ name: 'Thrall Stormrage', group: 1 }] });
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json.message, 'A character name is 2 to 12 letters.');
});

check('names: a log that prints only the first word still finds the person; two possible persons stay unmatched for review; TBC logs are untouched', async () => {
  const f = await scenario({ version: 'forever' });
  const thrall = await f.person('Thrall Stormrage');
  await f.person('Jaina Proudmoore', { cls: 'MAGE' });
  await f.person('Jaina Windrunner', { cls: 'MAGE' });
  const start = Date.parse('2027-01-13T01:00:00Z');
  f.net.reports.set('Aaaa000000000001', wclReport({
    startTime: start, actors: [[1, 'Thrall', 'Warrior'], [2, 'Jaina', 'Mage'], [3, 'Jaina Windrunner', 'Mage'], [4, 'Wanderer Stranger', 'Rogue'], [5, 'Pet', 'Pet']],
    fights: [[1, 'Gruul', 650, true, 0, 200, [1, 2, 3, 4]]],
  }));
  const made = await f.ok('gm', 'POST', '/raids', { teamId: f.tid, reportSource: 'https://fresh.warcraftlogs.com/reports/Aaaa000000000001' });
  const rid = made.raid.id;
  assert.deepEqual((await f.rows('SELECT name, name_key FROM raid_presence WHERE raid_id = ? ORDER BY name_key', rid)).map((row) => [row.name, row.name_key]), [
    ['Jaina', 'jaina'], ['Jaina Windrunner', 'jaina windrunner'], ['Thrall Stormrage', 'thrall stormrage'], ['Wanderer Stranger', 'wanderer stranger'],
  ]);
  const detail = await f.ok('gm', 'GET', `/raids/${rid}`);
  assert.equal(detail.people.find((entry) => entry.playerId === thrall.pid).outcome, 'present');
  assert.deepEqual(detail.unmatched.map((entry) => entry.name).sort(), ['Jaina', 'Wanderer Stranger']);
  // The same single-word log on a TBC guild is exactly what it was: no surname exists there, so there is nothing to resolve.
  const t = await scenario({ version: 'tbc' });
  await t.person('Thrall');
  t.net.reports.set('Aaaa000000000002', wclReport({ startTime: start, actors: [[1, 'Thrall', 'Warrior'], [2, 'Jaina', 'Mage']], fights: [[1, 'Gruul', 650, true, 0, 200, [1, 2]]] }));
  const tm = await t.ok('gm', 'POST', '/raids', { teamId: t.tid, reportSource: 'https://fresh.warcraftlogs.com/reports/Aaaa000000000002' });
  assert.deepEqual((await t.rows('SELECT name FROM raid_presence WHERE raid_id = ? ORDER BY name_key', tm.raid.id)).map((row) => row.name), ['Jaina', 'Thrall']);
});

check('names: Gargul winners and soft-reserve rows resolve a first word to the full name; the CSV import knows the person is already there', async () => {
  const f = await scenario({ version: 'forever' });
  const thrall = await f.person('Thrall Stormrage');
  const rid = await f.raid('2027-01-12');
  const awardedAt = Date.parse('2027-01-13T02:00:00Z');
  const preview = await f.ok('gm', 'POST', `/raids/${rid}/loot/preview`, {
    awards: [
      { checksum: 'check0001', itemId: 28830, awardedAt, winnerName: 'Thrall' },
      { checksum: 'check0002', itemId: 28831, awardedAt, winnerName: 'Jaina Proudmoore' },
    ],
  }, 200);
  assert.deepEqual(preview.rows.map((row) => row.winnerName), ['Thrall Stormrage', 'Jaina Proudmoore']);
  assert.equal(preview.rows[0].match.kind, 'character');
  assert.equal(preview.rows[1].match.kind, 'unmatched');
  await f.ok('gm', 'PUT', `/raids/${rid}/loot-lists`, { source: 'softres', rows: [{ name: 'thrall', itemId: 28830, copies: 1 }, { name: 'Arthas Menethil', itemId: 28831 }] }, 200);
  assert.deepEqual((await f.rows('SELECT name, name_key FROM raid_loot_lists WHERE raid_id = ? ORDER BY position', rid)).map((row) => [row.name, row.name_key]), [['Thrall Stormrage', 'thrall stormrage'], ['Arthas Menethil', 'arthas menethil']]);
  const tbcRows = await (async () => {
    const t = await scenario({ version: 'tbc' });
    const trid = await t.raid('2027-01-12');
    return t.call('gm', 'PUT', `/raids/${trid}/loot-lists`, { source: 'softres', rows: [{ name: 'Thrall Stormrage', itemId: 28830 }] });
  })();
  assert.equal(tbcRows.status, 400);
  assert.equal(tbcRows.json.message.endsWith('(2 to 12 letters).'), true, 'TBC: the old message');
  // CSV: "Thrall" is Thrall Stormrage, who is on the roster; a new two-word character is a new row; TBC refuses a space.
  const csv = await f.ok('gm', 'POST', '/roster/import/csv/preview', { teamId: f.tid, text: 'name,class\nThrall,Warrior\nNewcomer Surname,Mage\n' }, 200);
  assert.equal(csv.rows[0].name, 'Thrall Stormrage');
  assert.deepEqual(csv.rows[0].taken && csv.rows[0].taken.personId, thrall.pid);
  assert.equal(csv.rows[1].name, 'Newcomer Surname');
  assert.equal(csv.rows[1].problems.length, 0);
  assert.equal(csv.rows[1].taken, null);
  const t2 = await scenario({ version: 'tbc' });
  const tcsv = await t2.ok('gm', 'POST', '/roster/import/csv/preview', { teamId: t2.tid, text: 'name,class\nNewcomer Surname,Mage\n' }, 200);
  assert.match(tcsv.rows[0].problems[0], /is not a character name \(2 to 12 letters\)\.$/);
});

// ===========================================================================
// 2. Raid duties and the log nudge

check('duties: an officer sets them per raid, the raid detail shows them, the next raid offers the last ones, a member cannot, and the changes are audited', async () => {
  const s = await scenario({ members: ['m1'] });
  const aldric = await s.person('Aldric', { link: 'm1' });
  const brenna = await s.person('Brenna', { cls: 'MAGE' });
  const rid = await s.raid('2027-01-20');
  const none = await s.ok('gm', 'GET', `/raids/${rid}/duties`);
  assert.deepEqual(none, { duties: [], previous: [] });
  const set = await s.ok('gm', 'PUT', `/raids/${rid}/duties`, { duties: [
    { duty: 'logger', personId: brenna.pid }, { duty: 'leader', personId: aldric.pid }, { duty: 'extra', personId: aldric.pid, label: '  Bring   flasks ' },
  ] });
  assert.deepEqual(set.duties.map((d) => [d.duty, d.label, d.name]), [['leader', 'Raid leader', 'Aldric'], ['logger', 'Logger', 'Brenna'], ['extra', 'Bring flasks', 'Aldric']]);
  assert.deepEqual((await s.ok('gm', 'GET', `/raids/${rid}`)).duties, set.duties, 'every GET of the raid carries the duties');
  assert.deepEqual((await s.ok('m1', 'GET', `/raids/${rid}`)).duties.map((d) => d.label), ['Raid leader', 'Logger', 'Bring flasks'], 'a member sees them');
  assert.equal((await s.call('m1', 'PUT', `/raids/${rid}/duties`, { duties: [] })).status, 403);
  assert.equal((await s.call('m1', 'GET', `/raids/${rid}/duties`)).status, 403);
  // The next raid of the team offers the last ones as a start.
  const next = await s.raid('2027-01-27');
  assert.deepEqual((await s.ok('gm', 'GET', `/raids/${next}/duties`)).previous.map((d) => d.label), ['Raid leader', 'Logger', 'Bring flasks']);
  // Rules.
  const put = (duties) => s.call('gm', 'PUT', `/raids/${rid}/duties`, { duties });
  assert.equal((await put([{ duty: 'logger', personId: aldric.pid }, { duty: 'logger', personId: brenna.pid }])).status, 400, 'one person per duty');
  assert.equal((await put([{ duty: 'boss', personId: aldric.pid }])).status, 400, 'an unknown duty');
  assert.equal((await put([{ duty: 'extra', personId: aldric.pid }])).status, 400, 'your own duty needs words');
  assert.equal((await put([{ duty: 'loot', personId: aldric.pid, label: 'Master' }])).status, 400, 'a fixed duty has no words');
  assert.equal((await put([{ duty: 'loot', personId: 'p_AAAAAAAAAAAAAAAAAAAAAA' }])).status, 400, 'someone who is not on the roster');
  assert.equal((await put('nope')).status, 400);
  assert.equal((await s.ok('gm', 'PUT', `/raids/${rid}/duties`, { duties: [] })).duties.length, 0, 'an empty list clears them');
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_duties WHERE raid_id = ?', rid))[0].n, 0);
  const audits = await s.audits('duties.set');
  assert.equal(audits.length, 2);
  assert.deepEqual(JSON.parse(audits[0].after), { duties: ['leader', 'logger', 'extra'] });
  // A person who leaves the roster takes their duties with them.
  await s.ok('gm', 'PUT', `/raids/${rid}/duties`, { duties: [{ duty: 'loot', personId: brenna.pid }] });
  await s.ok('gm', 'DELETE', `/roster/${brenna.pid}`, {});
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_duties WHERE raid_id = ?', rid))[0].n, 0);
});

check('duties: the roster post lists them, in names a message can carry', async () => {
  const n = await load('worker/notify.js');
  const seats = [{ name: 'Aldric', group: 1 }, { name: 'Brenna', group: 0 }];
  const body = n.rosterBody({ starts_at: NOW, zone: 'Karazhan' }, { teamName: 'Alpha', link: null, roleId: null, seats, duties: [{ label: 'Raid leader', name: 'Aldric' }, { label: 'Bring @everyone flasks', name: 'Thrall Stormrage' }] });
  const fields = body.embeds[0].fields;
  assert.equal(fields[0].name, 'Duties');
  assert.equal(fields[0].value, 'Raid leader: Aldric\nBring everyone flasks: Thrall Stormrage', 'mention syntax is stripped from the officer\'s words');
  assert.deepEqual(fields.slice(1).map((f) => f.name), ['Group 1', 'Bench']);
  assert.deepEqual(body.allowed_mentions.parse, [], 'it pings nobody');
  const plain = n.rosterBody({ starts_at: NOW, zone: 'Karazhan' }, { teamName: 'Alpha', link: null, roleId: null, seats });
  assert.deepEqual(plain.embeds[0].fields.map((f) => f.name), ['Group 1', 'Bench'], 'without duties the post is what it was');
});

check('duties: publishing the line-up posts the duties to the channel', async () => {
  const s = await scenario({ members: ['m1'] });
  const aldric = await s.person('Aldric', { link: 'm1' });
  await s.notify({ webhookUrl: HOOK, roster: true });
  const rid = await s.raid('2027-01-20');
  await s.ok('gm', 'PUT', `/raids/${rid}/duties`, { duties: [{ duty: 'leader', personId: aldric.pid }] });
  await s.ok('gm', 'PUT', `/raids/${rid}/plan`, { label: 'Plan', players: [{ name: 'Aldric', group: 1 }] });
  await s.ok('gm', 'POST', `/raids/${rid}/roster`, {}, 200);
  const post = s.net.posts.find((entry) => /Line-up published/.test(entry.body.embeds[0].title));
  assert(post, JSON.stringify(s.net.posts.map((p) => p.body.embeds[0].title)));
  assert.deepEqual(post.body.embeds[0].fields[0], { name: 'Duties', value: 'Raid leader: Aldric', inline: false });
});

check('log nudge: five hours after the start with no report, the Logger is named - Needs attention for officers, one channel post - and not before, not twice, not for a raid with a log', async () => {
  const n = await load('worker/notify.js');
  const body = n.logNudgeBody({ raid_on: '2027-01-12', zone: 'Gruul', title: null }, { teamName: 'Alpha', link: null, roleId: null, day: 'Tue Jan 12', logger: { name: 'Brenna', discordId: '123456789012345678', optedOut: false } });
  assert.equal(body.embeds[0].title, 'Upload the log for Tue Jan 12: Gruul - Alpha');
  assert.deepEqual(body.allowed_mentions.users, ['123456789012345678'], 'the Logger is pinged by Discord ID');
  assert.match(body.embeds[0].description, /Brenna, you are the Logger/);
  const quiet = n.logNudgeBody({ raid_on: '2027-01-12', zone: 'Gruul' }, { teamName: 'Alpha', link: null, roleId: null, day: 'Tue Jan 12', logger: { name: 'Brenna', discordId: '123456789012345678', optedOut: true } });
  assert.deepEqual(quiet.allowed_mentions.users, [], 'an opt-out is respected');
  const d = await load('worker/duties.js');
  assert.equal(d.shortDay('2027-01-12'), 'Tue Jan 12');
  assert.equal(d.nudgeText('2026-10-21'), 'Upload the log for Wed Oct 21');
  assert.equal(d.logDueAt(1000), 1000 + 5 * HOUR, 'a 3 hour raid and 2 hours of grace');
  assert.equal(d.logOverdue({ starts_at: NOW - 6 * HOUR, time_known: 1, log_mode: 'log', reports: 0 }, NOW), true);
  assert.equal(d.logOverdue({ starts_at: NOW - 4 * HOUR, time_known: 1, log_mode: 'log', reports: 0 }, NOW), false);
  assert.equal(d.logOverdue({ starts_at: NOW - 6 * HOUR, time_known: 1, log_mode: 'manual', reports: 0 }, NOW), false);
  assert.equal(d.logOverdue({ starts_at: NOW - 6 * HOUR, time_known: 1, log_mode: 'log', reports: 1 }, NOW), false);
  assert.equal(d.logOverdue({ starts_at: NOW - 8 * DAY, time_known: 1, log_mode: 'log', reports: 0 }, NOW), false, 'not for a raid from last week');

  const s = await scenario({ members: ['m1'] });
  const brenna = await s.person('Brenna', { cls: 'MAGE', link: 'm1' });
  const aldric = await s.person('Aldric');
  await s.notify({ webhookUrl: HOOK });
  // A raid that started 6 h ago (Thursday 02:00 New York, whatever its date), with Brenna as Logger.
  s.w.clock.now = NOW;
  const rid = await s.raid('2027-01-14', { startTime: '20:00' }); // 2027-01-15T01:00Z: 7 hours before NOW
  assert.equal((await s.rows('SELECT starts_at FROM raids WHERE id = ?', rid))[0].starts_at, Date.parse('2027-01-15T01:00:00Z'));
  await s.ok('gm', 'PUT', `/raids/${rid}/duties`, { duties: [{ duty: 'logger', personId: brenna.pid }] });
  const nothingYet = (await s.ok('gm', 'GET', '/attention')).items.filter((i) => i.kind === 'log_missing');
  assert.equal(nothingYet.length, 1, 'the Logger is named and the log is overdue');
  assert.equal(nothingYet[0].loggerName, 'Brenna');
  assert.equal(nothingYet[0].date, '2027-01-14');
  assert.deepEqual(nothingYet[0].link, { name: 'raid', rid });
  assert.equal(nothingYet[0].severity, 'action');
  assert.equal((await s.call('m1', 'GET', '/attention')).status, 403, 'a member does not get the list');
  // A raid with no Logger set is no one's to nudge.
  const other = await s.raid('2027-01-13');
  assert.equal((await s.ok('gm', 'GET', '/attention')).items.filter((i) => i.kind === 'log_missing').length, 1, 'only the raid with a Logger');
  void other;
  // The post: once, naming the Logger, pinging her account's Discord ID.
  const first = await s.run();
  assert.equal(first.posts.sent, 1, JSON.stringify(first));
  const post = s.net.posts.find((entry) => /Upload the log/.test(entry.body.embeds[0].title));
  assert(post);
  assert.equal(post.body.embeds[0].title, 'Upload the log for Thu Jan 14: Gruul\'s Lair - Alpha');
  assert.match(post.body.embeds[0].description, /Brenna, you are the Logger/);
  assert.equal(post.body.allowed_mentions.users.length, 1);
  assert.deepEqual((await s.rows("SELECT kind, status, people FROM notification_log WHERE kind = 'log_nudge'")), [{ kind: 'log_nudge', status: 'sent', people: 1 }]);
  s.w.advance(HOUR);
  assert.equal((await s.run()).posts.sent, 0, 'never twice');
  // A report arrives: nothing is overdue any more.
  const start = Date.parse('2027-01-15T01:00:00Z');
  s.net.reports.set('Aaaa000000000009', wclReport({ startTime: start, actors: [[1, 'Aldric', 'Warrior']], fights: [[1, 'Gruul', 650, true, 0, 200, [1]]] }));
  await s.ok('gm', 'PUT', `/raids/${rid}/reports`, { source: 'https://fresh.warcraftlogs.com/reports/Aaaa000000000009' }, 200);
  assert.equal((await s.ok('gm', 'GET', '/attention')).items.filter((i) => i.kind === 'log_missing').length, 0, 'a raid with a log is not waiting for one');
  void aldric;
});

check('log nudge: not five hours yet, no webhook, a hand-entered raid and a later raid are left alone; the post waits for the right moment', async () => {
  const s = await scenario();
  const brenna = await s.person('Brenna', { cls: 'MAGE' });
  const rid = await s.raid('2027-01-14', { startTime: '20:00' }); // starts 2027-01-15T01:00Z
  await s.ok('gm', 'PUT', `/raids/${rid}/duties`, { duties: [{ duty: 'logger', personId: brenna.pid }] });
  const start = Date.parse('2027-01-15T01:00:00Z');
  s.w.clock.now = start + 4 * HOUR;
  assert.equal((await s.ok('gm', 'GET', '/attention')).items.filter((i) => i.kind === 'log_missing').length, 0, '4 h after the start: still inside the raid and the grace');
  s.w.clock.now = start + 5 * HOUR + 1000;
  assert.equal((await s.ok('gm', 'GET', '/attention')).items.filter((i) => i.kind === 'log_missing').length, 1, 'just over 5 h');
  assert.equal((await s.run()).posts.sent, 0, 'no webhook: no post, but the list still has it');
  await s.notify({ webhookUrl: HOOK });
  assert.equal((await s.run()).posts.sent, 1, 'the webhook is on: one post');
  // Hand-entered attendance is "no log on purpose".
  await s.ok('gm', 'PUT', `/raids/${rid}/manual`, { reason: 'Logger was away', presentPlayerIds: [brenna.pid] }, 200);
  assert.equal((await s.ok('gm', 'GET', '/attention')).items.filter((i) => i.kind === 'log_missing').length, 0);
  // Past the look-back week nobody is nudged.
  await s.ok('gm', 'DELETE', `/raids/${rid}/manual`, { reason: 'Found the log' }, 200);
  s.w.clock.now = start + 8 * DAY;
  assert.equal((await s.ok('gm', 'GET', '/attention')).items.filter((i) => i.kind === 'log_missing').length, 0);
});

check('migration 0022: duties are one person per duty and go with the raid or the person; the log kind exists; the old log rows survived', async () => {
  const s = await scenario();
  const a = await s.person('Aldric');
  const rid = await s.raid('2027-01-20');
  const insert = (duty, label) => s.exec('INSERT INTO raid_duties (raid_id, guild_id, duty, player_id, label) VALUES (?, ?, ?, ?, ?)', rid, s.gid, duty, a.pid, label);
  await insert('leader', null);
  await assert.rejects(() => insert('leader', null), /UNIQUE/);
  await assert.rejects(() => insert('boss', null), /CHECK/);
  await assert.rejects(() => insert('extra', null), /CHECK/, 'the extra duty needs its words');
  await assert.rejects(() => insert('loot', 'words'), /CHECK/, 'a fixed duty has none');
  await insert('extra', 'Flasks');
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_duties'))[0].n, 2);
  await s.exec("INSERT INTO notification_log (id, guild_id, team_id, raid_id, kind, dedupe_key, status, created_at) VALUES ('nl_AAAAAAAAAAAAAAAAAAAAAA', ?, ?, ?, 'log_nudge', 'log_nudge:x', 'sent', 1)", s.gid, s.tid, rid);
  await assert.rejects(() => s.exec("INSERT INTO notification_log (id, guild_id, team_id, raid_id, kind, dedupe_key, status, created_at) VALUES ('nl_BBBBBBBBBBBBBBBBBBBBBB', ?, ?, ?, 'nonsense', 'k', 'sent', 1)", s.gid, s.tid, rid), /CHECK/);
  await assert.rejects(() => s.exec("INSERT INTO notification_log (id, guild_id, team_id, raid_id, kind, dedupe_key, status, created_at) VALUES ('nl_CCCCCCCCCCCCCCCCCCCCCC', ?, ?, ?, 'log_nudge', 'log_nudge:x', 'sent', 1)", s.gid, s.tid, rid), /UNIQUE/, 'the dedupe key is still once-only');
  await s.ok('gm', 'DELETE', `/raids/${rid}`, {});
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_duties'))[0].n, 0, 'duties go with the raid');
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM notification_log'))[0].n, 0, 'so does the log row of the raid');
});

// ===========================================================================
// 3. The Launch funnel

check('launch funnel (pure): a person\'s stages in a row, a Battle.net level fills the band, the totals per stage and role and the gap to the raid size', async () => {
  const l = await load('worker/launch-data.js');
  assert.deepEqual(l.LEVEL_BANDS, ['1-19', '20-39', '40-59', '60+']);
  assert.deepEqual([1, 19, 20, 39, 40, 59, 60, 70, 0, null].map(l.bandOfLevel), ['1-19', '1-19', '20-39', '20-39', '40-59', '40-59', '60+', '60+', null, null]);
  const person = { id: 'p_1', status: 'raider', name: 'Aldric', class: 'WARRIOR' };
  const pick = { class: 'WARRIOR', spec: 'Protection', role: 'tank' };
  const row = (p, pk, classes, status, level) => l.funnelRow(p, pk, classes, status, level);
  assert.equal(row(person, null, [], null, null).stage, 0);
  assert.equal(row(person, pick, [], null, null).stage, 1, 'picked, no character yet');
  assert.equal(row(person, pick, ['MAGE'], null, null).stage, 1, 'a character of another class is not the one they picked');
  assert.equal(row(person, pick, ['MAGE', 'WARRIOR'], null, null).stage, 2);
  assert.equal(row(person, pick, ['WARRIOR'], { level_band: '40-59', ready: 0 }, null).stage, 3);
  assert.equal(row(person, pick, ['WARRIOR'], { level_band: '40-59', ready: 1 }, null).stage, 4);
  const byBnet = row(person, pick, ['WARRIOR'], null, 62);
  assert.deepEqual(byBnet.level, { band: '60+', source: 'battlenet' });
  assert.deepEqual(row(person, pick, ['WARRIOR'], { level_band: '20-39', ready: 0 }, 62).level, { band: '20-39', source: 'manual' }, 'a typed band wins over the Battle.net level');
  assert.equal(row(person, null, ['WARRIOR'], { level_band: null, ready: 1 }, null).stage, 0, 'ready without an intent pick counts as ready, but the row has not come in a row');
  assert.equal(row(person, null, ['WARRIOR'], { level_band: null, ready: 1 }, null).flags.ready, true);
  const rows = [
    row({ ...person, id: 'p_1' }, pick, ['WARRIOR'], { level_band: '60+', ready: 1 }, null),
    row({ ...person, id: 'p_2' }, { class: 'PRIEST', spec: 'Holy', role: 'healer' }, ['PRIEST'], { level_band: '40-59', ready: 0 }, null),
    row({ ...person, id: 'p_3' }, { class: 'PRIEST', spec: 'Holy', role: 'healer' }, [], null, null),
    row({ ...person, id: 'p_4' }, null, ['MAGE'], null, null),
  ];
  const totals = l.funnelTotals(rows, 10, { tank: 2, healer: 3, melee: 3, ranged: 2 });
  assert.deepEqual(totals.stages, { intent: 3, character: 3, level: 2, topLevel: 1, ready: 1 });
  assert.equal(totals.gap, 9, 'ten seats, one ready');
  assert.deepEqual(totals.roles.map((r) => [r.role, r.people, r.intent, r.character, r.level, r.ready, r.target, r.gap]), [
    ['tank', 1, 1, 1, 1, 1, 2, 1], ['healer', 2, 2, 1, 1, 0, 3, 3], ['melee', 0, 0, 0, 0, 0, 3, 3], ['ranged', 0, 0, 0, 0, 0, 2, 2], ['none', 1, 0, 1, 0, 0, null, null],
  ]);
  assert.equal(l.launchEnabled({ game_version: 'forever' }, { launch_team: 0 }), true);
  assert.equal(l.launchEnabled({ game_version: 'tbc' }, { launch_team: 0 }), false);
  assert.equal(l.launchEnabled({ game_version: 'tbc' }, { launch_team: 1 }), true);
});

check('launch funnel: a Forever team has it; the funnel reads the intent board and the roster; officers tick, members update their own row; Battle.net levels fill in', async () => {
  const s = await scenario({ version: 'forever', members: ['m1', 'm2'] });
  const aldric = await s.person('Aldric Stormwind', { link: 'm1', cls: 'WARRIOR' });
  const brenna = await s.person('Brenna Lightsong', { link: 'm2', cls: 'PRIEST', spec: 'Holy' });
  const corwin = await s.person('Corwin', { cls: 'MAGE' });
  const funnel = (who = 'gm') => s.ok(who, 'GET', `/launch?team=${s.tid}`);
  const empty = await funnel();
  assert.equal(empty.enabled, true);
  assert.equal(empty.round, null);
  assert.equal(empty.rows.length, 3);
  assert.deepEqual(empty.totals.stages, { intent: 0, character: 3, level: 0, topLevel: 0, ready: 0 }, 'everyone has a character on the team; nobody has picked');
  assert.equal(empty.totals.gap, 20, 'a Forever team starts at 20');
  assert.equal(empty.canEdit, true);
  // Intent: Aldric picks Warrior Protection, Brenna Priest Holy; Corwin has not picked.
  const round = await s.ok('gm', 'POST', `/teams/${s.tid}/intent`, { title: 'Launch intent' });
  const iid = round.round.id;
  await s.ok('m1', 'PUT', `/intent/${iid}/picks/${aldric.pid}`, { kind: 'main', class: 'WARRIOR', spec: 'Protection' }, 200);
  await s.ok('m2', 'PUT', `/intent/${iid}/picks/${brenna.pid}`, { kind: 'main', class: 'PRIEST', spec: 'Holy' }, 200);
  const picked = await funnel();
  const byName = (data) => Object.fromEntries(data.rows.map((row) => [row.name, row]));
  assert.deepEqual(picked.totals.stages, { intent: 2, character: 3, level: 0, topLevel: 0, ready: 0 });
  assert.equal(picked.round.title, 'Launch intent');
  assert.equal(byName(picked)['Aldric Stormwind'].role, 'tank');
  assert.equal(byName(picked)['Brenna Lightsong'].role, 'healer');
  assert.equal(byName(picked).Corwin.stage, 0);
  // Officers set a level band and the ready tick; a member updates their own row only.
  const set = await s.ok('gm', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid, levelBand: '40-59' }, 200);
  assert.deepEqual(byName(set)['Aldric Stormwind'].level, { band: '40-59', source: 'manual' });
  assert.equal(byName(set)['Aldric Stormwind'].stage, 3);
  const mine = await s.ok('m1', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid, ready: true }, 200);
  assert.equal(byName(mine)['Aldric Stormwind'].ready, true);
  assert.equal(byName(mine)['Aldric Stormwind'].level.band, '40-59', 'ticking ready keeps the band');
  assert.equal(mine.canEdit, false);
  assert.equal(byName(mine)['Aldric Stormwind'].mine, true);
  assert.equal((await s.call('m1', 'PUT', `/launch/${brenna.pid}`, { teamId: s.tid, ready: true })).status, 403, 'not someone else\'s row');
  assert.equal((await s.call('m1', 'PUT', `/teams/${s.tid}/launch`, { enabled: false })).status, 403);
  assert.equal((await s.call('gm', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid, levelBand: '99' })).status, 400);
  assert.equal((await s.call('gm', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid })).status, 400, 'something to change');
  assert.equal((await s.call('gm', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid, ready: 'yes' })).status, 400);
  const cleared = await s.ok('gm', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid, levelBand: null }, 200);
  assert.equal(byName(cleared)['Aldric Stormwind'].level, null, 'null clears a typed band');
  assert.equal(byName(cleared)['Aldric Stormwind'].ready, true);
  // Battle.net: an approved claim's level gives the band when nothing was typed.
  await s.exec("INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, team_id, decided_at, created_at) VALUES ('cl_AAAAAAAAAAAAAAAAAAAAAA', ?, ?, 'Brenna Lightsong', 'brenna lightsong', NULL, '', 'PRIEST', 63, 'approved', ?, 2, 1)", s.gid, s.uids.m2, s.tid);
  const withLevel = await funnel();
  assert.deepEqual(byName(withLevel)['Brenna Lightsong'].level, { band: '60+', source: 'battlenet' });
  assert.equal(withLevel.totals.stages.topLevel, 1);
  // The totals: a tank ready of 2 wanted (the default 20-man targets), the gap to the raid size.
  assert.equal(withLevel.totals.stages.ready, 1);
  assert.equal(withLevel.totals.gap, 19);
  assert.deepEqual(withLevel.totals.roles.find((r) => r.role === 'tank'), { role: 'tank', people: 1, intent: 1, character: 1, level: 0, ready: 1, target: 2, gap: 1 });
  // Someone with no character on the team is not in its funnel; neither can their row be set.
  await s.ok('gm', 'PUT', `/launch/${corwin.pid}`, { teamId: s.tid, ready: true }, 200);
  const audits = await s.audits('launch.update');
  assert.equal(audits.length, 4);
  assert.deepEqual(JSON.parse(audits[0].after), { teamId: s.tid, levelBand: '40-59', ready: false });
  assert.equal((await funnel('m1')).rows.length, 3, 'a member sees the funnel of their team');
});

check('launch funnel: a TBC team has none until an officer marks it a launch team; the mark is the guild teams right and is audited', async () => {
  const s = await scenario({ version: 'tbc', members: ['m1'] });
  const aldric = await s.person('Aldric', { link: 'm1' });
  const off = await s.ok('gm', 'GET', `/launch?team=${s.tid}`);
  assert.deepEqual([off.enabled, off.rows, off.totals, off.canMark], [false, [], null, true]);
  assert.equal((await s.call('gm', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid, ready: true })).status, 409, 'the funnel is not on');
  assert.equal((await s.call('m1', 'PUT', `/teams/${s.tid}/launch`, { enabled: true })).status, 403);
  assert.equal((await s.call('gm', 'PUT', `/teams/${s.tid}/launch`, { enabled: 'yes' })).status, 400);
  const on = await s.ok('gm', 'PUT', `/teams/${s.tid}/launch`, { enabled: true }, 200);
  assert.equal(on.enabled, true);
  assert.equal(on.team.launchTeam, true);
  const guild = await s.ok('gm', 'GET', '');
  assert.equal(guild.teams.find((team) => team.id === s.tid).launchTeam, true, 'the guild payload tells the Roster tabs');
  assert.equal((await s.ok('gm', 'PUT', `/launch/${aldric.pid}`, { teamId: s.tid, ready: true }, 200)).totals.stages.ready, 1);
  await s.ok('gm', 'PUT', `/teams/${s.tid}/launch`, { enabled: true }, 200); // no change, no second audit row
  await s.ok('gm', 'PUT', `/teams/${s.tid}/launch`, { enabled: false }, 200);
  assert.equal((await s.audits('launch.team')).length, 2);
  assert.equal((await s.ok('gm', 'GET', '')).teams.find((team) => team.id === s.tid).launchTeam, undefined, 'off: the key is not there');
  // The funnel keeps what was typed while it was off.
  assert.equal((await s.rows('SELECT ready FROM launch_status WHERE player_id = ?', aldric.pid))[0].ready, 1);
  await s.ok('gm', 'DELETE', `/roster/${aldric.pid}`, {});
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM launch_status'))[0].n, 0, 'a person takes their row with them');
});

// ===========================================================================
// 4. Guest sign-up links

async function joinScenario(options = {}) {
  const s = await scenario(options);
  const aldric = await s.person('Aldric', { link: options.members && options.members.includes('m1') ? 'm1' : null });
  const rid = await s.raid('2027-01-20', { title: 'Sunday Karazhan' });
  const made = await s.ok('gm', 'POST', `/raids/${rid}/join-links`, { maxUses: 3 }, 201);
  const token = made.created.token;
  const visitor = newJar();
  const view = await s.w.call(visitor, 'POST', '/api/join/view', { token });
  assert.equal(view.status, 200, view.text);
  const body = (extra = {}) => ({ token, name: 'Guestmage', class: 'MAGE', spec: 'Frost', note: 'From Beta guild', ...extra });
  // sendFresh: a new browser each time (its own cookie), so the three-an-hour limit of one browser does not decide an answer meant for another rule.
  const sendFresh = async (b) => {
    const jar = newJar();
    await s.w.call(jar, 'POST', '/api/join/view', { token });
    return s.w.call(jar, 'POST', '/api/join', b);
  };
  return { s, aldric, rid, made, token, visitor, view, body, send: (b, jar = visitor) => s.w.call(jar, 'POST', '/api/join', b), sendFresh };
}

check('guest link: an officer makes a link for an upcoming raid; its token is shown once; the view shows the raid and nothing of the roster', async () => {
  const { s, rid, made, token, view } = await joinScenario();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.created.path, `/#/join/${token}`);
  assert.equal(made.links.length, 1);
  assert.deepEqual([made.links[0].maxUses, made.links[0].uses, made.links[0].status], [3, 0, 'active']);
  assert.equal(JSON.stringify(made.links).includes(token), false, 'the list never carries the token');
  assert.equal((await s.ok('gm', 'GET', `/raids/${rid}/join-links`)).links[0].id, made.created.id);
  const stored = await s.rows('SELECT token_hash FROM raid_join_links WHERE id = ?', made.created.id);
  assert.notEqual(stored[0].token_hash, token, 'D1 keeps a hash');
  assert.equal(view.json.guild.name, 'Wave Eight');
  assert.deepEqual([view.json.raid.title, view.json.raid.raidOn, view.json.raid.teamName, view.json.spotsLeft], ['Sunday Karazhan', '2027-01-20', 'Alpha', 3]);
  assert(view.json.rosterOptions, 'the form\'s classes and specs');
  assert.equal(JSON.stringify(view.json).includes('Aldric'), false);
  assert.equal(view.headers.getSetCookie().some((line) => line.startsWith('__Host-rs_join=')), true, 'the cookie the sign-up needs');
  assert.equal((await s.audits('join.create')).length, 1);
  assert.equal(JSON.stringify(await s.rows('SELECT before, after FROM audit_log WHERE action = ?', 'join.create')).includes(token), false, 'the token is not audited');
  // A past raid takes no link; a member may not make one.
  const past = await s.raid('2027-01-10');
  assert.equal((await s.call('gm', 'POST', `/raids/${past}/join-links`, {})).status, 409);
  assert.equal((await s.call('gm', 'POST', `/raids/${rid}/join-links`, { maxUses: 0 })).status, 400);
  assert.equal((await s.call('gm', 'POST', `/raids/${rid}/join-links`, { maxUses: 51 })).status, 400);
});

check('guest link: a guest signs up with a name, class, spec and note; it is a native sign-up with no person, shown as Guest, in the Planner seed, counted, and never a percentage', async () => {
  const { s, aldric, rid, send, body, token } = await joinScenario({ members: ['m1'] });
  const sent = await send(body());
  assert.equal(sent.status, 201, sent.text);
  assert.equal(sent.json.spotsLeft, 2);
  const row = (await s.rows("SELECT source, kind, player_id, nickname, class_name, spec_name, note, guest, join_link_id FROM raid_signups WHERE raid_id = ? AND guest = 1", rid))[0];
  assert.deepEqual([row.source, row.kind, row.player_id, row.nickname, row.class_name, row.spec_name, row.note, row.guest], ['raidsmith', 'signed', null, 'Guestmage', 'Mage', 'Frost', 'From Beta guild', 1]);
  assert.equal((await s.rows('SELECT uses FROM raid_join_links'))[0].uses, 1);
  // The sign-ups panel: listed as a guest, expected, counted.
  const view = await s.ok('gm', 'GET', `/raids/${rid}/signups`);
  const guest = view.entries.find((entry) => entry.guest);
  assert.deepEqual([guest.name, guest.className, guest.spec, guest.kind, guest.matched, guest.note, guest.personId], ['Guestmage', 'Mage', 'Frost', 'signed', false, 'From Beta guild', null]);
  assert.equal(view.counts.expected, 1);
  assert.equal(view.counts.byClass.MAGE, 1);
  assert.equal((await s.ok('m1', 'GET', `/raids/${rid}/signups`)).entries.find((entry) => entry.guest).name, 'Guestmage', 'members see the guest too');
  // The Planner seed carries it, by the name the guest typed.
  const seed = await s.ok('gm', 'GET', `/raids/${rid}/planner`);
  const seeded = seed.signups.find((entry) => entry.name === 'Guestmage');
  assert.deepEqual([seeded.className, seeded.specName, seeded.kind, seeded.guest, seeded.personId], ['Mage', 'Frost', 'signed', true, null]);
  // The merged counts of the Raids list include the guest.
  assert.equal((await s.ok('gm', 'GET', `/raids?team=${s.tid}`)).upcoming.find((r) => r.id === rid).signups.signed, 1);
  // Attendance: a guest has no person, so no row and no percentage. (The raid is still ahead: there are no results to give; after it, a log or hand-entered attendance comes first.)
  s.w.clock.now = Date.parse('2027-01-21T12:00:00Z');
  await s.ok('gm', 'PUT', `/raids/${rid}/manual`, { reason: 'No log tonight', presentPlayerIds: [aldric.pid] }, 200);
  const detail = await s.ok('gm', 'GET', `/raids/${rid}`);
  assert.deepEqual(detail.people.map((p) => p.name), ['Aldric'], 'the guest is in no attendance row');
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM attendance WHERE raid_id = ?', rid))[0].n, 1);
  // An officer removes a guest; the link keeps its use.
  s.w.clock.now = NOW;
  const removed = await s.ok('gm', 'DELETE', `/raids/${rid}/guests/${guest.key.split(':').pop()}`, {}, 200);
  assert.equal(removed.entries.some((entry) => entry.guest), false);
  assert.equal((await s.rows('SELECT uses FROM raid_join_links'))[0].uses, 1, 'removing a guest does not give the use back');
  assert.equal((await s.call('gm', 'DELETE', `/raids/${rid}/guests/99`, {})).status, 404);
  assert.deepEqual((await s.audits('signup.guest')).map((r) => [r.actor_user_id, JSON.parse(r.after).class]), [[null, 'MAGE']], 'the guest has no actor; the log names Raidsmith');
  assert.equal((await s.audits('signup.guest_remove')).length, 1);
  void token;
});

check('guest link: it stops at the raid start, when turned off, after its uses, and when the raid has too many guests; the form refuses what a bot would send', async () => {
  const { s, rid, made, token, send, sendFresh, body, visitor } = await joinScenario();
  // The form's own rules.
  assert.equal((await send(body({ name: 'X' }))).status, 400);
  assert.equal((await send(body({ name: 'Guest Mage' }))).status, 400, 'a TBC guild takes one-word names');
  assert.equal((await send(body({ class: 'NOPE' }))).status, 400);
  assert.equal((await send(body({ spec: 'Arms' }))).status, 400, 'a spec of another class');
  assert.equal((await send(body({ note: 'x'.repeat(121) }))).status, 400);
  assert.equal((await send(body({ token: 'y'.repeat(43) }))).status, 404);
  const bare = await send(body(), newJar());
  assert.deepEqual([bare.status, bare.json.error], [400, 'cookies_required']);
  const trap = await send(body({ website: 'http://spam.example' }));
  assert.equal(trap.status, 201);
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_signups WHERE guest = 1'))[0].n, 0, 'the honeypot stores nothing');
  // A character that is on the guild's roster signs in instead; a name twice is refused.
  const onRoster = await sendFresh(body({ name: 'Aldric' }));
  assert.deepEqual([onRoster.status, onRoster.json.error], [409, 'on_roster']);
  assert.equal((await sendFresh(body())).status, 201);
  const twice = await sendFresh(body());
  assert.deepEqual([twice.status, twice.json.error], [409, 'already_joined']);
  // This browser may sign up three times an hour: the fourth waits (the first two are real, the third is refused below by the link's uses).
  assert.equal((await sendFresh(body({ name: 'Guestrogue', class: 'ROGUE', spec: 'Combat' }))).status, 201);
  const third = await sendFresh(body({ name: 'Guestpriest', class: 'PRIEST', spec: 'Holy' }));
  assert.equal(third.status, 201, third.text);
  assert.equal((await s.rows('SELECT uses FROM raid_join_links'))[0].uses, 3);
  const full = await send(body({ name: 'Guestlock', class: 'WARLOCK', spec: 'Destruction' }));
  assert.deepEqual([full.status, full.json.error], [410, 'link_full'], 'three uses were allowed');
  assert.equal((await s.w.call(newJar(), 'POST', '/api/join/view', { token })).status, 410);
  assert.equal((await s.ok('gm', 'GET', `/raids/${rid}/join-links`)).links[0].status, 'full');
  // A second link: turned off, it stops at once.
  const second = await s.ok('gm', 'POST', `/raids/${rid}/join-links`, { maxUses: 5 }, 201);
  const fresh = newJar();
  assert.equal((await s.w.call(fresh, 'POST', '/api/join/view', { token: second.created.token })).status, 200);
  assert.equal((await s.ok('gm', 'DELETE', `/raids/${rid}/join-links/${second.created.id}`, {})).links.find((l) => l.id === second.created.id).status, 'revoked');
  const closed = await s.w.call(fresh, 'POST', '/api/join', { token: second.created.token, name: 'Guestdruid', class: 'DRUID', spec: 'Balance' });
  assert.deepEqual([closed.status, closed.json.error], [410, 'link_revoked']);
  assert.equal((await s.audits('join.revoke')).length, 1);
  // A third link: it works until the raid starts, and then it does not.
  const third2 = await s.ok('gm', 'POST', `/raids/${rid}/join-links`, { maxUses: 5 }, 201);
  const lateJar = newJar();
  assert.equal((await s.w.call(lateJar, 'POST', '/api/join/view', { token: third2.created.token })).status, 200);
  s.w.clock.now = (await s.rows('SELECT starts_at FROM raids WHERE id = ?', rid))[0].starts_at + 1000;
  const started = await s.w.call(lateJar, 'POST', '/api/join', { token: third2.created.token, name: 'Guestdruid', class: 'DRUID', spec: 'Balance' });
  assert.deepEqual([started.status, started.json.error], [410, 'link_expired']);
  assert.equal((await s.w.call(newJar(), 'POST', '/api/join/view', { token: third2.created.token })).status, 410);
  assert.equal((await s.ok('gm', 'GET', `/raids/${rid}/join-links`)).links.find((l) => l.id === third2.created.id).status, 'started');
  void made; void visitor;
});

check('guest link: a browser signs up three times an hour at most; a raid takes 15 guests and an officer\'s links cap at five that work', async () => {
  const { s, rid, token, send, body, visitor } = await joinScenario();
  const links = await s.ok('gm', 'POST', `/raids/${rid}/join-links`, { maxUses: 50 }, 201);
  const wide = links.created.token;
  const names = ['Guestaaa', 'Guestbbb', 'Guestccc', 'Guestddd'];
  const results = [];
  for (const name of names) results.push((await send(body({ token: wide, name }))).status);
  assert.deepEqual(results, [201, 201, 201, 429], 'three an hour per browser');
  const limited = await send(body({ token: wide, name: 'Guesteee' }));
  assert.equal(limited.status, 429);
  assert(limited.json.retryAfter > 0);
  s.w.advance(61 * 60 * 1000);
  assert.equal((await send(body({ token: wide, name: 'Guestfff' }))).status, 201, 'an hour later');
  // 15 guests per raid, whatever the links say: fill the raid with rows, then try once more.
  for (let i = 0; i < 11; i++) {
    await s.exec("INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, class_name, spec_name, position, guild_id, guest) VALUES (?, 'raidsmith', ?, ?, 'signed', 'Mage', 'Fire', ?, ?, 1)", rid, 100 + i, `Fill${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`, 100 + i, s.gid);
  }
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_signups WHERE guest = 1'))[0].n, 15);
  s.w.advance(61 * 60 * 1000);
  const over = await send(body({ token: wide, name: 'Guestzzz' }));
  assert.deepEqual([over.status, over.json.error], [410, 'link_full']);
  assert.equal((await s.w.call(newJar(), 'POST', '/api/join/view', { token: wide })).status, 410, 'the view says it too');
  // At most five links that still work on a raid (the full and the revoked ones do not count).
  const s2 = await joinScenario();
  for (let i = 0; i < 4; i++) await s2.s.ok('gm', 'POST', `/raids/${s2.rid}/join-links`, {}, 201);
  const sixth = await s2.s.call('gm', 'POST', `/raids/${s2.rid}/join-links`, {});
  assert.equal(sixth.status, 400);
  assert.match(sixth.json.message, /5 sign-up links that still work/);
  void token; void visitor;
});

check('guest link: a Forever guild takes a first name and a surname from a guest; a guest named like a roster character is told to sign in', async () => {
  const s = await scenario({ version: 'forever' });
  await s.person('Thrall Stormrage');
  const rid = await s.raid('2027-01-20');
  const made = await s.ok('gm', 'POST', `/raids/${rid}/join-links`, {}, 201);
  const jar = newJar();
  assert.equal((await s.w.call(jar, 'POST', '/api/join/view', { token: made.created.token })).json.guild.gameVersion, 'forever');
  const send = (name) => s.w.call(jar, 'POST', '/api/join', { token: made.created.token, name, class: 'MAGE', spec: 'Fire' });
  assert.equal((await send('Jaina Proudmoore')).status, 201);
  assert.equal((await s.rows('SELECT nickname FROM raid_signups WHERE guest = 1'))[0].nickname, 'Jaina Proudmoore');
  assert.equal((await send('thrall stormrage')).json.error, 'on_roster');
  assert.equal((await send('Too Many Words')).status, 400);
});

check('migration 0023: a pasted list takes a Forever name of up to 25 characters and still refuses a one-letter name; the rows of the old table survived', async () => {
  const s = await scenario({ version: 'forever' });
  const rid = await s.raid('2027-01-12');
  const insert = (position, name) => s.exec("INSERT INTO raid_loot_lists (raid_id, guild_id, source, position, kind, name, name_key, item_id, copies) VALUES (?, ?, 'softres', ?, 'sr', ?, ?, 1, 1)", rid, s.gid, position, name, name.toLowerCase());
  await insert(0, 'Thrall Stormrage');
  await insert(1, 'Abcdefghijkl Mnopqrstuvwx');
  await assert.rejects(() => insert(2, 'A'), /CHECK/);
  await assert.rejects(() => insert(3, 'Abcdefghijkl Mnopqrstuvwxy'), /CHECK/, '26 characters is too long');
  const indexes = (await s.rows("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'raid_loot_lists' AND name = 'raid_loot_lists_item'"));
  assert.equal(indexes.length, 1, 'the item index came back with the rebuilt table');
  await s.ok('gm', 'DELETE', `/raids/${rid}`, {});
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_loot_lists'))[0].n, 0, 'the lists still go with their raid');
});

check('migration 0022: a guest sign-up needs the Raidsmith source; a link goes with its raid and its uses never go negative', async () => {
  const { s, rid, made } = await joinScenario();
  await assert.rejects(() => s.exec("INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, guest) VALUES (?, 'raid_helper', 1, 'Nope', 'signed', 1, ?, 1)", rid, s.gid), /CHECK/);
  await assert.rejects(() => s.exec('UPDATE raid_join_links SET uses = -1 WHERE id = ?', made.created.id), /CHECK/);
  await assert.rejects(() => s.exec('UPDATE raid_join_links SET max_uses = 51 WHERE id = ?', made.created.id), /CHECK/);
  await s.ok('gm', 'DELETE', `/raids/${rid}`, {});
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_join_links'))[0].n, 0);
});

// ===========================================================================
// 5. A pasted raid roster

check('paste (pure): plain lists, commas, /who, a raid frame, links, colours, ratings and realms read as names; counters, headers and classes in their own column do not', async () => {
  const p = await load('worker/roster-paste.js');
  const names = (text, version = 'tbc') => p.parsePastedRoster(text, { gameVersion: version }).entries.map((entry) => entry.names[entry.names.length - 1] + (entry.realm ? `-${entry.realm}` : ''));
  assert.deepEqual(names('Aldric\nBrenna\ncorwin'), ['Aldric', 'Brenna', 'Corwin']);
  assert.deepEqual(names('Aldric, Brenna; Corwin\tDelia | Fenn'), ['Aldric', 'Brenna', 'Corwin', 'Delia', 'Fenn']);
  assert.deepEqual(names('[12:01:33] Raid roster\nGroup 1: Aldric, Brenna-Maladath, Corwin (Warrior)\nGroup 2: Delia - Mage\n3 players total'), ['Aldric', 'Brenna-Maladath', 'Corwin', 'Delia']);
  assert.deepEqual(names('|Hplayer:Fenn:123|h[Fenn]|h: Level 70 Orc Warrior <Guild> - Shattrath City\n[Gwyn]: Level 60 Human Mage\nHale: Level 70 Draenei Paladin'), ['Fenn', 'Gwyn', 'Hale']);
  assert.deepEqual(names('1. Aldric\n2) Brenna\n- Corwin\n* Delia\n> Fenn'), ['Aldric', 'Brenna', 'Corwin', 'Delia', 'Fenn']);
  assert.deepEqual(names('|cffc79c6eAldric|r\n[Tank] Brenna\n@Corwin\nDelia Mage Fire\nFenn Level 70'), ['Aldric', 'Brenna', 'Corwin', 'Delia', 'Fenn']);
  assert.deepEqual(names('Hale\tPaladin\tTank\nIvor\tHoly\tHealer'), ['Hale', 'Ivor'], 'a class, spec or role in its own column is not a name');
  assert.deepEqual(names('Aldric\nALDRIC\naldric'), ['Aldric'], 'a name once');
  assert.deepEqual(names('Name,Class,Role\nAldric,Warrior,Tank'), ['Aldric'], 'a header row');
  const odd = p.parsePastedRoster('Aldric\n1234\n!!!\nThis-is-fine\nX\n', { gameVersion: 'tbc' });
  assert.deepEqual(odd.entries.map((entry) => entry.names[0]), ['Aldric', 'This'], 'letters only, 2 to 12');
  assert.deepEqual(odd.ignored.map((entry) => [entry.line, entry.text]), [[2, '1234'], [3, '!!!'], [5, 'X']]);
  // Forever: "First Surname" is one name; a class after a first word is not a surname.
  const forever = p.parsePastedRoster('Thrall Stormrage, Jaina Warrior, Arthas Menethil-Realm\nGroup 3: Sylvanas Windrunner (Rogue)', { gameVersion: 'forever' });
  assert.deepEqual(forever.entries.map((entry) => entry.names), [['Thrall Stormrage', 'Thrall'], ['Jaina'], ['Arthas Menethil', 'Arthas'], ['Sylvanas Windrunner', 'Sylvanas']]);
  assert.deepEqual(p.parsePastedRoster('Thrall Stormrage', { gameVersion: 'tbc' }).entries.map((entry) => entry.names), [['Thrall']], 'TBC: a first word only');
  const big = p.parsePastedRoster(Array.from({ length: 100 }, (_, i) => `Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`).join('\n'), { gameVersion: 'tbc' });
  assert.equal(big.entries.length, 80);
  assert.equal(big.tooLong, true);
});

check('paste: the preview matches the names like the log import - a person once, guests and unknown names apart - and stores nothing', async () => {
  const s = await scenario();
  const aldric = await s.person('Aldric');
  await s.ok('gm', 'POST', '/roster', { teamId: s.tid, name: 'Aldrictwo', class: 'MAGE', mainSpec: 'Fire', offSpec: null, status: 'raider' }, 201);
  const brenna = await s.person('Brenna', { cls: 'PRIEST' });
  // Aldric gets an alt, so two of his characters can be pasted and he still counts once.
  await s.ok('gm', 'POST', `/roster/${aldric.pid}/characters`, { teamId: s.tid, name: 'Aldricalt', class: 'ROGUE', mainSpec: 'Combat', offSpec: null }, 201);
  const rid = await s.raid('2027-01-14');
  await s.exec('INSERT INTO attendance_guests (guild_id, name_key, realm_key, name, created_by, created_at) VALUES (?, ?, ?, ?, NULL, 1)', s.gid, 'visitor', 'nightslayer', 'Visitor');
  const before = await s.rows('SELECT log_mode FROM raids WHERE id = ?', rid);
  const text = ['Group 1: Aldric, Aldricalt, Brenna-Nightslayer', '3. Stranger', 'Visitor - Mage', 'Elsewhere-Otherrealm', '99 players total', '12345'].join('\n');
  const preview = await s.ok('gm', 'POST', `/raids/${rid}/manual/paste/preview`, { text }, 200);
  assert.deepEqual(preview.matched.map((m) => [m.name, m.personId]), [['Aldric', aldric.pid], ['Brenna', brenna.pid]]);
  assert.deepEqual(preview.guests, [{ name: 'Visitor' }]);
  assert.deepEqual(preview.unmatched.map((u) => u.name), ['Stranger', 'Elsewhere']);
  assert.equal(preview.unmatched[1].realm, 'Otherrealm');
  assert.deepEqual(preview.ignored.map((i) => i.text), ['12345']);
  assert.equal(preview.replacing, false);
  assert.deepEqual(await s.rows('SELECT log_mode FROM raids WHERE id = ?', rid), before, 'a preview stores nothing');
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_manual_names'))[0].n, 0);
  // Rules: the raid must have started and have no log; empty text; the right to edit.
  const future = await s.raid('2027-01-29');
  assert.equal((await s.call('gm', 'POST', `/raids/${future}/manual/paste/preview`, { text })).status, 409);
  assert.equal((await s.call('gm', 'POST', `/raids/${rid}/manual/paste/preview`, { text: '   ' })).status, 400);
  assert.equal((await s.call('gm', 'POST', `/raids/${rid}/manual/paste/preview`, { text: 'x'.repeat(20001) })).status, 400);
});

check('paste: saving sets the matched people present by hand and puts the unmatched names in the review queue, where they can be linked, added or marked as guests', async () => {
  const s = await scenario({ members: ['m1'] });
  const aldric = await s.person('Aldric', { link: 'm1' });
  const brenna = await s.person('Brenna', { cls: 'PRIEST' });
  const corwin = await s.person('Corwin', { cls: 'MAGE' });
  const rid = await s.raid('2027-01-14');
  assert.equal((await s.call('m1', 'POST', `/raids/${rid}/manual/paste`, { text: 'Aldric' })).status, 403);
  const text = 'Aldric\nBrenna\nStranger\nWanderer';
  const saved = await s.ok('gm', 'POST', `/raids/${rid}/manual/paste`, { text }, 200);
  assert.equal(saved.raid.state, 'to_review', 'the unmatched names are open work');
  assert.equal(saved.raid.manual.reason, 'Pasted raid roster');
  assert.deepEqual(saved.raid.manual.presentPlayerIds.sort(), [aldric.pid, brenna.pid].sort());
  assert.deepEqual(saved.people.map((p) => [p.name, p.outcome]).sort(), [['Aldric', 'present'], ['Brenna', 'present'], ['Corwin', 'no_signup']].sort());
  assert.deepEqual(saved.unmatched.map((u) => [u.name, u.pullsPresent]), [['Stranger', 0], ['Wanderer', 0]]);
  assert.deepEqual((await s.rows('SELECT name, name_key, realm_key FROM raid_manual_names WHERE raid_id = ? ORDER BY name_key', rid)).map((r) => [r.name, r.name_key, r.realm_key]), [['Stranger', 'stranger', 'nightslayer'], ['Wanderer', 'wanderer', 'nightslayer']]);
  const audit = (await s.audits('raid.manual'))[0];
  assert.deepEqual(JSON.parse(audit.after), { manual: true, present: 2, reason: 'Pasted raid roster', paste: true, unmatched: 2 });
  assert.equal(JSON.stringify(audit).includes('Stranger'), false, 'names are not audited');
  // The review queue lists them, with the same actions as a log name.
  const review = await s.ok('gm', 'GET', `/attendance/review?team=${s.tid}`);
  const group = review.raids.find((entry) => entry.raid.id === rid);
  assert.deepEqual(group.items.filter((i) => i.kind === 'unmatched').map((i) => [i.name, i.pullsPresent]), [['Stranger', 0], ['Wanderer', 0]]);
  // Mark Stranger a guest, add Wanderer as a new person: Wanderer then counts present.
  const key = (name) => group.items.find((i) => i.name === name).key;
  await s.ok('gm', 'POST', `/raids/${rid}/unmatched`, { key: key('Stranger'), action: 'guest' }, 200);
  await s.ok('gm', 'POST', `/raids/${rid}/unmatched`, { key: key('Wanderer'), action: 'person', class: 'ROGUE', status: 'raider' }, 200);
  const after = await s.ok('gm', 'GET', `/raids/${rid}`);
  assert.deepEqual(after.unmatched, [], 'nothing left to review');
  assert.equal(after.people.find((p) => p.name === 'Wanderer').outcome, 'present', 'the pasted name counts for the person once it has one');
  assert.equal(after.people.find((p) => p.name === 'Corwin').outcome, 'no_signup');
  void corwin;
  // Pasting again replaces who is present and the waiting names; removing the hand-entered attendance takes the names with it.
  const again = await s.ok('gm', 'POST', `/raids/${rid}/manual/paste`, { text: 'Corwin\nNewcomer', reason: 'Second paste' }, 200);
  assert.deepEqual(again.raid.manual.presentPlayerIds, [corwin.pid]);
  assert.deepEqual(again.unmatched.map((u) => u.name), ['Newcomer']);
  assert.equal(again.raid.manual.reason, 'Second paste');
  await s.ok('gm', 'DELETE', `/raids/${rid}/manual`, { reason: 'We found the log' }, 200);
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raid_manual_names'))[0].n, 0);
  // A raid with a report refuses; so does one that has not started; and a paste with no usable line.
  assert.equal((await s.call('gm', 'POST', `/raids/${rid}/manual/paste`, { text: '12345\n!!!' })).status, 400);
});

check('paste: a Forever guild matches a first word to the one character with it - and leaves two Jainas for review', async () => {
  const s = await scenario({ version: 'forever' });
  const thrall = await s.person('Thrall Stormrage');
  await s.person('Jaina Proudmoore', { cls: 'MAGE' });
  await s.person('Jaina Windrunner', { cls: 'MAGE' });
  const arthas = await s.person('Arthas Menethil', { cls: 'PRIEST' });
  const rid = await s.raid('2027-01-14');
  const preview = await s.ok('gm', 'POST', `/raids/${rid}/manual/paste/preview`, { text: 'Thrall, Jaina, Arthas Menethil, Sylvanas Windrunner, Kelthuzad Warlock' }, 200);
  assert.deepEqual(preview.matched.map((m) => m.name), ['Thrall Stormrage', 'Arthas Menethil']);
  assert.deepEqual(preview.unmatched.map((u) => u.name), ['Jaina', 'Sylvanas Windrunner', 'Kelthuzad']);
  const saved = await s.ok('gm', 'POST', `/raids/${rid}/manual/paste`, { text: 'Thrall, Jaina, Arthas Menethil' }, 200);
  assert.deepEqual(saved.raid.manual.presentPlayerIds.sort(), [thrall.pid, arthas.pid].sort());
  assert.deepEqual(saved.unmatched.map((u) => u.name), ['Jaina']);
  // The review queue acts on a two-word name like on any other: a guest, or a new person.
  const full = await s.ok('gm', 'POST', `/raids/${rid}/manual/paste`, { text: 'Thrall\nSylvanas Windrunner\nKael Thas' }, 200);
  const key = (name) => full.unmatched.find((u) => u.name === name).key;
  assert.equal(key('Sylvanas Windrunner'), 'sylvanas windrunner|');
  await s.ok('gm', 'POST', `/raids/${rid}/unmatched`, { key: key('Sylvanas Windrunner'), action: 'guest' }, 200);
  await s.ok('gm', 'POST', `/raids/${rid}/unmatched`, { key: key('Kael Thas'), action: 'person', class: 'MAGE', status: 'raider' }, 200);
  const made = await s.ok('gm', 'GET', `/raids/${rid}`);
  assert.deepEqual(made.unmatched, []);
  assert.equal(made.people.find((p) => p.name === 'Kael Thas').outcome, 'present');
  assert.deepEqual((await s.rows('SELECT name, name_key FROM attendance_guests')).map((r) => [r.name, r.name_key]), [['Sylvanas Windrunner', 'sylvanas windrunner']]);
});

// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(error && error.stack ? error.stack : error).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
