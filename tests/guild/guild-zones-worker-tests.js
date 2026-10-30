/**
 * Raidsmith raid zones - Worker tests: the zone parser (and its page copy), migration 0042, create / Raid settings / event / log writes with the
 * hand > log > event precedence, the daily fill, the event fallbacks (description, channel) and the size of a multi-zone raid.
 * Run: node tests/guild/guild-zones-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/guild-world.js); Raid-Helper and Warcraft Logs are tools/fake-sources.js on a local port.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { load, adminOf, makeWorld, signIn, ROOT, person } = require('../guild-world');
const { createD1Fake } = require('../d1-fake');

const SERVER = '900000000000000071';
const HOUR = 3600000;
const EVENT_START_MS = 1_789_000_000 * 1000; // tools/fake-sources.js EVENT_START
const EVENT = '111111111111111111';
const REPORT = 'Fake000000000001'; // zone 'Gruul / Magtheridon'
const REPORT2 = 'Fake000000000002';
const REPORT_KZ = 'Fake000000000003'; // zone 'Karazhan' (a week earlier)

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const filter = process.argv[2] || '';

// ---------------------------------------------------------------------------
// Pure

const LIVE_TITLES = [
  ['Team KJ Friday - BT & Hyjal', ['Black Temple', 'Hyjal Summit']],
  ['Team KJ Saturday - BT & Hyjal cleanup', ['Black Temple', 'Hyjal Summit']],
  ['KJ BT Clean up and Hyjal', ['Black Temple', 'Hyjal Summit']],
  ['KJ BT', ['Black Temple']],
  ['Team KJ Friday - Black Temple', ['Black Temple']],
  ['BT / Hyjal', ['Black Temple', 'Hyjal Summit']],
  ['Hyjal + BT', ['Hyjal Summit', 'Black Temple']],
  ['Team Illidan Sunday', []],
  ['Kil\'jaeden Illidan Vashj Kael Archimonde', []],
  ['tbc-team-kil’jaeden-fri-sat', []],
  ['tbc-team-illidan-sun', []],
  ['Gruuls + Magtheridon', ["Gruul's Lair", "Magtheridon's Lair"]],
  ['gruul\'s lair', ["Gruul's Lair"]],
  ['GRUUL’S Mags', ["Gruul's Lair", "Magtheridon's Lair"]],
  ['ZulAman / zul\'aman / Zul’Aman', ["Zul'Aman"]],
  ['za, kara; ssc and the eye', ["Zul'Aman", 'Karazhan', 'Serpentshrine Cavern']],
  ['Mount Hyjal clear', ['Hyjal Summit']],
  ['mh', ['Hyjal Summit']],
  ['sunwell swp', ['Sunwell Plateau']],
  ['Karazhan then Gruul then Mag then SSC', ['Karazhan', "Gruul's Lair", "Magtheridon's Lair"]],
  ['bat tent btw', []], // whole words only
  ['', []],
];

check('parser: live titles, aliases, apostrophes, separators, boss names never match, at most 3 zones, first-appearance order', async () => {
  const z = await load('worker/raid-zones.js');
  for (const [text, expected] of LIVE_TITLES) assert.deepEqual(z.parseZones(text, 'tbc'), expected, `"${text}"`);
  assert.deepEqual(z.parseZones(null, 'tbc'), []);
  assert.deepEqual(z.parseZones('BT', 'nope'), []);
  assert.deepEqual(z.parseZones('MC + Ony + BWL', 'classic'), ['Molten Core', "Onyxia's Lair", 'Blackwing Lair']);
  assert.deepEqual(z.parseZones('aq20 aq40 naxx zg', 'classic'), ["Ruins of Ahn'Qiraj", "Temple of Ahn'Qiraj", 'Naxxramas']);
  assert.deepEqual(z.parseZones('Barrow + mh + Onyxia', 'forever'), ['Barrow Deeps', 'Hyjal Summit', "Onyxia's Lair"]);
  assert.deepEqual(z.parseZones('BT', 'classic'), [], 'a TBC short name is nothing in Classic');
  // Stored values.
  assert.deepEqual(z.splitZoneValue('Black Temple + Hyjal Summit', 'tbc'), ['Black Temple', 'Hyjal Summit']);
  assert.deepEqual(z.splitZoneValue('Karazhan', 'tbc'), ['Karazhan']);
  assert.deepEqual(z.splitZoneValue('Some Free Text', 'tbc'), []);
  assert.deepEqual(z.splitZoneValue(null, 'tbc'), []);
  assert.equal(z.joinZones(['A', 'B']), 'A + B');
  assert.equal(z.joinZones([]), null);
  assert.equal(z.MAX_ZONES, 3);
});

check('parser: the three longest canonical names of every version joined with " + " fit the 60-character column', async () => {
  const z = await load('worker/raid-zones.js');
  for (const version of ['tbc', 'classic', 'forever']) {
    const longest = [...z.zonesFor(version)].sort((a, b) => b.length - a.length).slice(0, z.MAX_ZONES);
    assert((z.joinZones(longest) || '').length <= 60, `${version}: ${z.joinZones(longest)}`);
  }
});

function pageZones() {
  const sandbox = {};
  vm.createContext(sandbox);
  for (const file of ['catalog', 'tbc', 'classic', 'forever']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'rules', `${file}.js`), 'utf8'), sandbox);
  sandbox.window = sandbox;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'guild', 'zones.js'), 'utf8'), sandbox);
  return { zones: sandbox.Guild.zones, rules: sandbox.RulesData };
}

check('page copy js/guild/zones.js: the same alias tables, the same results on every fixture, zonesFor = the Worker zone list, listed in the manifest', async () => {
  const z = await load('worker/raid-zones.js');
  const { zones: page } = pageZones();
  assert.deepEqual(JSON.parse(JSON.stringify(page.ALIASES)), z.ZONE_ALIASES, 'one alias table, two copies');
  assert.equal(page.MAX_ZONES, z.MAX_ZONES);
  const fixtures = [...LIVE_TITLES.map(([text]) => text), '1 2 3 4 5', 'kara gruul mag ssc tk za hyjal bt swp', 'Gruul / Magtheridon', 'Black Temple + Hyjal Summit'];
  for (const version of ['tbc', 'classic', 'forever']) {
    for (const text of [...fixtures, 'mc ony bwl zg aq20 aq40 naxx', 'barrow mh onyxia', 'Molten Core']) {
      const expected = z.parseZones(text, version);
      assert.deepEqual(Array.from(page.parse(text, version)), expected, `${version}: "${text}"`);
      assert.deepEqual(Array.from(page.split(text, version)), z.splitZoneValue(text, version));
    }
    assert.deepEqual(Array.from(page.zonesFor(version)), z.zonesFor(version), `${version}: zonesFor`);
    for (const zone of z.zonesFor(version)) assert(Object.hasOwn(z.ZONE_ALIASES[version], zone), `${version}: ${zone} has an alias entry`);
  }
  assert.equal(page.join(['A', 'B']), 'A + B');
  assert.equal(page.join([]), null);
  assert.deepEqual(Array.from(page.parse('za kara gruul mag', 'tbc')), ["Zul'Aman", 'Karazhan', "Gruul's Lair"], 'capped at 3');
  const { GUILD_MANIFEST } = require('../guild-scripts');
  assert(GUILD_MANIFEST.includes('/js/guild/zones.js'));
});

check('size: a raid of several zones is as big as its largest zone; the team size when a zone is unknown', async () => {
  const z = await load('worker/raid-zones.js');
  assert.equal(z.zoneSize('tbc', 'Karazhan + Zul\'Aman'), 10);
  assert.equal(z.zoneSize('tbc', 'Karazhan + Black Temple'), 25);
  assert.equal(z.zoneSize('tbc', 'Karazhan'), 10);
  assert.equal(z.zoneSize('tbc', 'Gruul / Magtheridon'), 25, 'an old multi-zone log text maps too');
  assert.equal(z.zoneSize('tbc', 'Eye of Eternity'), null);
  assert.equal(z.effectiveRaidSize({ size: null, zone: 'Karazhan + Black Temple' }, 20, 'tbc'), 25);
  assert.equal(z.effectiveRaidSize({ size: 10, zone: 'Karazhan + Black Temple' }, 20, 'tbc'), 10, 'the raid\'s own size wins');
  assert.equal(z.effectiveRaidSize({ size: null, zone: 'Free text' }, 20, 'tbc'), 20);
  assert.deepEqual(z.inferEventZones({ title: 'Team KJ', description: 'BT tonight', channelName: 'hyjal' }, 'tbc'), ['Black Temple'], 'the description when the title says nothing');
  assert.deepEqual(z.inferEventZones({ title: 'Team KJ', description: 'Please come prepared', channelName: 'tbc-hyjal-fri' }, 'tbc'), ['Hyjal Summit'], 'the channel last');
  assert.deepEqual(z.inferEventZones({ title: '', displayTitle: 'KJ BT', description: 'ssc' }, 'tbc'), ['Black Temple'], 'the display title when the title is empty');
  assert.deepEqual(z.inferEventZones({ title: 'KJ', description: 'Please come prepared with consumes...', channelName: 'tbc-team-kil’jaeden-fri-sat' }, 'tbc'), []);
});

// ---------------------------------------------------------------------------
// Migration 0042

check('migration 0042: zone_source is nullable with a CHECK; raids with a zone backfill to log (a report row) or hand; the previous INSERT still works', async () => {
  const sql = fs.readFileSync(path.join(ROOT, 'migrations', '0042_raid_zone_source.sql'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zones-0042-'));
  for (const f of fs.readdirSync(path.join(ROOT, 'migrations'))) if (/^\d{4}_.*\.sql$/.test(f) && f < '0042') fs.copyFileSync(path.join(ROOT, 'migrations', f), path.join(dir, f));
  const db = createD1Fake({ migrationsDir: dir }).sqlite;
  fs.rmSync(dir, { recursive: true, force: true });
  db.exec('PRAGMA foreign_keys = OFF'); // only the two tables under test get rows
  const raid = (id, day, zone) => db.prepare(
    "INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, log_mode, open_flags, policy_fp, version, created_by, created_at, updated_at) VALUES (?, 'g_1', 't_1', ?, 1, ?, 'log', 0, '', 1, 'u_1', 1, 1)",
  ).run(id, day, zone);
  raid('r_log', '2026-01-01', 'Karazhan');
  raid('r_hand', '2026-01-02', 'Karazhan');
  raid('r_none', '2026-01-03', null);
  db.prepare("INSERT INTO raid_reports (guild_id, raid_id, code, flavour, started_at, ended_at, synced_at) VALUES ('g_1', 'r_log', 'abcdefghij123456', 'fresh', 1, 2, 3)").run();
  db.exec(sql);
  const rows = Object.fromEntries(db.prepare('SELECT id, zone_source FROM raids').all().map((r) => [r.id, r.zone_source]));
  assert.deepEqual(rows, { r_log: 'log', r_hand: 'hand', r_none: null });
  raid('r_old', '2026-01-04', 'Karazhan'); // the previous release's INSERT does not name the column
  assert.equal(db.prepare("SELECT zone_source FROM raids WHERE id = 'r_old'").get().zone_source, null);
  assert.throws(() => db.exec("UPDATE raids SET zone_source = 'nope' WHERE id = 'r_old'"), /CHECK/);
  for (const ok of ['hand', 'event', 'log', null]) db.prepare("UPDATE raids SET zone_source = ? WHERE id = 'r_old'").run(ok);
});

// ---------------------------------------------------------------------------
// Worker

async function scenario({ clock = null } = {}) {
  const { createFakeSources } = require('../../tools/fake-sources.js');
  const fake = createFakeSources({ serverId: SERVER });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  const w = await makeWorld({
    wrapFetch: (discordFetch) => (url, init) => (String(url).startsWith(base) ? fetch(url, init) : discordFetch(url, init)),
    env: { WCL_CLIENT_ID: 'a', WCL_CLIENT_SECRET: 'b', WCL_API_BASE: base, RAID_HELPER_API_BASE: base },
  });
  if (clock) w.clock.now = clock;
  const gm = (await signIn(w, person(1, 'Zonegm'), [adminOf(SERVER)])).jar;
  const made = await w.call(gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Zone Guild', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'UTC', multipleTeams: false,
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tid = made.json.teams[0].id;
  const { resetWclTokenCache } = await load('worker/sources.js');
  resetWclTokenCache();
  const s = {
    w, fake, gid, tid, gm, base: `/api/guild/${gid}`,
    async call(method, tail, body) { w.advance(1000); return w.call(gm, method, `${s.base}${tail}`, body); },
    async ok(method, tail, body, status) {
      const res = await s.call(method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${method} ${tail}: ${res.text}`);
      return res.json;
    },
    // A hand-made raid on the event's night (so an event or a log can be attached without a "same night" question).
    async raid(extra = {}) {
      const { localDate } = await load('worker/attendance-calendar.js');
      const res = await s.ok('POST', '/raids', { teamId: tid, raidOn: localDate(EVENT_START_MS, 'UTC'), startTime: '00:26', ...extra });
      return res.raid.id;
    },
    row: async (rid) => (await w.rows('SELECT zone, zone_source, size FROM raids WHERE id = ?', rid))[0],
    setTitle(title, extra = {}) { Object.assign(fake.state.events[EVENT], { title, displayTitle: title, ...extra }); },
    async close() { await new Promise((resolve) => fake.server.close(resolve)); },
    async run(cron) {
      const { runCron } = await load('worker/scheduler.js');
      const { defaultRandomBytes } = await load('worker/ids.js');
      return runCron({ cron, db: w.db, env: w.env, fetch: w.fetch, now: () => w.clock.now, randomBytes: defaultRandomBytes, log: () => {} });
    },
  };
  return s;
}

const withScenario = (fn, options) => async () => {
  const s = await scenario(options);
  try { await fn(s); } finally { await s.close(); }
};

check('create: zones (de-duplicated, 1 to 3, the version\'s names) are stored joined with source hand; the legacy single zone still works; too many, unknown and empty are 400 on zones', withScenario(async (s) => {
  const made = await s.ok('POST', '/raids', { teamId: s.tid, raidOn: '2026-05-01', zones: ['Black Temple', 'Hyjal Summit', 'Black Temple'] });
  assert.deepEqual(await s.row(made.raid.id), { zone: 'Black Temple + Hyjal Summit', zone_source: 'hand', size: null });
  const detail = await s.ok('GET', `/raids/${made.raid.id}`);
  assert.deepEqual([detail.raid.zone, detail.raid.zones, detail.raid.zoneSource], ['Black Temple + Hyjal Summit', ['Black Temple', 'Hyjal Summit'], 'hand']);
  assert.equal(detail.raid.size, 25);
  const legacy = await s.ok('POST', '/raids', { teamId: s.tid, raidOn: '2026-05-02', zone: 'Karazhan' });
  assert.deepEqual(await s.row(legacy.raid.id), { zone: 'Karazhan', zone_source: 'hand', size: null });
  assert.equal((await s.ok('GET', `/raids/${legacy.raid.id}`)).raid.size, 10);
  const plain = await s.ok('POST', '/raids', { teamId: s.tid, raidOn: '2026-05-03' });
  assert.deepEqual(await s.row(plain.raid.id), { zone: null, zone_source: null, size: null });
  for (const zones of [['Karazhan', "Gruul's Lair", 'Black Temple', 'Hyjal Summit'], ['Narnia'], [], 'Karazhan', [1]]) {
    const res = await s.call('POST', '/raids', { teamId: s.tid, raidOn: '2026-05-04', zones });
    assert.deepEqual([res.status, res.json.field], [400, 'zones'], JSON.stringify(zones));
  }
  const bad = await s.call('POST', '/raids', { teamId: s.tid, raidOn: '2026-05-04', zone: 'Narnia' });
  assert.deepEqual([bad.status, bad.json.field], [400, 'zone']);
  const list = await s.ok('GET', `/raids?team=${s.tid}`);
  const row = list.raids.find((r) => r.id === made.raid.id) || list.upcoming.find((r) => r.id === made.raid.id);
  assert.deepEqual([row.zones, row.zoneSource], [['Black Temple', 'Hyjal Summit'], 'hand']);
}));

check('create with an event and no zones: inferred from the event (source event); the officer\'s zones beat it; a title naming nothing falls back to description, then channel; nothing found = no zone', withScenario(async (s) => {
  s.setTitle('Team KJ Friday - BT & Hyjal');
  let made = await s.ok('POST', '/raids', { teamId: s.tid, eventSource: EVENT });
  assert.deepEqual(await s.row(made.raid.id), { zone: 'Black Temple + Hyjal Summit', zone_source: 'event', size: null });
  await s.ok('DELETE', `/raids/${made.raid.id}`, {});
  made = await s.ok('POST', '/raids', { teamId: s.tid, eventSource: EVENT, zones: ['Karazhan'] });
  assert.deepEqual(await s.row(made.raid.id), { zone: 'Karazhan', zone_source: 'hand', size: null });
  await s.ok('DELETE', `/raids/${made.raid.id}`, {});
  s.setTitle('Team KJ', { description: 'Hyjal only tonight', channelName: 'ssc' });
  made = await s.ok('POST', '/raids', { teamId: s.tid, eventSource: EVENT });
  assert.equal((await s.row(made.raid.id)).zone, 'Hyjal Summit', 'description');
  await s.ok('DELETE', `/raids/${made.raid.id}`, {});
  s.setTitle('Team KJ', { description: 'Please come prepared with consumes...', channelName: 'tbc-ssc-fri' });
  made = await s.ok('POST', '/raids', { teamId: s.tid, eventSource: EVENT });
  assert.equal((await s.row(made.raid.id)).zone, 'Serpentshrine Cavern', 'channel');
  await s.ok('DELETE', `/raids/${made.raid.id}`, {});
  s.setTitle('Team KJ', { description: 'Please come prepared with consumes...', channelName: 'tbc-team-kil’jaeden-fri-sat' });
  made = await s.ok('POST', '/raids', { teamId: s.tid, eventSource: EVENT });
  assert.deepEqual(await s.row(made.raid.id), { zone: null, zone_source: null, size: null }, 'boss names and team names are nothing');
}));

check('create with a report and no zones: the report zone mapped to canonical names (source log); raw text kept when it maps to nothing; an event wins over the report', withScenario(async (s) => {
  let made = await s.ok('POST', '/raids', { teamId: s.tid, reportSource: REPORT });
  assert.deepEqual(await s.row(made.raid.id), { zone: "Gruul's Lair + Magtheridon's Lair", zone_source: 'log', size: null });
  await s.ok('DELETE', `/raids/${made.raid.id}`, {});
  s.fake.state.events[EVENT].title = 'Fake Event';
  Object.assign(s.fake.state.events[EVENT], { displayTitle: 'Fake Event', description: null, channelName: null });
  made = await s.ok('POST', '/raids', { teamId: s.tid, reportSource: REPORT, eventSource: EVENT });
  assert.deepEqual(await s.row(made.raid.id), { zone: "Gruul's Lair + Magtheridon's Lair", zone_source: 'log', size: null }, 'the event says nothing: the log');
  await s.ok('DELETE', `/raids/${made.raid.id}`, {});
  s.setTitle('Fake Karazhan');
  made = await s.ok('POST', '/raids', { teamId: s.tid, reportSource: REPORT, eventSource: EVENT });
  assert.deepEqual(await s.row(made.raid.id), { zone: 'Karazhan', zone_source: 'event', size: null }, 'the event is inferred before the log at creation');
}));

check('settings: zones set at any time (a past raid too), replaced, [] clears (nothing refills it), a key left out is kept, 400 on bad input; the audit names the zones', withScenario(async (s) => {
  const past = await s.ok('POST', '/raids', { teamId: s.tid, raidOn: '2025-01-01', reportSource: REPORT_KZ, acceptOtherServer: true }, 201);
  assert.deepEqual(await s.row(past.raid.id), { zone: 'Karazhan', zone_source: 'log', size: null });
  let reply = await s.ok('PATCH', `/raids/${past.raid.id}`, { zones: ['Karazhan', "Zul'Aman"] });
  assert.deepEqual([reply.raid.zone, reply.raid.zones, reply.raid.zoneSource, reply.raid.size], ['Karazhan + Zul\'Aman', ['Karazhan', "Zul'Aman"], 'hand', 10]);
  reply = await s.ok('PATCH', `/raids/${past.raid.id}`, { guestsOpen: true });
  assert.deepEqual([reply.raid.zone, reply.raid.zoneSource], ['Karazhan + Zul\'Aman', 'hand'], 'a key left out is kept');
  reply = await s.ok('PATCH', `/raids/${past.raid.id}`, { zones: [] });
  assert.deepEqual([reply.raid.zone, reply.raid.zones, reply.raid.zoneSource], [null, [], 'hand']);
  await s.run('17 4 * * *');
  assert.deepEqual(await s.row(past.raid.id), { zone: null, zone_source: 'hand', size: null }, 'nothing refills a cleared zone');
  for (const zones of [null, ['Narnia'], ['Karazhan', "Gruul's Lair", 'Black Temple', 'Hyjal Summit'], 'Karazhan']) {
    const res = await s.call('PATCH', `/raids/${past.raid.id}`, { zones });
    assert.deepEqual([res.status, res.json.field], [400, 'zones'], JSON.stringify(zones));
  }
  const audits = await s.w.rows("SELECT before, after FROM audit_log WHERE guild_id = ? AND action = 'raid.settings' ORDER BY created_at, id", s.gid);
  assert.deepEqual(audits.map((a) => JSON.parse(a.after).zone), ["Karazhan + Zul'Aman", undefined, null]);
  const view = await load('worker/audit-view.js');
  assert(JSON.stringify(view).length > 0);
  const log = await s.ok('GET', '/audit');
  const text = JSON.stringify(log);
  assert(/zones Karazhan \+ Zul'Aman/.test(text) && /no zones/.test(text), text.slice(0, 600));
}));

check('event link and refresh: infers when the source is null or event, re-infers on a title change, never touches hand or log, leaves the zone when nothing is found', withScenario(async (s) => {
  s.setTitle('Fake Karazhan');
  const rid = await s.raid();
  await s.ok('PUT', `/raids/${rid}/event`, { source: EVENT });
  assert.deepEqual(await s.row(rid), { zone: 'Karazhan', zone_source: 'event', size: null });
  // The cron refresh re-infers after a title change (the raid starts after the clock in this world).
  s.setTitle('Team KJ Friday - BT & Hyjal');
  s.w.clock.now += 13 * HOUR;
  assert.equal((await s.run('*/15 * * * *')).refresh.refreshed, 1);
  assert.deepEqual(await s.row(rid), { zone: 'Black Temple + Hyjal Summit', zone_source: 'event', size: null });
  s.setTitle('Team KJ');
  s.w.clock.now += 13 * HOUR;
  assert.equal((await s.run('*/15 * * * *')).refresh.refreshed, 1);
  assert.deepEqual(await s.row(rid), { zone: 'Black Temple + Hyjal Summit', zone_source: 'event', size: null }, 'nothing found: left as it is');
  // Hand beats the event in both orders.
  await s.ok('PATCH', `/raids/${rid}`, { zones: ['Sunwell Plateau'] });
  s.setTitle('KJ SSC');
  s.w.clock.now += 13 * HOUR;
  assert.equal((await s.run('*/15 * * * *')).refresh.refreshed, 1);
  assert.deepEqual(await s.row(rid), { zone: 'Sunwell Plateau', zone_source: 'hand', size: null }, 'a later event never replaces a hand zone');
  await s.ok('PUT', `/raids/${rid}/event`, { source: EVENT, moveRaid: true });
  assert.equal((await s.row(rid)).zone, 'Sunwell Plateau', 're-linking keeps it too');
  await s.ok('DELETE', `/raids/${rid}`, {}); // the team has one raid a day
  const old = await s.raid();
  s.w.db.sqlite.prepare("UPDATE raids SET zone = 'Karazhan', zone_source = 'log' WHERE id = ?").run(old);
  s.setTitle('Fake Karazhan BT');
  await s.ok('PUT', `/raids/${old}/event`, { source: EVENT });
  assert.deepEqual(await s.row(old), { zone: 'Karazhan', zone_source: 'log', size: null }, 'log beats event');
}, { clock: EVENT_START_MS - 5 * 24 * HOUR }));

