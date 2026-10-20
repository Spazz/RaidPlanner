/**
 * Raidsmith guild tracker - PM wave 7 Worker tests (read-only API keys with CSV and JSON links, the team progress board, the rank ladder).
 * Run: node tests/guild/guild-wave7-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/guild-world.js) with a fixed clock. The pure rules (CSV escaping, progress maths, the
 * ladder's rule evaluation) are pinned directly; the routes and the SQL run over HTTP. Nothing touches the network.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, adminOf, memberOf, makeWorld, signIn } = require('../guild-world');

const SERVER = '900000000000000071';
const person = (n, name) => ({ id: `1100000000000007${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(1, 'Gmseven'), m1: person(3, 'Memberone'), m2: person(4, 'Membertwo') };
const NOW = 1_800_000_000_000; // 2027-01-15T08:00Z (Friday 03:00 in New York)
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Sixteen Tuesdays (US reset day), 2026-09-29 .. 2027-01-12; today is Friday 2027-01-15, so the 8-week window starts 2026-11-24 (index 8).
const TUESDAYS = Array.from({ length: 16 }, (_, i) => new Date(Date.UTC(2026, 8, 29) + i * 7 * DAY).toISOString().slice(0, 10));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// RFC 4180 reader, enough to check the writer: -> [[cell]]
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += c;
  }
  assert.equal(cell, '', 'the file ends with a line break');
  return rows;
}
const tableOf = (text) => { const [head, ...rows] = parseCsv(text); return rows.map((cells) => Object.fromEntries(head.map((name, i) => [name, cells[i]]))); };

// A guild with a Guild Master, members (signed in), a team "Alpha" (a second, "Bravo", when teams = 2) in the America/New_York zone.
async function scenario({ members = [], teams = 1 } = {}) {
  const w = await makeWorld();
  w.clock.now = NOW;
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Wave Seven', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York',
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
  let codeN = 0;
  const s = {
    w, gid, tids, tid: tids[0], jars, uids, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) { w.advance(1000); return w.call(jars[who], method, `${s.base}${tail}`, body); },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    // The open data API: no cookie, the key in the address (CSV) or a header.
    api(path, { token, bearer, jar = {} } = {}) {
      const url = token ? `${path}${path.includes('?') ? '&' : '?'}key=${token}` : path;
      return w.call(jar, 'GET', url, undefined, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {});
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    exec: (sql, ...values) => w.db.prepare(sql).bind(...values).run(),
    async person(name, { team = tids[0], cls = 'WARRIOR', status = 'raider', joinedOn = '2026-09-01', link = null } = {}) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId: team, name, class: cls, mainSpec: { WARRIOR: 'Arms', MAGE: 'Fire', PRIEST: 'Holy' }[cls], offSpec: null, status, joinedOn, ...(link ? { linkUserId: uids[link] } : {}) });
      return { pid: res.person.id, cid: res.characters[0].id };
    },
    async raid(raidOn, { team = tids[0], zone = "Gruul's Lair", title } = {}) {
      const res = await s.ok('gm', 'POST', '/raids', { teamId: team, raidOn, startTime: '20:00', zone, ...(title ? { title } : {}) });
      return res.raid.id;
    },
    attend(raidId, pid, outcome, credit, team = tids[0]) {
      return s.exec('INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, ?, ?)', raidId, gid, team, pid, outcome, credit, credit > 0 ? 1 : 0);
    },
    // A report on a raid and its boss pulls: [{ fight, enc, name, kill, start, end }] (ms since the raid's t0).
    pulls(raidId, t0, list, code = null) {
      const report = code || `Rep${String(++codeN).padStart(13, '0')}`;
      s.exec("INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES (?, ?, ?, 'fresh', ?, ?, 'uploader', 1)", raidId, gid, report, t0, t0 + 6 * HOUR);
      for (const p of list) {
        s.exec('INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          raidId, report, p.fight, p.enc, p.name, p.kill ? 1 : 0, t0 + p.start, t0 + p.end);
      }
      return report;
    },
    async makeKey(body = {}) {
      const res = await s.ok('gm', 'POST', '/api-keys', { name: 'Sheet', teamId: null, datasets: ['roster', 'attendance', 'loot', 'raids'], expiresIn: '90d', ...body }, 201);
      return { id: res.created.id, token: res.created.token, list: res };
    },
    async audits(action) { return s.rows('SELECT actor_user_id, entity_type, entity_id, before, after FROM audit_log WHERE guild_id = ? AND action = ? ORDER BY created_at, id', gid, action); },
    async setPolicy(policy) {
      const view = await s.ok('gm', 'GET', '/attendance/policy');
      return s.call('gm', 'PUT', '/attendance/policy', { policy, expectedVersion: view.versions.guild });
    },
  };
  return s;
}

const MIN = 60 * 1000;

// ---------------------------------------------------------------------------
// CSV (pure)

check('csv: RFC 4180 quoting, a doubled quote, CRLF lines, and a text cell a spreadsheet would run as a formula gets a leading apostrophe', async () => {
  const { csvCell, toCsv } = await load('worker/csv.js');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('cr\rhere'), '"cr\rhere"');
  for (const risky of ['=SUM(A1)', '+1+1', '-2+3', '@cmd', '\tTAB', '\rCR']) {
    const cell = csvCell(risky);
    assert(cell.replace(/^"/, '').startsWith("'"), `${JSON.stringify(risky)} is neutralised: ${JSON.stringify(cell)}`);
  }
  assert.equal(csvCell('=A1,B1'), `"'=A1,B1"`, 'the guard comes before the quoting');
  // Not text: a number or a flag is data, never prefixed (a negative number is not a formula).
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(0.5), '0.5');
  assert.equal(csvCell(true), 'yes');
  assert.equal(csvCell(false), 'no');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(NaN), '');
  assert.equal(csvCell('a=b'), 'a=b', 'only a leading character matters');
  const text = toCsv([{ key: 'a', header: 'A' }, { key: 'b', header: '=B' }], [{ a: 'x,y', b: 1 }, { a: '@z', b: null }]);
  assert.equal(text, `A,'=B\r\n"x,y",1\r\n'@z,\r\n`);
  assert.deepEqual(parseCsv(text), [['A', "'=B"], ['x,y', '1'], ["'@z", '']]);
});

// ---------------------------------------------------------------------------
// The team progress board

const T0 = Date.parse('2026-12-01T01:00:00Z');
// Gruul's Lair: High King Maulgar (649), Gruul (650). Karazhan: Attumen (652), only wiped on.
function fixturePulls() {
  const row = (raid, raidOn, zone, enc, name, kill, start, end) => ({ raid_id: raid, raid_on: raidOn, zone, encounter_id: enc, encounter_name: name, kill, started_at: start, ended_at: end });
  return [
    // R1: Maulgar wipes twice then dies, Gruul wipes once then dies.
    row('r1', '2026-12-01', "Gruul's Lair", 649, 'High King Maulgar', 0, T0, T0 + 4 * MIN),
    row('r1', '2026-12-01', "Gruul's Lair", 649, 'High King Maulgar', 0, T0 + 10 * MIN, T0 + 15 * MIN),
    row('r1', '2026-12-01', "Gruul's Lair", 649, 'High King Maulgar', 1, T0 + 20 * MIN, T0 + 28 * MIN),
    row('r1', '2026-12-01', "Gruul's Lair", 650, 'Gruul the Dragonkiller', 0, T0 + 40 * MIN, T0 + 46 * MIN),
    row('r1', '2026-12-01', "Gruul's Lair", 650, 'Gruul the Dragonkiller', 1, T0 + 55 * MIN, T0 + 65 * MIN),
    // The same Maulgar kill logged again by a second uploader (starts inside the first one): the same fight.
    row('r1', '2026-12-01', "Gruul's Lair", 649, 'High King Maulgar', 1, T0 + 20 * MIN + 2000, T0 + 28 * MIN + 2000),
    // R2: both die at once, faster.
    row('r2', '2026-12-08', "Gruul's Lair", 649, 'High King Maulgar', 1, T0 + 7 * DAY, T0 + 7 * DAY + 6 * MIN),
    row('r2', '2026-12-08', "Gruul's Lair", 650, 'Gruul the Dragonkiller', 1, T0 + 7 * DAY + 12 * MIN, T0 + 7 * DAY + 20 * MIN),
    // R3: Maulgar only.
    row('r3', '2026-12-15', "Gruul's Lair", 649, 'High King Maulgar', 1, T0 + 14 * DAY, T0 + 14 * DAY + 5 * MIN),
    // Karazhan: Attumen only wiped on; and a raid with no zone.
    row('r4', '2026-12-02', 'Karazhan', 652, 'Attumen the Huntsman', 0, T0 + DAY, T0 + DAY + 3 * MIN),
    row('r5', '2026-12-03', null, 700, 'Some Boss', 1, T0 + 2 * DAY, T0 + 2 * DAY + 5 * MIN),
  ];
}

check('progress (pure): first kill, wipes before it, kills since, quickest night; a second uploader\'s copy of a fight is not a second pull; zones in the version\'s order', async () => {
  const { buildProgress, dedupePulls, publicProgress, UNKNOWN_ZONE } = await load('worker/progress.js');
  assert.equal(dedupePulls(fixturePulls()).length, fixturePulls().length - 1, 'one duplicate');
  const { zones } = buildProgress(fixturePulls(), 'tbc');
  assert.deepEqual(zones.map((zone) => zone.zone), ['Karazhan', "Gruul's Lair", UNKNOWN_ZONE], 'the TBC order, then the raid without a zone');
  const [karazhan, gruul, unknown] = zones;
  assert.deepEqual([karazhan.bossesKilled, karazhan.bosses.length, karazhan.nightCount, karazhan.bestClear], [0, 1, 0, null]);
  assert.deepEqual(karazhan.bosses[0], { encounterId: 652, name: 'Attumen the Huntsman', killed: false, firstKillOn: null, firstKillRaidId: null, wipesBeforeKill: 0, wipes: 1, kills: 0, killsSince: 0, pulls: 1 });
  assert.deepEqual(gruul.bosses.map((boss) => boss.name), ['High King Maulgar', 'Gruul the Dragonkiller'], 'encounter-id order');
  const [maulgar, boss] = gruul.bosses;
  assert.deepEqual(maulgar, { encounterId: 649, name: 'High King Maulgar', killed: true, firstKillOn: '2026-12-01', firstKillRaidId: 'r1', wipesBeforeKill: 2, wipes: 2, kills: 3, killsSince: 2, pulls: 5 });
  assert.deepEqual([boss.wipesBeforeKill, boss.kills, boss.killsSince, boss.firstKillOn], [1, 2, 1, '2026-12-01']);
  assert.equal(gruul.bossesKilled, 2);
  // Nights: first pull to last kill. R1 65 min, R2 20 min, R3 5 min (one boss). The best clear is the quickest of the nights that killed the most bosses.
  assert.deepEqual(gruul.nights.map((night) => [night.raidOn, night.bosses, night.wipes, night.durationMs / MIN]), [['2026-12-15', 1, 0, 5], ['2026-12-08', 2, 0, 20], ['2026-12-01', 2, 3, 65]], 'newest first');
  assert.deepEqual(gruul.bestClear, { raidId: 'r2', raidOn: '2026-12-08', bosses: 2, kills: 2, wipes: 0, durationMs: 20 * MIN });
  assert.equal(unknown.bosses[0].name, 'Some Boss');
  // The public copy carries no raid ids.
  const text = JSON.stringify(publicProgress({ zones }));
  assert(!/"raidId"|"firstKillRaidId"|"r1"/.test(text), text.slice(0, 200));
  assert.deepEqual(buildProgress([], 'tbc'), { zones: [] });
  // A kill logged on the second report wins over a wipe on the first when they are the same fight.
  const mixed = buildProgress([
    { raid_id: 'a', raid_on: '2026-12-01', zone: "Gruul's Lair", encounter_id: 649, encounter_name: 'M', kill: 0, started_at: 1000, ended_at: 100000 },
    { raid_id: 'a', raid_on: '2026-12-01', zone: "Gruul's Lair", encounter_id: 649, encounter_name: 'M', kill: 1, started_at: 2000, ended_at: 100500 },
  ], 'tbc');
  assert.deepEqual([mixed.zones[0].bosses[0].kills, mixed.zones[0].bosses[0].wipes, mixed.zones[0].bosses[0].pulls], [1, 0, 1]);
});

check('progress (route): GET /teams/:tid/progress reads the stored pulls of that team only, for whoever may see its raids', async () => {
  const s = await scenario({ members: ['m1', 'm2'], teams: 2 });
  const [alpha, bravo] = s.tids;
  await s.person('Aria', { team: alpha, link: 'm1' });
  const r1 = await s.raid('2026-12-01', { team: alpha });
  const r2 = await s.raid('2026-12-08', { team: alpha });
  const other = await s.raid('2026-12-02', { team: bravo, zone: 'Karazhan' });
  s.pulls(r1, T0, [{ fight: 1, enc: 649, name: 'High King Maulgar', kill: false, start: 0, end: 4 * MIN }, { fight: 2, enc: 649, name: 'High King Maulgar', kill: true, start: 10 * MIN, end: 18 * MIN }]);
  s.pulls(r2, T0 + 7 * DAY, [{ fight: 1, enc: 649, name: 'High King Maulgar', kill: true, start: 0, end: 6 * MIN }]);
  s.pulls(other, T0 + DAY, [{ fight: 1, enc: 652, name: 'Attumen the Huntsman', kill: true, start: 0, end: 5 * MIN }]);
  const res = await s.ok('m1', 'GET', `/teams/${alpha}/progress`);
  assert.deepEqual(res.team, { id: alpha, name: 'Alpha' });
  assert.deepEqual(res.zones.map((zone) => zone.zone), ["Gruul's Lair"], "Bravo's Karazhan is not Alpha's");
  const maulgar = res.zones[0].bosses[0];
  assert.deepEqual([maulgar.killed, maulgar.firstKillOn, maulgar.wipesBeforeKill, maulgar.kills, maulgar.killsSince, maulgar.firstKillRaidId], [true, '2026-12-01', 1, 2, 1, r1]);
  assert.deepEqual(Object.keys(res.zones[0]).sort(), ['bestClear', 'bosses', 'bossesKilled', 'nightCount', 'nights', 'zone']);
  const bravoRes = await s.ok('m1', 'GET', `/teams/${bravo}/progress`);
  assert.equal(bravoRes.zones[0].zone, 'Karazhan');
  // No report content: the route answers derived numbers and names, never a report code.
  const codes = (await s.rows('SELECT code FROM raid_reports')).map((row) => row.code);
  const text = JSON.stringify(res);
  for (const code of codes) assert(!text.includes(code), 'no report code');
  // A team that is not in the guild, a malformed id and a stranger.
  assert.equal((await s.call('m1', 'GET', '/teams/t_AAAAAAAAAAAAAAAAAAAAAA/progress')).status, 404);
  assert.equal((await s.call('m1', 'GET', '/teams/not-an-id/progress')).status, 404);
  assert.equal((await s.w.call({}, 'GET', `${s.base}/teams/${alpha}/progress`)).status, 401);
  // A raids.view the Member role lost is a 403.
  s.exec("DELETE FROM role_permissions WHERE role_id = 'member' AND action = 'raids.view'");
  assert.equal((await s.call('m2', 'GET', `/teams/${alpha}/progress`)).status, 403);
  assert.equal((await s.call('gm', 'GET', `/teams/${alpha}/progress`)).status, 200, 'the Guild Master still sees it');
});

check('progress (public page): an optional "progress" section the Public role\'s raids permission opens; ticked alone it shows only the board, without raid ids; guest links stay at four sections', async () => {
  const s = await scenario({ members: ['m1'] });
  await s.person('Aria');
  const r1 = await s.raid('2026-12-01');
  const code = s.pulls(r1, T0, [{ fight: 1, enc: 649, name: 'High King Maulgar', kill: true, start: 0, end: 8 * MIN }]);
  const settings = await s.ok('gm', 'GET', '/public');
  assert.deepEqual(Object.keys(settings.allowed), ['roster', 'raids', 'progress', 'attendance', 'loot'], 'the page offers Progress between Raids and Attendance');
  assert.equal(settings.allowed.progress, true);
  const put = (sections) => s.call('gm', 'PUT', '/public', { enabled: true, sections });
  assert.equal((await put(['progress'])).status, 200);
  const view = await s.w.call({}, 'GET', `/api/public/${s.gid}`);
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(Object.keys(view.json.sections), ['progress'], 'only what was ticked');
  const entry = view.json.sections.progress[0];
  assert.deepEqual(entry.team, { id: s.tid, name: 'Alpha' });
  assert.equal(entry.zones[0].bosses[0].name, 'High King Maulgar');
  assert(!view.text.includes(code) && !view.text.includes(r1), 'no report code, no raid id');
  // Raids alone does not bring the board along (the two share a read action).
  assert.equal((await put(['raids'])).status, 200);
  assert.deepEqual(Object.keys((await s.w.call({}, 'GET', `/api/public/${s.gid}`)).json.sections), ['raids']);
  assert.equal((await put(['roster', 'raids', 'progress'])).status, 200);
  assert.deepEqual(Object.keys((await s.w.call({}, 'GET', `/api/public/${s.gid}`)).json.sections), ['roster', 'raids', 'progress']);
  // The Public role is the ceiling.
  s.exec("DELETE FROM role_permissions WHERE role_id = 'public' AND action = 'raids.view'");
  assert.equal((await s.ok('gm', 'GET', '/public')).allowed.progress, false);
  assert.equal((await put(['progress'])).status, 400);
  // A guest link still shows the four sections its role grants, never Progress.
  const link = await s.ok('gm', 'POST', '/guest-links', { roleId: 'guest', expiresIn: '7d' });
  assert.deepEqual(link.roles[0].sections, ['roster', 'raids', 'attendance']);
  const jar = {};
  assert.equal((await s.w.call(jar, 'POST', '/auth/guest', { token: link.created.token })).status, 200);
  const guest = await s.w.call(jar, 'GET', '/api/guest');
  assert.equal(guest.status, 200, guest.text);
  assert(!('progress' in guest.json.sections), Object.keys(guest.json.sections).join());
});

// ---------------------------------------------------------------------------
// Read-only API keys: making them

check('api keys: made by an officer; the token (rsk_ + 32 bytes) is shown once, only its SHA-256 is kept, and neither is audited; the list never has it', async () => {
  const s = await scenario({ members: ['m1'], teams: 2 });
  const made = await s.makeKey({ name: 'Loot sheet', teamId: s.tids[0], datasets: ['loot', 'roster'], expiresIn: '30d' });
  assert(/^rsk_[A-Za-z0-9_-]{43}$/.test(made.token), made.token);
  assert(/^ak_[A-Za-z0-9_-]{22}$/.test(made.id));
  const row = (await s.rows('SELECT * FROM api_keys'))[0];
  assert.equal(row.token_hash, sha256(made.token));
  assert.equal(row.name, 'Loot sheet');
  assert.equal(row.team_id, s.tids[0]);
  assert.deepEqual(JSON.parse(row.datasets), ['roster', 'loot'], 'in dataset order');
  assert(row.expires_at > NOW + 29 * DAY && row.expires_at <= NOW + 31 * DAY);
  assert.deepEqual([row.uses, row.last_used_at, row.revoked_at], [0, null, null]);
  // The list: no token, no hash, who made it, what it reads.
  const list = await s.ok('gm', 'GET', '/api-keys');
  assert(!JSON.stringify(list).includes(made.token) && !JSON.stringify(list).includes(row.token_hash));
  assert.deepEqual(list.keys.map((key) => [key.name, key.team, key.datasets, key.status, key.uses]), [['Loot sheet', { id: s.tids[0], name: 'Alpha' }, ['roster', 'loot'], 'active', 0]]);
  assert.equal(list.keys[0].createdBy.displayName, 'Gmseven');
  assert.deepEqual(list.datasets.map((d) => [d.id, d.available]), [['roster', true], ['attendance', true], ['loot', true], ['raids', true]]);
  assert.deepEqual(list.expiries, ['30d', '90d', '365d', 'never']);
  assert.deepEqual(list.limits, { perHour: 60, maxActive: 20 });
  // The audit row has the scope, the datasets and the expiry - never the token or its hash.
  const [audit] = await s.audits('apikey.create');
  assert.equal(audit.entity_id, made.id);
  assert.deepEqual(JSON.parse(audit.after), { teamId: s.tids[0], datasets: ['roster', 'loot'], expiresAt: row.expires_at });
  assert(!audit.after.includes('rsk_') && !audit.after.includes(row.token_hash));
  // Two keys never share a token.
  const second = await s.makeKey({ name: 'Second', expiresIn: 'never' });
  assert.notEqual(second.token, made.token);
  assert.equal((await s.rows('SELECT expires_at FROM api_keys WHERE id = ?', second.id))[0].expires_at, null);
  // The Activity log reads it as a sentence (Guild Master only).
  const log = await s.ok('gm', 'GET', '/audit?group=settings');
  assert(log.rows.some((r) => /Made a data key for Alpha \(roster and loot\)/.test(r.text)), log.rows.map((r) => r.text).join(' | '));
  assert(log.rows.some((r) => /Made a data key for the whole guild \(roster, attendance, loot and raids\) that does not expire/.test(r.text)));
});

check('api keys: Guild Master and guild.access only; a name, a team of this guild, known datasets the Member role can see, an expiry; at most 20 working keys; a maker cannot hand out more than they see', async () => {
  const s = await scenario({ members: ['m1', 'm2'], teams: 2 });
  // Not for members.
  assert.equal((await s.call('m1', 'GET', '/api-keys')).status, 403);
  assert.equal((await s.call('m1', 'POST', '/api-keys', { name: 'x', datasets: ['roster'], expiresIn: '30d' })).status, 403);
  assert.equal((await s.w.call({}, 'GET', `${s.base}/api-keys`)).status, 401);
  const bad = async (body, field, status = 400) => {
    const res = await s.call('gm', 'POST', '/api-keys', { name: 'Ok', teamId: null, datasets: ['roster'], expiresIn: '30d', ...body });
    assert.equal(res.status, status, res.text);
    assert.equal(res.json.field, field, res.text);
    return res.json;
  };
  await bad({ name: '' }, 'name');
  await bad({ name: 'x'.repeat(41) }, 'name');
  await bad({ name: 7 }, 'name');
  await bad({ name: 'zero​width' }, 'name');
  await bad({ teamId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, 'teamId');
  await bad({ teamId: 12 }, 'teamId');
  await bad({ datasets: [] }, 'datasets');
  await bad({ datasets: ['roster', 'notes'] }, 'datasets');
  await bad({ datasets: 'roster' }, 'datasets');
  await bad({ expiresIn: '1d' }, 'expiresIn');
  await bad({ expiresIn: undefined }, 'expiresIn');
  // A team that is archived is no team for a key.
  const archived = await s.call('gm', 'PATCH', `/teams/${s.tids[1]}`, { archived: true });
  assert.equal(archived.status, 200, archived.text);
  await bad({ teamId: s.tids[1] }, 'teamId');
  // The Member role decides what a key can read: take loot away from members and it is not offered, and a key asking for it is refused.
  s.exec("DELETE FROM role_permissions WHERE role_id = 'member' AND action = 'loot.view'");
  const list = await s.ok('gm', 'GET', '/api-keys');
  assert.deepEqual(list.datasets.filter((d) => !d.available).map((d) => d.id), ['loot']);
  const refused = await bad({ datasets: ['roster', 'loot'] }, 'datasets');
  assert(/members cannot see loot/i.test(refused.message), refused.message);
  // Twenty working keys at most; a turned-off key frees a place.
  s.exec("INSERT INTO role_permissions (role_id, action, scope) VALUES ('member', 'loot.view', 'own_teams')");
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push((await s.makeKey({ name: `Key ${i}` })).id);
  const full = await bad({ name: 'Twenty-one' }, 'name');
  assert(/at most 20/.test(full.message), full.message);
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM api_keys'))[0].n, 20);
  assert.equal((await s.rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'apikey.create'"))[0].n, 20, 'a refused key leaves no audit row');
  await s.ok('gm', 'DELETE', `/api-keys/${ids[0]}`, {});
  await s.makeKey({ name: 'Replacement' });
  // An officer who cannot see something cannot give a key to it.
  const officerRole = (await s.ok('gm', 'GET', '/roles')).roles.find((role) => role.id === 'officer');
  const withoutLoot = { ...officerRole.permissions };
  delete withoutLoot['loot.view'];
  await s.ok('gm', 'PUT', '/roles/officer', { permissions: withoutLoot }, 200);
  await s.ok('gm', 'PUT', `/people/${s.uids.m1}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  s.exec('DELETE FROM api_keys');
  const sneaky = await s.call('m1', 'POST', '/api-keys', { name: 'Sneaky', teamId: null, datasets: ['loot'], expiresIn: '30d' });
  assert.equal(sneaky.status, 403, sneaky.text);
  assert.equal(sneaky.json.field, 'datasets');
  const fine = await s.call('m1', 'POST', '/api-keys', { name: 'Fine', teamId: null, datasets: ['roster'], expiresIn: '30d' });
  assert.equal(fine.status, 201, fine.text);
});

check('api keys: turning a key off keeps its row and audits it; asking twice is fine; another guild\'s key id is a 404', async () => {
  const s = await scenario({ members: ['m1'] });
  const a = await s.makeKey({ name: 'A' });
  const b = await s.makeKey({ name: 'B' });
  const res = await s.ok('gm', 'DELETE', `/api-keys/${a.id}`, {});
  assert.deepEqual(res.keys.map((key) => [key.name, key.status]).sort(), [['A', 'revoked'], ['B', 'active']]);
  assert.equal((await s.rows('SELECT revoked_at FROM api_keys WHERE id = ?', a.id))[0].revoked_at, s.w.clock.now);
  await s.ok('gm', 'DELETE', `/api-keys/${a.id}`, {});
  assert.equal((await s.audits('apikey.revoke')).length, 1, 'the second turn-off writes nothing');
  assert.equal((await s.call('gm', 'DELETE', '/api-keys/ak_AAAAAAAAAAAAAAAAAAAAAA', {})).status, 404);
  assert.equal((await s.call('m1', 'DELETE', `/api-keys/${b.id}`, {})).status, 403);
  assert.equal((await s.rows('SELECT revoked_at FROM api_keys WHERE id = ?', b.id))[0].revoked_at, null);
  // The guild's data goes with the guild; so does the team's key with its team.
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM api_keys'))[0].n, 2);
});

// ---------------------------------------------------------------------------
// Read-only API keys: the data

async function dataWorld() {
  const s = await scenario({ members: ['m1'], teams: 2 });
  const [alpha, bravo] = s.tids;
  s.aria = await s.person('Aria', { team: alpha, link: 'm1' });
  s.bran = await s.person('Bran', { team: alpha, cls: 'MAGE' });
  s.zed = await s.person('Zed', { team: bravo, cls: 'PRIEST' });
  s.exec("UPDATE players SET notes = 'SECRET OFFICER NOTE', discord_nickname = 'SecretNick' WHERE id = ?", s.aria.pid);
  s.raids = [];
  for (const date of ['2026-12-29', '2027-01-05', '2027-01-12']) s.raids.push(await s.raid(date, { title: date === '2027-01-12' ? '=HYPERLINK("http://x")' : undefined }));
  s.raids.forEach((raidId, i) => {
    s.attend(raidId, s.aria.pid, 'present', 1);
    s.attend(raidId, s.bran.pid, i === 0 ? 'present' : 'missed', i === 0 ? 1 : 0);
  });
  s.bravoRaid = await s.raid('2027-01-11', { team: bravo, zone: 'Karazhan' });
  s.attend(s.bravoRaid, s.zed.pid, 'present', 1, bravo);
  s.pulls(s.raids[2], T0, [{ fight: 1, enc: 649, name: 'High King Maulgar', kill: true, start: 0, end: 8 * MIN }, { fight: 2, enc: 650, name: 'Gruul', kill: true, start: 10 * MIN, end: 20 * MIN }]);
  const award = (id, raidId, team, name, key, item, quality, extra = '') => s.exec(
    `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm_key, winner_class, roll_type, tag, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 28830, ?, ?, 5, ?, ?, 'nightslayer', 'WARRIOR', 'MS', 'MS', 'SECRET LOOT NOTE', 1, 1)${extra}`, id, s.gid, raidId, team, `sum${id}`.slice(0, 20).padEnd(8, 'x'), item, quality, name, key);
  award('lo_aaaaaaaaaaaaaaaaaaaaaa', s.raids[2], alpha, 'Aria', 'aria', 'Girdle, of "Might"', 4);
  award('lo_bbbbbbbbbbbbbbbbbbbbbb', s.raids[2], alpha, 'Aria', 'aria', '=cmd|calc', 3);
  award('lo_cccccccccccccccccccccc', s.bravoRaid, bravo, 'Zed', 'zed', 'Bravo Trinket', 4);
  return s;
}

check('api v1 (roster, raids): CSV and JSON for the whole guild or one team; flat columns, no notes, no Discord data, formula-safe', async () => {
  const s = await dataWorld();
  const all = await s.makeKey({ name: 'Everything' });
  const alphaKey = await s.makeKey({ name: 'Alpha only', teamId: s.tids[0] });
  // Roster
  const roster = await s.api('/api/v1/roster.csv', { token: all.token });
  assert.equal(roster.status, 200, roster.text);
  assert.match(roster.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.equal(roster.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(roster.headers.get('cache-control'), 'no-store');
  assert(roster.text.endsWith('\r\n'));
  assert.equal(roster.text.split('\r\n')[0], 'team,character,realm,class,role,main_spec,off_spec,main,status,joined_on');
  const rows = tableOf(roster.text);
  assert.deepEqual(rows.map((row) => [row.team, row.character, row.class, row.role, row.main, row.status, row.joined_on]), [
    ['Alpha', 'Aria', 'WARRIOR', 'dps', 'yes', 'raider', '2026-09-01'], ['Alpha', 'Bran', 'MAGE', 'dps', 'yes', 'raider', '2026-09-01'], ['Bravo', 'Zed', 'PRIEST', 'healer', 'yes', 'raider', '2026-09-01'],
  ]);
  for (const secret of ['SECRET OFFICER NOTE', 'SecretNick', 'memberone', 'Memberone', s.uids.m1, s.aria.pid]) assert(!roster.text.includes(secret), `no ${secret}`);
  const alphaRoster = tableOf((await s.api('/api/v1/roster.csv', { token: alphaKey.token })).text);
  assert.deepEqual(alphaRoster.map((row) => row.character), ['Aria', 'Bran'], 'one team');
  // JSON: a Bearer header, the same rows, the key's scope named.
  const json = await s.api('/api/v1/roster.json', { bearer: alphaKey.token });
  assert.equal(json.status, 200, json.text);
  assert.match(json.headers.get('content-type'), /^application\/json/);
  assert.deepEqual([json.json.dataset, json.json.guild, json.json.team, json.json.generatedAt], ['roster', 'Wave Seven', 'Alpha', new Date(s.w.clock.now).toISOString()]);
  assert.deepEqual(json.json.columns, ['team', 'character', 'realm', 'class', 'role', 'main_spec', 'off_spec', 'main', 'status', 'joined_on']);
  assert.deepEqual(json.json.rows.map((row) => [row.character, row.main]), [['Aria', true], ['Bran', true]]);
  const guildJson = await s.api('/api/v1/roster.json', { bearer: all.token });
  assert.equal(guildJson.json.team, null);
  // Raids: newest first, bosses killed (distinct), attendance counts, and the formula-looking title is neutralised in the CSV only.
  const raids = await s.api('/api/v1/raids.csv', { token: alphaKey.token });
  assert.equal(raids.status, 200, raids.text);
  const raidRows = tableOf(raids.text);
  assert.deepEqual(raidRows.map((row) => [row.raid_on, row.team, row.zone, row.bosses_killed, row.present, row.bench, row.missed]), [
    ['2027-01-12', 'Alpha', "Gruul's Lair", '2', '1', '0', '1'], ['2027-01-05', 'Alpha', "Gruul's Lair", '0', '1', '0', '1'], ['2026-12-29', 'Alpha', "Gruul's Lair", '0', '2', '0', '0'],
  ]);
  assert.equal(raidRows[0].title, `'=HYPERLINK("http://x")`, 'a title that would run as a formula is text in the sheet');
  const raidsJson = await s.api('/api/v1/raids.json', { bearer: alphaKey.token });
  assert.equal(raidsJson.json.rows[0].title, '=HYPERLINK("http://x")', 'JSON is data, not a sheet: the value as it is');
  assert.equal(raidsJson.json.rows[0].bosses_killed, 2);
  assert(!raids.text.includes('Bravo') && !raids.text.includes('Karazhan'), 'not the other team');
  const guildRaids = tableOf((await s.api('/api/v1/raids.csv', { token: all.token })).text);
  assert.equal(guildRaids.length, 4);
  assert(guildRaids.some((row) => row.team === 'Bravo'));
});

check('api v1 (attendance): one row per person per team with the window\'s percentages, never the cells, outcomes or reasons; ?window= picks one of the offered windows; inactive people are left out', async () => {
  const s = await dataWorld();
  s.exec("UPDATE players SET status = 'inactive', left_on = '2026-12-30' WHERE id = ?", (await s.person('Gone')).pid);
  const key = await s.makeKey({ name: 'Att', teamId: s.tids[0] });
  const res = await s.api('/api/v1/attendance.csv', { token: key.token });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text.split('\r\n')[0], 'team,name,class,status,rank,window_weeks,attendance_pct,raids_counted,signup_rate_pct,absence_streak,last_attended');
  const rows = tableOf(res.text);
  assert.deepEqual(rows.map((row) => [row.name, row.status, row.window_weeks, row.attendance_pct, row.raids_counted, row.absence_streak, row.last_attended]), [
    ['Aria', 'raider', '8', '100', '3', '0', '2027-01-12'], ['Bran', 'raider', '8', '33.3', '3', '2', '2026-12-29'],
  ]);
  const all = await s.api('/api/v1/attendance.json?window=all', { bearer: key.token });
  assert.equal(all.json.rows[0].window_weeks, 'all');
  assert.equal((await s.api('/api/v1/attendance.csv?window=7', { token: key.token })).status, 400);
  assert(!/missed|present|reason|flags/i.test(res.text.split('\r\n').slice(1).join('')), 'no outcomes');
});

check('api v1 (loot): the awards of the key\'s teams with the winner and class, never the note, tag or flags; a team whose loot is private to each player shows nothing; item names that look like formulas are neutralised', async () => {
  const s = await dataWorld();
  const alphaKey = await s.makeKey({ name: 'Loot', teamId: s.tids[0], datasets: ['loot'] });
  const guildKey = await s.makeKey({ name: 'All loot', datasets: ['loot'] });
  const res = await s.api('/api/v1/loot.csv', { token: alphaKey.token });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.text.split('\r\n')[0], 'raid_on,team,item_id,item,quality,winner,winner_class,roll_type,disenchanted');
  const rows = tableOf(res.text);
  assert.deepEqual(rows.map((row) => [row.team, row.item, row.quality, row.winner, row.winner_class, row.roll_type, row.disenchanted]).sort(), [
    ['Alpha', "'=cmd|calc", 'Rare', 'Aria', 'WARRIOR', 'MS', 'no'], ['Alpha', 'Girdle, of "Might"', 'Epic', 'Aria', 'WARRIOR', 'MS', 'no'],
  ]);
  for (const secret of ['SECRET LOOT NOTE', 'MS,MS', 'Bravo Trinket']) assert(!res.text.includes(secret), secret);
  const json = await s.api('/api/v1/loot.json', { bearer: guildKey.token });
  assert.equal(json.json.rows.length, 3);
  assert(json.json.rows.some((row) => row.item === '=cmd|calc'), 'JSON keeps the value');
  assert(!JSON.stringify(json.json).includes('SECRET LOOT NOTE'));
  // Loot private to each player (visibility.members "own"): a key is nobody in particular and reads none of it.
  const view = await s.ok('gm', 'GET', '/loot/policy');
  const put = await s.call('gm', 'PUT', '/loot/policy', { policy: { visibility: { members: 'own' } }, expectedVersion: view.versions.guild });
  assert.equal(put.status, 200, put.text);
  const hidden = await s.api('/api/v1/loot.csv', { token: guildKey.token });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.text, 'raid_on,team,item_id,item,quality,winner,winner_class,roll_type,disenchanted\r\n', 'the header and nothing else');
});

check('api v1: auth - a key is required (CSV: ?key= or Bearer; JSON: Bearer only), a malformed, unknown, turned-off or expired key is a 401, a dataset the key lacks is a 403, nothing else leaks', async () => {
  const s = await dataWorld();
  const rosterOnly = await s.makeKey({ name: 'Roster', datasets: ['roster'] });
  const code = async (res) => `${res.status} ${res.json && res.json.error}`;
  assert.equal(await code(await s.api('/api/v1/roster.csv')), '401 key_required');
  assert.equal(await code(await s.api('/api/v1/roster.json')), '401 key_required');
  assert.equal(await code(await s.api('/api/v1/roster.json', { token: rosterOnly.token })), '401 key_required', 'JSON takes the key in a header only');
  assert.equal((await s.api('/api/v1/roster.csv', { bearer: rosterOnly.token })).status, 200, 'CSV also takes the header');
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: 'nope' })), '401 invalid_key');
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: `rsk_${'A'.repeat(43)}` })), '401 invalid_key', 'a key nobody made');
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: rosterOnly.token.replace(/^rsk_/, 'xxx_') })), '401 invalid_key');
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: sha256(rosterOnly.token) })), '401 invalid_key', 'the hash is not the key');
  // A session cookie is not a key.
  assert.equal(await code(await s.api('/api/v1/roster.csv', { jar: s.jars.gm })), '401 key_required');
  // A dataset the key was not made for, an unknown one, and a bad file name.
  assert.equal(await code(await s.api('/api/v1/loot.csv', { token: rosterOnly.token })), '403 dataset_not_allowed');
  assert.equal((await s.api('/api/v1/notes.csv', { token: rosterOnly.token })).status, 404);
  assert.equal((await s.api('/api/v1/roster.xml', { token: rosterOnly.token })).status, 404);
  assert.equal((await s.api('/api/v1/roster', { token: rosterOnly.token })).status, 404);
  // The Member role losing the read action closes the dataset for existing keys at once.
  s.exec("DELETE FROM role_permissions WHERE role_id = 'member' AND action = 'roster.view'");
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: rosterOnly.token })), '403 dataset_not_allowed');
  s.exec("INSERT INTO role_permissions (role_id, action, scope) VALUES ('member', 'roster.view', 'guild')");
  assert.equal((await s.api('/api/v1/roster.csv', { token: rosterOnly.token })).status, 200);
  // Turned off: at once. Expired: at once too.
  await s.ok('gm', 'DELETE', `/api-keys/${rosterOnly.id}`, {});
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: rosterOnly.token })), '401 key_revoked');
  const short = await s.makeKey({ name: 'Short', expiresIn: '30d' });
  assert.equal((await s.api('/api/v1/roster.csv', { token: short.token })).status, 200);
  s.w.advance(31 * DAY);
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: short.token })), '401 key_expired');
  // A team that is archived since: the key of that team reads nothing.
  s.w.clock.now = NOW;
  const bravoKey = await s.makeKey({ name: 'Bravo', teamId: s.tids[1] });
  assert.equal((await s.api('/api/v1/roster.csv', { token: bravoKey.token })).status, 200);
  assert.equal((await s.call('gm', 'PATCH', `/teams/${s.tids[1]}`, { archived: true })).status, 200);
  assert.equal(await code(await s.api('/api/v1/roster.csv', { token: bravoKey.token })), '403 team_archived');
  // No error body carries a token.
  const failed = await s.api('/api/v1/roster.csv', { token: rosterOnly.token });
  assert(!failed.text.includes(rosterOnly.token));
});

check('api v1: counts a use and the last use; 60 requests an hour per key (the 61st is a 429 with Retry-After), and another key has its own allowance', async () => {
  const s = await dataWorld();
  const one = await s.makeKey({ name: 'One', datasets: ['roster'] });
  const two = await s.makeKey({ name: 'Two', datasets: ['roster'] });
  s.w.clock.now = NOW;
  for (let i = 0; i < 60; i++) {
    const res = await s.api('/api/v1/roster.csv', { token: one.token });
    assert.equal(res.status, 200, `request ${i + 1}: ${res.text}`);
  }
  const limited = await s.api('/api/v1/roster.csv', { token: one.token });
  assert.equal(limited.status, 429, limited.text);
  assert.equal(limited.json.error, 'rate_limited');
  assert(Number(limited.headers.get('retry-after')) > 0 && Number(limited.headers.get('retry-after')) <= 3600);
  assert.equal(limited.json.retryAfter, Number(limited.headers.get('retry-after')));
  assert.equal((await s.api('/api/v1/roster.csv', { token: two.token })).status, 200, 'its own allowance');
  const row = (await s.rows('SELECT uses, last_used_at FROM api_keys WHERE id = ?', one.id))[0];
  assert.deepEqual([row.uses, row.last_used_at], [60, s.w.clock.now], 'a refused request counts nothing');
  // The window rolls over after an hour.
  s.w.advance(HOUR + 1000);
  assert.equal((await s.api('/api/v1/roster.csv', { token: one.token })).status, 200);
  // A wrong key never spends a real key's allowance (and writes nothing).
  const before = (await s.rows('SELECT COUNT(*) AS n FROM rate_limits'))[0].n;
  for (let i = 0; i < 5; i++) await s.api('/api/v1/roster.csv', { token: `rsk_${'B'.repeat(43)}` });
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM rate_limits'))[0].n, before);
});

check('api keys: the guild takes its keys with it (delete guild), the export leaves them out, migration 0021 creates the table with its checks', async () => {
  const s = await dataWorld();
  const key = await s.makeKey({ name: 'Gone with the guild' });
  const columns = (await s.rows("SELECT name FROM pragma_table_info('api_keys')")).map((row) => row.name);
  assert.deepEqual(columns, ['id', 'guild_id', 'token_hash', 'name', 'team_id', 'datasets', 'expires_at', 'revoked_at', 'uses', 'last_used_at', 'created_by', 'created_at']);
  const insert = (id, hash, name, datasets = '[]') => s.exec('INSERT INTO api_keys (id, guild_id, token_hash, name, datasets, created_at) VALUES (?, ?, ?, ?, ?, 1)', id, s.gid, hash, name, datasets);
  await assert.rejects(async () => insert('ak_x1', 'short', 'n'), /CHECK/, 'a hash of 64 characters');
  await assert.rejects(async () => insert('ak_x2', 'a'.repeat(64), ''), /CHECK/, 'a name');
  await assert.rejects(async () => insert('ak_x3', 'a'.repeat(64), 'n', 'not json'), /CHECK|malformed/i);
  await assert.rejects(async () => insert('ak_x4', 'a'.repeat(64), 'n', '{}'), /CHECK/, 'datasets are an array');
  await assert.rejects(async () => insert('ak_x5', sha256(key.token), 'dup'), /UNIQUE/, 'one hash, one key');
  const exported = await s.w.call(s.jars.gm, 'GET', `${s.base}/export`);
  assert.equal(exported.status, 200);
  assert(!exported.text.includes(key.token) && !exported.text.includes(sha256(key.token)) && !exported.text.includes('Gone with the guild'));
  // Deleting a team takes its keys (the foreign key); deleting the guild takes all.
  const teamKey = await s.makeKey({ name: 'Bravo key', teamId: s.tids[1] });
  assert.equal((await s.call('gm', 'DELETE', '', { confirmName: 'Wave Seven' })).status, 200);
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM api_keys'))[0].n, 0);
  assert.equal((await s.api('/api/v1/roster.csv', { token: teamKey.token })).status, 401);
});

// ---------------------------------------------------------------------------
// The rank ladder

const VINDICATED = [
  { id: 'member', name: 'Member', rules: {} },
  { id: 'raider', name: 'Raider', rules: { minWeeksAttended: 2, since: 'join' } },
  { id: 'coreraider', name: 'Core Raider', rules: { minRaids: 8, since: 'rank' } },
];
const STRICT = [
  { id: 'member', name: 'Member', rules: {} },
  { id: 'raider', name: 'Raider', rules: { minAttendance: 0.75, minWeeksAttended: 2 } },
  { id: 'core', name: 'Core', rules: { minAttendance: 0.9, minRaids: 6, since: 'rank', maxMissed: 1 } },
];

check('ladder policy: ranks are validated like the rest of the policy; a team override may not carry the ladder; the defaults have none', async () => {
  const { validateOverride, resolvePolicy, DEFAULT_POLICY, MAX_RANKS } = await load('worker/attendance-policy.js');
  assert.deepEqual(DEFAULT_POLICY.ladder, { ranks: [] });
  const errors = (ranks, scope = 'guild') => validateOverride({ ladder: { ranks } }, scope).errors.map((e) => `${e.path}: ${e.message}`);
  assert.deepEqual(errors([]), []);
  assert.deepEqual(errors(VINDICATED), []);
  assert.deepEqual(errors(STRICT), []);
  assert.match(errors([VINDICATED[0]])[0], /ladder\.ranks: must be empty .* 2 to 6 ranks/, 'one rank is no ladder');
  assert.match(errors(Array.from({ length: MAX_RANKS + 1 }, (_, i) => ({ id: `rank${String.fromCharCode(97 + i)}`, name: `R${i}`, rules: {} })))[0], /2 to 6 ranks/);
  const base = (rank) => [VINDICATED[0], { id: 'raider', name: 'Raider', rules: {}, ...rank }];
  assert.match(errors(base({ id: 'Raider' }))[0], /id is 2 to 12 lower-case letters/);
  assert.match(errors(base({ id: 'member' }))[0], /unique/);
  assert.match(errors(base({ name: '' }))[0], /name must be 1 to 20/);
  assert.match(errors(base({ name: 'x'.repeat(21) }))[0], /name must be 1 to 20/);
  assert.match(errors(base({ name: 'tab\there' }))[0], /plain text/);
  assert.match(errors(base({ extra: 1 }))[0], /unknown key "extra"/);
  assert.match(errors(base({ rules: { minPct: 1 } }))[0], /unknown rule "minPct"/);
  assert.match(errors(base({ rules: { minAttendance: 1.5 } }))[0], /minAttendance/);
  assert.match(errors(base({ rules: { minAttendance: 0.8751 } }))[0], /three decimals/);
  assert.match(errors(base({ rules: { minRaids: -1 } }))[0], /minRaids must be a whole number from 0 to 1000/);
  assert.match(errors(base({ rules: { minRaids: 2.5 } }))[0], /whole number/);
  assert.match(errors(base({ rules: { maxMissed: 101 } }))[0], /maxMissed/);
  assert.match(errors(base({ rules: { since: 'always' } }))[0], /since must be join or rank/);
  assert.deepEqual(errors(base({ rules: { minRaids: null, minAttendance: null, maxMissed: 0, since: 'rank' } })), [], 'null is off, 0 is a number');
  assert.deepEqual(errors(VINDICATED, 'team'), ['ladder: the rank ladder is set for the whole guild, not per team']);
  // A team override that slipped one in does not change the team's ladder.
  const resolved = resolvePolicy({ ladder: { ranks: VINDICATED } }, { ladder: { ranks: STRICT } }, 'US');
  assert.deepEqual(resolved.ladder.ranks.map((rank) => rank.id), ['member', 'raider', 'coreraider']);
});

check('ladder policy (route): saved with the rest of the policy, versioned; a team override carrying it is a 400; the ladder never makes a raid stale', async () => {
  const s = await scenario({ teams: 2 });
  const saved = await s.setPolicy({ ladder: { ranks: VINDICATED } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.resolved[s.tids[0]].ladder.ranks.map((rank) => rank.name), ['Member', 'Raider', 'Core Raider']);
  const view = (await s.call('gm', 'GET', '/attendance/policy')).json;
  const team = await s.call('gm', 'PUT', '/attendance/policy', { teamId: s.tids[0], policy: { ladder: { ranks: STRICT } }, expectedVersion: 0 });
  assert.equal(team.status, 400, team.text);
  assert.equal(team.json.field, 'ladder');
  const bad = await s.call('gm', 'PUT', '/attendance/policy', { policy: { ladder: { ranks: [VINDICATED[0]] } }, expectedVersion: view.versions.guild });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.field, 'ladder.ranks');
  const { consolidationFingerprint, resolvePolicy } = await load('worker/attendance-policy.js');
  assert.equal(consolidationFingerprint(resolvePolicy({ ladder: { ranks: VINDICATED } }, {}, 'US')), consolidationFingerprint(resolvePolicy({}, {}, 'US')), 'read live');
  const [audit] = await s.audits('policy.update');
  assert.deepEqual(JSON.parse(audit.after).changed, ['ladder']);
});

// One team of five on the Vindicated-style ladder, sixteen Tuesdays of history.
async function ladderWorld(ranks = STRICT) {
  const s = await scenario({ members: ['m1'] });
  s.ppl = {};
  const add = async (name, status, joinedOn, link = null) => { s.ppl[name] = (await s.person(name, { status, joinedOn, link })).pid; };
  await add('Aria', 'raider', '2026-09-01', 'm1'); // perfect, no rank yet; m1's account is hers
  await add('Bran', 'raider', '2026-09-01');     // Raider since 2026-10-01, perfect
  await add('Cora', 'raider', '2026-09-01');     // Raider, missed six of the last eight
  await add('Dax', 'reserve', '2026-09-01');     // a reserve who never comes
  await add('Eve', 'trial', '2027-01-05');       // new, one raid
  s.raidIds = [];
  for (const date of TUESDAYS) s.raidIds.push(await s.raid(date));
  s.raidIds.forEach((raidId, i) => {
    s.attend(raidId, s.ppl.Aria, 'present', 1);
    s.attend(raidId, s.ppl.Bran, 'present', 1);
    const coraPresent = i < 8 || i === 8 || i === 9;
    s.attend(raidId, s.ppl.Cora, coraPresent ? 'present' : 'missed', coraPresent ? 1 : 0);
    s.attend(raidId, s.ppl.Dax, 'missed', 0);
    if (i === 15) s.attend(raidId, s.ppl.Eve, 'present', 1);
  });
  s.exec("UPDATE players SET rank = 'raider', rank_on = '2026-10-01' WHERE id IN (?, ?)", s.ppl.Bran, s.ppl.Cora);
  assert.equal((await s.setPolicy({ ladder: { ranks } })).status, 200);
  s.team = (who = 'gm', query = '') => s.call(who, 'GET', `/attendance/team?team=${s.tid}${query}`);
  s.byName = (res) => { assert.equal(res.status, 200, res.text); return Object.fromEntries(res.json.people.map((p) => [p.name, p])); };
  return s;
}

check('ladder (pure): promote needs the NEXT rank\'s rules, review is the CURRENT rank\'s sustained rules over 3+ counted raids; only raiders and trials; counts from joining or from the rank; a rank with no rules is by hand', async () => {
  const { rankReview, ladderOf, hasRules, REVIEW_MIN_COUNTED } = await load('worker/rank-ladder.js');
  const { resolvePolicy } = await load('worker/attendance-policy.js');
  const policy = resolvePolicy({ ladder: { ranks: STRICT } }, {}, 'US');
  assert.equal(REVIEW_MIN_COUNTED, 3);
  assert.deepEqual(ladderOf(policy).map((rank) => rank.id), ['member', 'raider', 'core']);
  assert.deepEqual(ladderOf(resolvePolicy({}, {}, 'US')), []);
  assert.equal(hasRules({}), false);
  assert.equal(hasRules({ since: 'rank' }), false, 'since alone is no rule');
  assert.equal(hasRules({ maxMissed: 0 }), true, '0 is a rule');
  const raids = TUESDAYS.map((raidOn, i) => ({ id: `r${i}`, raidOn, hasSignups: false }));
  const rowsOf = (pid, outcomeAt) => raids.map((raid, i) => { const outcome = outcomeAt(i); return { raidId: raid.id, playerId: pid, outcome, credit: outcome === 'present' ? 1 : 0, signupKind: null, attended: outcome === 'present' ? 1 : 0, viaRaidId: null }; });
  const input = (people, rows, extra = {}) => ({ ladder: STRICT, policy, today: '2027-01-15', resetDay: 2, nowMs: NOW, teamId: 't1', people, raids, rows, borrowed: [], ...extra });
  const person = (id, extra = {}) => ({ id, status: 'raider', joinedOn: '2026-09-01', leftOn: null, rank: null, rankOn: null, ...extra });
  const out = rankReview(input(
    [person('aria'), person('bran', { rank: 'raider', rankOn: '2026-10-01' }), person('cora', { rank: 'raider', rankOn: '2026-10-01' }), person('dax', { status: 'reserve' }), person('eve', { status: 'trial', joinedOn: '2027-01-05' }),
      person('fay', { rank: 'core', rankOn: '2026-11-01' }), person('gus', { rank: 'ghost' })],
    [...rowsOf('aria', () => 'present'), ...rowsOf('bran', () => 'present'), ...rowsOf('cora', (i) => (i < 10 ? 'present' : 'missed')), ...rowsOf('dax', () => 'missed'),
      ...rowsOf('eve', (i) => (i === 15 ? 'present' : 'missed')), ...rowsOf('fay', (i) => (i < 12 ? 'present' : 'missed')), ...rowsOf('gus', () => 'present')],
  ));
  const view = (id) => { const e = out.get(id); return [e.rank.id, e.rank.set, e.suggestion && [e.suggestion.kind, e.suggestion.to.id]]; };
  assert.deepEqual(view('aria'), ['member', false, ['promote', 'raider']], 'no rank = the first rank; 100% and 16 weeks attended');
  assert.deepEqual(view('bran'), ['raider', true, ['promote', 'core']], 'perfect, 15 raids since the rank, no misses');
  assert.deepEqual(view('cora'), ['raider', true, ['review', 'member']], 'missed six of the last eight: 25% under 75%');
  assert.deepEqual(view('dax'), ['member', false, null], 'a reserve is not judged');
  assert.deepEqual(view('gus'), ['member', false, ['promote', 'raider']], 'a rank that left the ladder reads as the first rank');
  assert.deepEqual(out.get('aria').suggestion.reasons, ['attendance of 75% or more', '2 weeks attended since joining']);
  assert.deepEqual(out.get('cora').suggestion.from, { id: 'raider', name: 'Raider' });
  assert.deepEqual(out.get('cora').suggestion.reasons, ['attendance 25% (the rank asks 75%)']);
  // Eve: one raid, a week: not enough weeks attended and 1 counted raid.
  assert.equal(out.get('eve').suggestion, null);
  // Fay (Core since 2026-11-01): missed the last four: 8 misses allowed? she missed 4 of 8 in the window -> 50% under Core's 90%, and 4 misses over the 1 allowed.
  assert.deepEqual(out.get('fay').suggestion.kind, 'review');
  assert.equal(out.get('fay').suggestion.reasons.length, 2);
  assert.match(out.get('fay').suggestion.reasons[1], /4 raids missed without notice \(the rank allows 1\)/);
  // "since the rank" counts from the day of the rank; "since joining" from the join date.
  const vind = rankReview(input([person('bran', { rank: 'raider', rankOn: '2026-11-24' })], rowsOf('bran', () => 'present'), { ladder: VINDICATED, policy: resolvePolicy({ ladder: { ranks: VINDICATED } }, {}, 'US') }));
  assert.equal(vind.get('bran').suggestion.to.id, 'coreraider', '8 raids since 2026-11-24 (a Tuesday): 11-24, 12-01 ... 01-12');
  const early = rankReview(input([person('bran', { rank: 'raider', rankOn: '2026-12-01' })], rowsOf('bran', () => 'present'), { ladder: VINDICATED, policy: resolvePolicy({ ladder: { ranks: VINDICATED } }, {}, 'US') }));
  assert.equal(early.get('bran').suggestion, null, 'only 7 raids since 2026-12-01: not 8 yet');
  // Judged on the team of their Main only.
  const away = rankReview(input([person('aria')], rowsOf('aria', () => 'present'), { homeTeamOf: () => 't2' }));
  assert.equal(away.get('aria').suggestion, null);
  assert.equal(away.get('aria').rank.id, 'member');
  // A dismissal hides exactly that suggestion until it runs out.
  const dismissals = new Map([['aria', { kind: 'promote', to_rank: 'raider', until: NOW + 1000 }]]);
  assert.equal(rankReview(input([person('aria')], rowsOf('aria', () => 'present'), { dismissals })).get('aria').suggestion, null);
  assert.equal(rankReview(input([person('aria')], rowsOf('aria', () => 'present'), { dismissals, nowMs: NOW + 1001 })).get('aria').suggestion.kind, 'promote', 'the 30 days are over');
  const other = new Map([['aria', { kind: 'promote', to_rank: 'core', until: NOW + 1000 }]]);
  assert.equal(rankReview(input([person('aria')], rowsOf('aria', () => 'present'), { dismissals: other })).get('aria').suggestion.to.id, 'raider', 'a different suggestion is not dismissed');
  // No ladder, no review.
  assert.equal(rankReview({ ...input([person('aria')], []), ladder: [] }).size, 0);
  // A rank with no rules is never suggested.
  const manual = rankReview(input([person('aria')], rowsOf('aria', () => 'present'), { ladder: [STRICT[0], { id: 'raider', name: 'Raider', rules: {} }, STRICT[2]] }));
  assert.equal(manual.get('aria').suggestion, null);
});

check('ladder (team page): everyone\'s rank; the suggestions only for those who review the team; a dismissed one is hidden for 30 days', async () => {
  const s = await ladderWorld();
  const gm = await s.team('gm');
  assert.equal(gm.status, 200, gm.text);
  assert.deepEqual(gm.json.ladder, [{ id: 'member', name: 'Member' }, { id: 'raider', name: 'Raider' }, { id: 'core', name: 'Core' }]);
  const by = s.byName(gm);
  assert.deepEqual(by.Aria.rank, { id: 'member', name: 'Member', set: false });
  assert.deepEqual(by.Bran.rank, { id: 'raider', name: 'Raider', set: true });
  assert.deepEqual([by.Aria.rankSuggestion.kind, by.Aria.rankSuggestion.to.name], ['promote', 'Raider']);
  assert.deepEqual([by.Bran.rankSuggestion.kind, by.Bran.rankSuggestion.to.name, by.Bran.rankSuggestion.from.name], ['promote', 'Core', 'Raider']);
  assert.deepEqual([by.Cora.rankSuggestion.kind, by.Cora.rankSuggestion.from.name, by.Cora.rankSuggestion.to.name], ['review', 'Raider', 'Member']);
  assert.equal(by.Dax.rankSuggestion, undefined, 'a reserve');
  assert.equal(by.Eve.rankSuggestion, undefined);
  // A member sees the ranks, never the suggestions.
  const member = s.byName(await s.team('m1'));
  assert.deepEqual(member.Cora.rank, { id: 'raider', name: 'Raider', set: true });
  assert(Object.values(member).every((p) => p.rankSuggestion === undefined));
  // No ladder: no rank anywhere and nothing new in the answer.
  assert.equal((await s.setPolicy({ ladder: { ranks: [] } })).status, 200);
  const none = await s.team('gm');
  assert.deepEqual(none.json.ladder, []);
  assert(none.json.people.every((p) => p.rank === undefined && p.rankSuggestion === undefined));
});

check('ladder (accept / set / dismiss): one click writes the rank and the day (audited), a stale accept is a 409, a person may be set by hand or cleared, dismissing hides the suggestion for 30 days', async () => {
  const s = await ladderWorld();
  const put = (who, pid, body) => s.call(who, 'PUT', `/roster/${pid}/rank`, { teamId: s.tid, ...body });
  // Accept Aria's promotion.
  const accepted = await put('gm', s.ppl.Aria, { rank: 'raider', via: 'accept', expectedRank: null });
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(accepted.json, { ok: true, changed: true, rank: { id: 'raider', name: 'Raider' }, rankOn: '2027-01-15' });
  const row = (await s.rows('SELECT rank, rank_on FROM players WHERE id = ?', s.ppl.Aria))[0];
  assert.deepEqual([row.rank, row.rank_on], ['raider', '2027-01-15']);
  const [audit] = await s.audits('person.rank');
  assert.equal(audit.entity_id, s.ppl.Aria);
  assert.deepEqual(JSON.parse(audit.before), { rank: null, rankName: null });
  assert.deepEqual(JSON.parse(audit.after), { rank: 'raider', rankName: 'Raider', via: 'accept', teamId: s.tid });
  // The same click again changes nothing; a stale expectation is a conflict.
  assert.deepEqual((await put('gm', s.ppl.Aria, { rank: 'raider', via: 'accept' })).json.changed, false);
  assert.equal((await s.audits('person.rank')).length, 1);
  const stale = await put('gm', s.ppl.Aria, { rank: 'core', via: 'accept', expectedRank: null });
  assert.equal(stale.status, 409, stale.text);
  assert.deepEqual(stale.json.rank, { id: 'raider', name: 'Raider' });
  // Now Aria is a Raider since today: Core needs 6 raids since the rank, so no suggestion.
  assert.equal(s.byName(await s.team('gm')).Aria.rankSuggestion, undefined);
  // By hand, and cleared.
  const manual = await put('gm', s.ppl.Dax, { rank: 'core', via: 'manual' });
  assert.equal(manual.status, 200, manual.text);
  assert.equal((await put('gm', s.ppl.Dax, { rank: null })).json.rankOn, null);
  assert.deepEqual((await s.rows('SELECT rank, rank_on FROM players WHERE id = ?', s.ppl.Dax))[0], { rank: null, rank_on: null });
  assert.equal(JSON.parse((await s.audits('person.rank')).pop().after).rank, null);
  // Guards.
  assert.equal((await put('gm', s.ppl.Dax, { rank: 'nonsense' })).status, 400);
  assert.equal((await put('gm', s.ppl.Dax, {})).status, 400);
  assert.equal((await put('gm', s.ppl.Dax, { rank: 7 })).status, 400);
  assert.equal((await put('gm', s.ppl.Dax, { rank: 'core', via: 'robot' })).status, 400);
  assert.equal((await put('m1', s.ppl.Dax, { rank: 'core' })).status, 403, 'members do not rank people');
  assert.equal((await s.call('gm', 'PUT', `/roster/p_AAAAAAAAAAAAAAAAAAAAAA/rank`, { teamId: s.tid, rank: 'core' })).status, 404);
  assert.equal((await s.call('gm', 'PUT', `/roster/${s.ppl.Dax}/rank`, { teamId: 't_AAAAAAAAAAAAAAAAAAAAAA', rank: 'core' })).status, 400);
  assert.equal((await s.call('gm', 'PUT', `/roster/${s.ppl.Dax}/rank`, { rank: 'core' })).status, 400, 'a team is required');
  // Dismiss Bran's promotion: hidden for 30 days, then back.
  const dismiss = (who, pid, body) => s.call(who, 'POST', `/roster/${pid}/rank/dismiss`, { teamId: s.tid, kind: 'promote', to: 'core', ...body });
  assert.equal((await dismiss('m1', s.ppl.Bran)).status, 403);
  assert.equal((await dismiss('gm', s.ppl.Bran, { kind: 'maybe' })).status, 400);
  assert.equal((await dismiss('gm', s.ppl.Bran, { to: 'ghost' })).status, 400);
  const gone = await dismiss('gm', s.ppl.Bran);
  assert.equal(gone.status, 200, gone.text);
  assert.equal(gone.json.until, s.w.clock.now + 30 * DAY);
  assert.equal(s.byName(await s.team('gm')).Bran.rankSuggestion, undefined);
  const [dismissAudit] = await s.audits('rank.dismiss');
  assert.deepEqual(JSON.parse(dismissAudit.after), { kind: 'promote', to: 'core', toName: 'Core', until: gone.json.until, teamId: s.tid });
  assert.equal(s.byName(await s.team('gm')).Bran.rankSuggestion, undefined, 'still hidden a day before the end');
  s.exec('UPDATE rank_dismissals SET until = ? WHERE player_id = ?', s.w.clock.now, s.ppl.Bran); // the 30 days run out (the session would not last that long)
  assert.equal(s.byName(await s.team('gm')).Bran.rankSuggestion.to.id, 'core', 'the 30 days are over');
  // Accepting a rank clears the person\'s dismissal.
  await dismiss('gm', s.ppl.Bran);
  assert.equal((await put('gm', s.ppl.Bran, { rank: 'core', via: 'accept' })).status, 200);
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM rank_dismissals WHERE player_id = ?', s.ppl.Bran))[0].n, 0);
  // A guild without a ladder refuses a rank.
  await s.setPolicy({ ladder: { ranks: [] } });
  assert.equal((await put('gm', s.ppl.Dax, { rank: 'core' })).status, 400);
});

check('ladder (a person on two teams): judged on the team of their Main; the person\'s attendance page has the rank, the choices, the team to set it from and the suggestion', async () => {
  const s = await ladderWorld();
  const bravo = (await s.ok('gm', 'POST', '/teams', { name: 'Bravo' })).team.id;
  // Cora also has an alt on Bravo (not her Main).
  const alt = await s.call('gm', 'POST', `/roster/${s.ppl.Cora}/characters`, { teamId: bravo, name: 'Coraalt', class: 'MAGE', mainSpec: 'Fire', offSpec: null });
  assert.equal(alt.status, 201, alt.text);
  const bravoPage = s.byName(await s.call('gm', 'GET', `/attendance/team?team=${bravo}`));
  assert.equal(bravoPage.Coraalt.rankSuggestion, undefined, 'her suggestion belongs to the team of her Main');
  assert.equal(bravoPage.Coraalt.rank.id, 'raider');
  const page = await s.ok('gm', 'GET', `/attendance/person/${s.ppl.Cora}`);
  assert.deepEqual(page.person.rank, { id: 'raider', name: 'Raider', set: true, on: '2026-10-01' });
  assert.deepEqual(page.person.rankChoices.map((c) => c.id), ['member', 'raider', 'core']);
  assert.equal(page.person.rankTeamId, s.tid, 'the Main\'s team first');
  const suggestions = page.teams.filter((t) => t.rankSuggestion);
  assert.deepEqual(suggestions.map((t) => [t.team.id, t.rankSuggestion.kind]), [[s.tid, 'review']]);
  // A member sees the rank on a person page, never a suggestion nor the place to set it.
  const mine = await s.call('m1', 'GET', `/attendance/person/${s.ppl.Cora}`);
  if (mine.status === 200) {
    assert.equal(mine.json.person.rankTeamId, null);
    assert(mine.json.teams.every((t) => t.rankSuggestion === undefined));
  }
});

check('ladder (Needs attention): the suggestions are counted per team for the Guild box (not listed, not in the open-work count), and a dismissed one is gone', async () => {
  const s = await ladderWorld();
  const home = await s.ok('gm', 'GET', '/attention');
  assert.deepEqual(home.items.filter((item) => item.kind === 'rank'), [], 'rank suggestions left Home: they live on the Ranks page');
  assert.deepEqual(home.counts[s.tid], { watchOpen: home.counts[s.tid].watchOpen, rankOpen: 3 }, 'Aria, Bran and Cora');
  const totalBefore = home.total;
  await s.call('gm', 'POST', `/roster/${s.ppl.Bran}/rank/dismiss`, { teamId: s.tid, kind: 'promote', to: 'core' });
  const after = await s.ok('gm', 'GET', '/attention');
  assert.equal(after.counts[s.tid].rankOpen, 2);
  assert.equal(after.total, totalBefore, 'rank suggestions are no to-dos');
  // A member has no Home list at all.
  assert.equal((await s.call('m1', 'GET', '/attention')).status, 403);
  // No ladder: no suggestions.
  await s.setPolicy({ ladder: { ranks: [] } });
  assert.equal((await s.ok('gm', 'GET', '/attention')).counts[s.tid].rankOpen, 0);
});

check('ladder: the Vindicated tracker\'s ladder (Member -> Raider after 2 attended raid weeks -> Core Raider after 8 attended nights since the promotion) is expressible and works end to end', async () => {
  const s = await ladderWorld(VINDICATED);
  // Aria is a Member with 16 attended weeks: Raider is suggested. Accept it today.
  assert.equal(s.byName(await s.team('gm')).Aria.rankSuggestion.to.name, 'Raider');
  assert.equal((await s.call('gm', 'PUT', `/roster/${s.ppl.Aria}/rank`, { teamId: s.tid, rank: 'raider', via: 'accept' })).status, 200);
  // 8 nights since the promotion: none yet (she was promoted today).
  assert.equal(s.byName(await s.team('gm')).Aria.rankSuggestion, undefined);
  // Bran was promoted 2026-10-01 and attended every night since: Core Raider is suggested.
  const bran = s.byName(await s.team('gm')).Bran;
  assert.deepEqual([bran.rankSuggestion.kind, bran.rankSuggestion.to.name], ['promote', 'Core Raider']);
  // Promoted 2026-12-30 instead: only two nights since (01-05, 01-12): not yet.
  s.exec("UPDATE players SET rank_on = '2026-12-30' WHERE id = ?", s.ppl.Bran);
  assert.equal(s.byName(await s.team('gm')).Bran.rankSuggestion, undefined);
  // The Vindicated ladder has no attendance floor, so nobody is ever asked to be reviewed.
  assert(Object.values(s.byName(await s.team('gm'))).every((p) => !p.rankSuggestion || p.rankSuggestion.kind === 'promote'));
});

check('migration 0021: players.rank and rank_on (checked), rank_dismissals (one per person, gone with the person and the guild)', async () => {
  const s = await scenario();
  const { pid } = await s.person('Aria');
  const columns = (await s.rows("SELECT name FROM pragma_table_info('players')")).map((row) => row.name);
  assert(columns.includes('rank') && columns.includes('rank_on'));
  await assert.rejects(async () => s.exec("UPDATE players SET rank = 'x' WHERE id = ?", pid), /CHECK/, 'a rank id is 2 to 12 characters');
  await assert.rejects(async () => s.exec("UPDATE players SET rank_on = '2027-13-45' WHERE id = ?", pid), /CHECK/);
  s.exec("UPDATE players SET rank = 'raider', rank_on = '2027-01-01' WHERE id = ?", pid);
  const dismiss = (kind = 'promote', rank = 'core') => s.exec('INSERT INTO rank_dismissals (guild_id, player_id, kind, to_rank, until, created_at) VALUES (?, ?, ?, ?, 5, 1)', s.gid, pid, kind, rank);
  dismiss();
  await assert.rejects(async () => dismiss(), /UNIQUE|PRIMARY/, 'one dismissal per person');
  await assert.rejects(async () => s.exec("UPDATE rank_dismissals SET kind = 'sideways' WHERE player_id = ?", pid), /CHECK/);
  assert.equal((await s.call('gm', 'DELETE', `/roster/${pid}`, {})).status, 200);
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM rank_dismissals'))[0].n, 0, 'gone with the person');
  // The guild export carries the rank id of a ranked person, nothing for an unranked one.
  const b = await s.person('Bran');
  const c = await s.person('Cora');
  s.exec("UPDATE players SET rank = 'raider', rank_on = '2027-01-01' WHERE id = ?", b.pid);
  const exported = (await s.w.call(s.jars.gm, 'GET', `${s.base}/export`)).json;
  const people = Object.fromEntries(exported.people.map((p) => [p.id, p]));
  assert.deepEqual([people[b.pid].rank, people[b.pid].rankOn], ['raider', '2027-01-01']);
  assert.equal('rank' in people[c.pid], false);
});

// ---------------------------------------------------------------------------

async function main() {
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
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