check('log attach: replaces an event zone (source log, mapped names), never a hand zone; raw text kept when it maps to nothing; the reply carries zones', withScenario(async (s) => {
  s.setTitle('Fake Karazhan');
  const rid = await s.raid();
  await s.ok('PUT', `/raids/${rid}/event`, { source: EVENT });
  assert.equal((await s.row(rid)).zone_source, 'event');
  await s.ok('PUT', `/raids/${rid}/reports`, { source: REPORT });
  assert.deepEqual(await s.row(rid), { zone: "Gruul's Lair + Magtheridon's Lair", zone_source: 'log', size: null }, 'log replaces event');
  const detail = await s.ok('GET', `/raids/${rid}`);
  assert.deepEqual([detail.raid.zones, detail.raid.zoneSource], [["Gruul's Lair", "Magtheridon's Lair"], 'log']);
  // A later event title never replaces the log zone.
  await s.ok('PUT', `/raids/${rid}/event`, { source: EVENT });
  assert.equal((await s.row(rid)).zone, "Gruul's Lair + Magtheridon's Lair");
  // Hand beats the log.
  const hand = await s.raid({ raidOn: '2026-05-11', zones: ['Black Temple'] });
  await s.ok('PUT', `/raids/${hand}/reports`, { source: REPORT2, confirmFar: true });
  assert.deepEqual(await s.row(hand), { zone: 'Black Temple', zone_source: 'hand', size: null }, 'a log never replaces a hand zone');
  // Null source with a zone (previous release): the log replaces it too.
  const legacy = await s.raid({ raidOn: '2026-05-12' });
  s.w.db.sqlite.prepare("UPDATE raids SET zone = 'Eye of Eternity', zone_source = NULL WHERE id = ?").run(legacy);
  await s.ok('PUT', `/raids/${legacy}/reports`, { source: REPORT_KZ, confirmFar: true });
  assert.deepEqual(await s.row(legacy), { zone: 'Karazhan', zone_source: 'log', size: null });
}));

check('daily cron: fills raids with an event title but no zone and no source (source event), idempotent, bounded, leaves everything else alone', withScenario(async (s) => {
  const mk = async (day, title, zone = null, source = null) => {
    const rid = await s.raid({ raidOn: day });
    s.w.db.sqlite.prepare('UPDATE raids SET event_title = ?, zone = ?, zone_source = ? WHERE id = ?').run(title, zone, source, rid);
    return rid;
  };
  const a = await mk('2026-06-01', 'Team KJ Friday - BT & Hyjal');
  const b = await mk('2026-06-02', 'Team KJ');
  const c = await mk('2026-06-03', 'KJ SSC', 'Karazhan', 'hand');
  const d = await mk('2026-06-04', 'KJ SSC', null, 'hand'); // cleared by an officer
  const e = await mk('2026-06-05', null);
  await s.run('17 4 * * *');
  assert.deepEqual(await s.row(a), { zone: 'Black Temple + Hyjal Summit', zone_source: 'event', size: null });
  for (const [rid, zone, source] of [[b, null, 'event'], [c, 'Karazhan', 'hand'], [d, null, 'hand'], [e, null, null]]) assert.deepEqual(await s.row(rid), { zone, zone_source: source, size: null });
  await s.run('17 4 * * *'); // idempotent
  assert.equal((await s.row(a)).zone, 'Black Temple + Hyjal Summit');
  // Bounded: 205 raids to fill, one run looks at 200 (the newest first).
  const sqlite = s.w.db.sqlite;
  const stamp = sqlite.prepare('SELECT raid_on, starts_at FROM raids WHERE id = ?').get(b);
  const insert = sqlite.prepare("INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, event_title, log_mode, open_flags, policy_fp, version, created_by, created_at, updated_at) SELECT ?, guild_id, team_id, ?, ?, 'BT', 'log', 0, '', 1, created_by, 1, 1 FROM raids WHERE id = ?");
  for (let i = 0; i < 205; i++) insert.run(`r_bulk${String(i).padStart(3, '0')}`, new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), stamp.starts_at - (i + 1) * 100000, b);
  await s.run('17 4 * * *');
  const filled = sqlite.prepare("SELECT COUNT(*) AS n FROM raids WHERE id LIKE 'r_bulk%' AND zone = 'Black Temple'").get().n;
  assert.equal(filled, 200, '200 looked at, all bulk: Team KJ (names nothing) was stamped event on the first run and takes no slot');
  await s.run('17 4 * * *');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM raids WHERE id LIKE 'r_bulk%' AND zone = 'Black Temple'").get().n, 205);
}));

check('replies: the Raids list, the raid page and Home carry zone, zones and zoneSource; an unknown stored text gives zones []', withScenario(async (s) => {
  const rid = await s.raid({ zones: ['Karazhan', 'Black Temple'] });
  s.w.db.sqlite.prepare("UPDATE raids SET zone = 'Eye of Eternity', zone_source = 'log' WHERE id = ?").run(rid);
  const detail = await s.ok('GET', `/raids/${rid}`);
  assert.deepEqual([detail.raid.zone, detail.raid.zones, detail.raid.zoneSource], ['Eye of Eternity', [], 'log']);
  s.w.db.sqlite.prepare("UPDATE raids SET zone = 'Karazhan + Black Temple', zone_source = 'hand' WHERE id = ?").run(rid);
  const home = await s.ok('GET', '/attention');
  void home; // the Home week raids share raidZoneFields with the list (the contract suites render them)
  const { raidZoneFields } = await load('worker/raid-zones.js');
  assert.deepEqual(raidZoneFields({ zone: 'BT / Hyjal', zone_source: 'event' }, 'tbc'), { zones: ['Black Temple', 'Hyjal Summit'], zoneSource: 'event' });
  assert.deepEqual(raidZoneFields({ zone: null }, 'tbc'), { zones: [], zoneSource: null });
}));

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
      console.log(`FAIL  ${name}\n      ${String((error && error.stack) || error).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
