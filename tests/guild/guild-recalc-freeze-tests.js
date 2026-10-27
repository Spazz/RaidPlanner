/**
 * Raidsmith guild tracker - lane RECALC FREEZE (user decision 2026-10-26): finished raids freeze, and recent stale raids recalculate by themselves
 * Run: node tests/guild/guild-recalc-freeze-tests.js [name-filter]
 *
 * THE FREEZE (worker/attendance-store.js): a roster edit marks a raid stale when its attendance week is still running (this week's and later raids) or when its log
 * names one of the changed characters, at any age. A raid whose week is over, whose log does not name the character, keeps its result. The week is the guild's reset week
 * (worker/attendance-calendar.js weekStart; the reset day is the guild policy's resetDay, else the region's). The deliberate action is untouched: a rules change stales every
 * raid by fingerprint and the "Recalculate" button (POST .../recompute, js/guild/pages-attendance.js recalcTeams) recalculates all of them, frozen ones included.
 *
 * THE AUTO-RUN (js/guild/pages-attendance.js autoRecalc): opening Attendance or Raids as someone who may edit the team's raids runs the banner's own loop over the stale
 * raids the Worker marks `autoRecalc` (every stale raid but a finished week the rules changed under), at most 30 per run, one run a minute per tab, never beside another loop.
 *
 * The Worker side runs over the b3 scenario (tests/guild-b3-world.js: America/New_York, region US, clock Friday 2027-01-15, so the running week began Tuesday 2027-01-12);
 * the pages side runs the real page scripts in a vm against that Worker, like the contract suites.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GUILD_SCRIPTS } = require('../guild-scripts');
const { scenario, runChecks, load } = require('../guild-b3-world');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const TZ = 'America/New_York';
const NOW = 1_800_000_000_000; // Friday 2027-01-15 03:00 in New York
const TODAY = '2027-01-15';
const WEEK_START = '2027-01-12'; // Tuesday: the US reset day
const at = (date, hour = 20) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00-05:00`);

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Worlds

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  s.pulls = 0;
  s.rid = (key) => `r_${key.replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'Z')}`;
  // A raid of a team (index) on a date. mode 'manual' = a hand-entered raid (evidence by itself), 'log' = a raid with a report whose log names `names`.
  s.raid = (key, team, on, { mode = 'manual', names = [], fp = 'fp' } = {}) => {
    const id = s.rid(key);
    s.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, policy_fp, version, created_at, updated_at)
            VALUES ('${id}', '${s.gid}', '${s.tids[team]}', '${on}', ${at(on)}, '${mode}', ${mode === 'manual' ? "'no log'" : 'NULL'}, '${fp}', 5, 1, 1)`);
    if (mode === 'log') {
      const code = `Code${s.pulls}Xx`.padEnd(16, 'X');
      s.exec(`INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('${id}', '${s.gid}', '${code}', 'fresh', ${at(on)}, 1)`);
      s.pulls += 1;
      s.exec(`INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (${s.pulls}, '${id}', '${code}', 1, 100, 'Boss', 1, ${at(on)}, ${at(on) + 1})`);
      for (const name of names) {
        s.exec(`INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm_key) VALUES (${s.pulls}, '${id}', '${s.gid}', '${name}', '${name.toLowerCase()}', 'nightslayer')`);
      }
    }
    return id;
  };
  s.marked = async () => (await s.rows("SELECT id FROM raids WHERE guild_id = ? AND policy_fp = '' ORDER BY id", s.gid)).map((row) => row.id);
  s.clean = () => s.exec("UPDATE raids SET policy_fp = 'fp', version = 5");
  s.recompute = (id) => s.ok('gm', 'POST', `/raids/${id}/recompute`, {}, 200);
  s.fingerprint = async (id) => (await s.one('SELECT policy_fp FROM raids WHERE id = ?', id)).policy_fp;
  s.listOf = async (team = 0) => (await s.ok('gm', 'GET', `/raids?team=${s.tids[team]}`)).raids;
  return s;
}

// ---------------------------------------------------------------------------
// The week line (pure) and the reset day (SQL)

check('weekStartsByResetDay is weekStart for each of the seven reset days; weekFreeze follows the guild-local date, not the UTC one', async () => {
  const calendar = await load('worker/attendance-calendar.js');
  const store = await load('worker/attendance-store.js');
  assert.deepEqual(calendar.weekStartsByResetDay(TODAY), [0, 1, 2, 3, 4, 5, 6].map((day) => calendar.weekStart(TODAY, day)));
  assert.deepEqual(calendar.weekStartsByResetDay(TODAY), ['2027-01-10', '2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15', '2027-01-09']);
  // 2027-01-13T03:00Z is still Tuesday evening in New York (2027-01-12 22:00): the Tuesday-reset week began that very day, not on the UTC Wednesday.
  const late = Date.parse('2027-01-13T03:00:00Z');
  assert.equal(JSON.parse(store.weekFreeze(TZ, late).starts)[2], '2027-01-12');
  assert.equal(JSON.parse(store.weekFreeze('UTC', late).starts)[2], '2027-01-12');
  const dawn = Date.parse('2027-01-13T05:00:00Z'); // 00:00 Wednesday in New York
  assert.equal(JSON.parse(store.weekFreeze(TZ, dawn).starts)[3], '2027-01-13');
  assert.equal(JSON.parse(store.weekFreeze(TZ, dawn).starts)[2], '2027-01-12');
  assert.equal(JSON.parse(store.weekFreeze('Pacific/Auckland', Date.parse('2027-01-12T11:30:00Z')).starts)[2], '2027-01-12', 'Auckland is already Wednesday 2027-01-13 (00:30): the week began on its Tuesday');
  assert.equal(JSON.parse(store.NO_FREEZE.starts).length, 7);
});

check('resetDaySql: the guild policy\'s resetDay, else the region\'s day (the resolver\'s rule); a value outside 0..6 reads as "from the region"', async () => {
  const s = await world();
  const store = await load('worker/attendance-store.js');
  const policy = await load('worker/attendance-policy.js');
  const sql = `SELECT ${store.resetDaySql('?1')} AS day`;
  const dayOf = async () => (await s.one(sql.replace('?1', `'${s.gid}'`))).day;
  const resolverDay = async () => {
    const guild = await s.one('SELECT * FROM guilds WHERE id = ?', s.gid);
    const rows = await s.rows('SELECT id, team_id, policy, version FROM attendance_policies WHERE guild_id = ?', s.gid);
    return store.makePolicyResolver(guild, rows).resetDay();
  };
  s.exec(`DELETE FROM attendance_policies WHERE guild_id = '${s.gid}'`);
  for (const [region, day] of [['US', 2], ['EU', 3], ['KR', 4], ['TW', 4]]) {
    s.exec(`UPDATE guilds SET region = '${region}' WHERE id = '${s.gid}'`);
    assert.equal(await dayOf(), day, region);
    assert.equal(await resolverDay(), day, `${region}: the resolver agrees`);
  }
  s.exec(`UPDATE guilds SET region = 'US' WHERE id = '${s.gid}'`);
  const put = (text) => s.exec(`DELETE FROM attendance_policies WHERE guild_id = '${s.gid}'; INSERT INTO attendance_policies (id, guild_id, team_id, policy, version, updated_at) VALUES ('ap_x', '${s.gid}', NULL, '${text}', 1, 1)`);
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    put(JSON.stringify({ resetDay: day }));
    assert.equal(await dayOf(), day, `override ${day}`);
    assert.equal(await resolverDay(), day, `override ${day}: the resolver agrees`);
  }
  put('{"resetDay":null}');
  assert.deepEqual([await dayOf(), await resolverDay()], [2, 2], 'null = from the region');
  put('{"expected":{"mode":"all"}}');
  assert.equal(await dayOf(), 2, 'a policy row without the key');
  for (const bad of ['{"resetDay":9}', '{"resetDay":-1}', '{"resetDay":"3"}', '{"resetDay":2.5}', '{"resetDay":true}', '[1,2]']) {
    put(bad);
    assert.equal(await dayOf(), 2, `${bad} reads as the region's day, never an error`);
  }
  // A team override never carries the reset day: only the guild row (team_id NULL) counts.
  s.exec(`DELETE FROM attendance_policies WHERE guild_id = '${s.gid}'; INSERT INTO attendance_policies (id, guild_id, team_id, policy, version, updated_at) VALUES ('ap_t', '${s.gid}', '${s.tids[0]}', '{"resetDay":5}', 1, 1)`);
  assert.equal(await dayOf(), 2);
  void policy;
});

// ---------------------------------------------------------------------------
// The marking statements

check('markRaidsStale: the team\'s evidence raids are marked while their week runs (any reset day), older ones only when the log names a changed character', async () => {
  const s = await world();
  const store = await load('worker/attendance-store.js');
  const calendar = await load('worker/attendance-calendar.js');
  const days = [];
  for (let i = 0; i < 28; i += 1) days.push(calendar.addDays('2026-12-24', i)); // 2026-12-24 .. 2027-01-20: past weeks, this week, upcoming
  const ids = new Map(days.map((day) => [day, s.raid(`a${day}`, 0, day)]));
  const named = s.raid('named_old', 1, '2026-12-20', { mode: 'log', names: ['Newbie'] }); // another team, a month old, its log names the character
  const unnamed = s.raid('unnamed_old', 1, '2026-12-21', { mode: 'log', names: ['Somebody'] });
  const noEvidence = s.raid('empty_now', 1, '2027-01-14', { mode: 'log' }); // this week, but nothing on it for a roster change to move
  const freeze = store.weekFreeze(TZ, NOW);
  for (const resetDay of [0, 1, 2, 3, 4, 5, 6]) {
    s.exec(`DELETE FROM attendance_policies WHERE guild_id = '${s.gid}'; INSERT INTO attendance_policies (id, guild_id, team_id, policy, version, updated_at) VALUES ('ap_r', '${s.gid}', NULL, '{"resetDay":${resetDay}}', 1, 1)`);
    s.clean();
    await s.w.db.batch([store.markRaidsStale(s.w.db, s.gid, ['newbie'], null, [s.tids[0]], null, freeze)]);
    const first = calendar.weekStart(TODAY, resetDay);
    const expected = [...days.filter((day) => day >= first).map((day) => ids.get(day)), named].sort();
    assert.deepEqual(await s.marked(), expected, `reset day ${resetDay}: raids from ${first} on, plus the log that names the character`);
    assert.ok(!(await s.marked()).includes(unnamed) && !(await s.marked()).includes(noEvidence));
  }
  // Without a freeze nothing is frozen (the unfrozen statement; every caller in worker/ passes one, see the source scan below).
  s.clean();
  await s.w.db.batch([store.markRaidsStale(s.w.db, s.gid, ['newbie'], null, [s.tids[0]])]);
  assert.deepEqual(await s.marked(), [...days.map((day) => ids.get(day)), named].sort());
});

check('markPersonRaidsStale: a person\'s teams\' evidence raids of the running week, plus any raid whose log names one of their characters', async () => {
  const s = await world();
  const store = await load('worker/attendance-store.js');
  const made = await s.person({ name: 'Newbie' });
  const thisWeek = s.raid('this_week', 0, '2027-01-13');
  const lastWeek = s.raid('last_week', 0, '2027-01-08');
  const namedOld = s.raid('named_old', 1, '2026-12-01', { mode: 'log', names: ['Newbie'] });
  const otherTeam = s.raid('other_team', 1, '2027-01-13');
  s.clean();
  await s.w.db.batch([store.markPersonRaidsStale(s.w.db, s.gid, made.pid, null, store.weekFreeze(TZ, NOW))]);
  assert.deepEqual(await s.marked(), [namedOld, thisWeek].sort());
  assert.ok(lastWeek && otherTeam);
  // The guard still ANDs: a failing guard marks nothing.
  s.clean();
  await s.w.db.batch([store.markPersonRaidsStale(s.w.db, s.gid, made.pid, { sql: '1 = 0', params: [] }, store.weekFreeze(TZ, NOW))]);
  assert.deepEqual(await s.marked(), []);
});

check('roster edits through the routes: add a person, change a status, move a character, remove one, delete a person', async () => {
  const s = await world();
  const old = s.raid('old_ev', 0, '2027-01-05'); // team Alpha's evidence in a finished week
  const now1 = s.raid('now_ev', 0, '2027-01-13'); // ... in the running week
  const named = s.raid('old_named', 1, '2026-12-28', { mode: 'log', names: ['Newbie'] });
  const bravoNow = s.raid('bravo_now', 1, '2027-01-14'); // team Bravo's evidence in the running week
  const run = async (label, fn, expected) => {
    s.clean();
    await fn();
    assert.deepEqual(await s.marked(), expected.sort(), label);
  };
  let made;
  await run('POST /roster (a new character on Alpha)', async () => { made = await s.person({ name: 'Newbie' }); }, [now1, named]);
  const aldric = await s.person({ name: 'Aldric' });
  const aldricAlt = await s.alt(aldric.pid, 'Aldrictwo');
  s.setTeam(aldricAlt, s.tids[1]); // an alt on Bravo
  await run('PATCH /roster/:pid (status)', () => s.ok('gm', 'PATCH', `/roster/${made.pid}`, { expectedVersion: made.res.person.version, status: 'reserve' }, 200), [now1, named]);
  await run('DELETE /roster/:pid/characters/:cid', () => s.ok('gm', 'DELETE', `/roster/${aldric.pid}/characters/${aldricAlt}`, undefined, 200), [bravoNow]);
  await run('DELETE /roster/:pid', () => s.ok('gm', 'DELETE', `/roster/${made.pid}`, undefined, 200), [now1, named]);
  assert.ok(old);
  for (const id of [old]) assert.equal(await s.fingerprint(id), 'fp', 'the finished week kept its result in every case');
});

check('a person join and a block take the same line: the teams involved lose their running-week raids to the mark, never a finished week without the name', async () => {
  const s = await world();
  const old = s.raid('old_ev', 0, '2027-01-05');
  const now1 = s.raid('now_ev', 0, '2027-01-13');
  const bravoOld = s.raid('bravo_old', 1, '2027-01-06');
  const bravoNow = s.raid('bravo_now', 1, '2027-01-14');
  const first = await s.person({ name: 'Joiner' });
  const second = await s.person({ name: 'Joinertwo', teamId: s.tids[1] });
  s.clean();
  const { joinPersonsStatements } = await load('worker/person-join.js');
  const plan = await joinPersonsStatements(s.w.db, { guildId: s.gid, aId: first.pid, bId: second.pid, actorUserId: s.uids.gm, now: NOW, reason: 'officer' });
  await s.w.db.batch(plan.statements);
  const survivor = (await s.rows('SELECT DISTINCT player_id FROM characters WHERE guild_id = ?', s.gid)).length;
  assert.equal(survivor, 1, 'one person now holds both characters');
  assert.deepEqual(await s.marked(), [bravoNow, now1].sort(), "the survivor's teams, the running week only");
  assert.ok(old && bravoOld);
  // A block takes the person off every team (worker/block-effects.js): the raids of the teams they left, the running week only.
  const third = await s.person({ name: 'Blockee' });
  s.clean();
  const { blockEffectStatements } = await load('worker/block-effects.js');
  await s.w.db.batch(await blockEffectStatements(s.w.db, { guildId: s.gid, target: { playerId: third.pid }, nowMs: NOW, guard: { sql: '1 = 1', params: [] }, timeZone: TZ }));
  assert.deepEqual(await s.marked(), [now1], "team Alpha's running week, not its finished one");
});

// The calls of the three marking functions in worker/: every one hands the statement the freeze line, so a new call site cannot quietly bring the churn back.
check('source scan: every markRaidsStale / markPersonRaidsStale / staleStatement call in worker/ passes a freeze; the inline marking statements read weekRunningSql', async () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`);
      else if (entry.name.endsWith('.js')) files.push(`${dir}/${entry.name}`);
    }
  };
  walk('worker');
  const callers = [];
  for (const file of files) {
    const text = read(file);
    const pattern = /\b(markRaidsStale|markPersonRaidsStale|staleStatement)\(/g;
    let match;
    while ((match = pattern.exec(text))) {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const line = text.slice(lineStart, text.indexOf('\n', match.index));
      if (/^\s*(export (function|const)|import|\/\/)/.test(line) || /^\s*\/\//.test(line)) continue;
      // The arguments: up to the matching close paren.
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < text.length; end += 1) {
        if (text[end] === '(') depth += 1;
        if (text[end] === ')') { depth -= 1; if (depth === 0) break; }
      }
      const args = text.slice(match.index, end + 1);
      callers.push({ file, call: match[1], args });
      assert.ok(/weekFreeze\(|\bfreeze\b/.test(args), `${file}: ${match[1]}(...) passes a freeze line:\n${args}`);
    }
  }
  assert.ok(callers.length >= 25, `found ${callers.length} callers`);
  for (const file of ['worker/rank-map.js', 'worker/roster-sync.js']) assert.match(read(file), /weekRunningSql\('\?', '\?'\)/, `${file}: the team-wide clause is limited to the running week`);
});

// ---------------------------------------------------------------------------
// The deliberate action: rules changes and the Recalculate button cover frozen raids

check('a rules change stales every raid; the list says which ones the page recalculates by itself; the recompute route recalculates a frozen raid like any other', async () => {
  const s = await world();
  const frozen = s.raid('frozen', 0, '2027-01-05');
  const frozen2 = s.raid('frozen2', 0, '2027-01-06');
  const running = s.raid('running', 0, '2027-01-13');
  for (const id of [frozen, frozen2, running]) await s.recompute(id);
  let list = await s.listOf();
  assert.deepEqual(list.map((r) => [r.stale, r.autoRecalc]), [[false, undefined], [false, undefined], [false, undefined]], 'recalculated: nobody is stale, and a fresh raid carries no flag');
  const team = () => s.ok('gm', 'GET', `/attendance/team?team=${s.tids[0]}`);
  assert.deepEqual([(await team()).staleRaids, (await team()).staleAuto], [0, 0]);
  // The rules change under all three.
  await s.ok('gm', 'PUT', '/attendance/policy', { teamId: null, policy: { tentative: 'asSignedUp' }, expectedVersion: 0 }, 200);
  list = await s.listOf();
  const by = (rid) => list.find((r) => r.id === rid);
  assert.deepEqual([by(running).stale, by(frozen).stale, by(frozen2).stale], [true, true, true], 'the rules stale every raid, the finished weeks too');
  assert.deepEqual([by(running).autoRecalc, by(frozen).autoRecalc, by(frozen2).autoRecalc], [true, false, false], 'only the running week recalculates by itself');
  assert.deepEqual([(await team()).staleRaids, (await team()).staleAuto], [3, 1]);
  // A roster edit that names the frozen raid\'s log marks it for real: it joins the automatic ones.
  s.exec(`UPDATE raids SET policy_fp = '' WHERE id = '${frozen2}'`);
  list = await s.listOf();
  assert.deepEqual([by(frozen).autoRecalc, by(frozen2).autoRecalc], [false, true], 'marked (policy_fp empty) = a roster or log mark, not a rules change');
  assert.deepEqual([(await team()).staleRaids, (await team()).staleAuto], [3, 2]);
  // The recompute route does not care about the freeze.
  const fresh = (await s.recompute(frozen)).state;
  assert.notEqual(fresh, 'stale');
  assert.notEqual(await s.fingerprint(frozen), '');
  list = await s.listOf();
  assert.deepEqual([by(frozen).stale, by(frozen).autoRecalc], [false, undefined]);
});

// ---------------------------------------------------------------------------
// The pages (real scripts, vm, the real Worker)

const SERVER_HEADERS = { Accept: 'application/json' };
const until = async (condition) => { for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(condition(), 'timed out'); };

function loadPages(s, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  G.requests = [];
  const f = async (urlPath, init = {}) => {
    G.requests.push(`${init.method || 'GET'} ${urlPath}`);
    return s.w.req(init.method || 'GET', urlPath, { jar, rawBody: init.body, headers: { ...SERVER_HEADERS, ...(init.headers || {}) } });
  };
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  G.errors = [];
  G.renders = 0;
  G.reloads = 0;
  G.app.render = () => { G.renders += 1; };
  G.app.handleError = (err) => { G.errors.push(err); };
  G.recomputes = () => G.requests.filter((line) => /^POST .*\/raids\/[^/]+\/recompute$/.test(line));
  return G;
}

// A fresh page state for the person: the guild payload, the team, and a route reload that opens the page again (what the app's routeAll does).
async function openPages(s, key, teamIndex = 0) {
  const G = loadPages(s, s.jars[key]);
  const gd = await G.api.get(s.base);
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: gd };
  S.currentGid = s.gid;
  S.pageAlert = '';
  G.app.teamFor = () => s.tids[teamIndex];
  G.gd = gd;
  G.open = {
    attendance: async () => { const route = { name: 'attendance', gid: s.gid }; await G.pages.attendance.load(route, gd); },
    raids: async () => { const route = { name: 'section', gid: s.gid, section: 'raids' }; await G.pages.raids.load(route, gd); },
  };
  G.app.routeAll = async () => { G.reloads += 1; };
  G.settle = async () => { await S.att.autoRun; };
  return G;
}

// Five raids that need an automatic recalculation after the roster edit: two in the running week and one whose log names the character, plus two that must stay alone.
async function staleWorld() {
  const s = await world();
  s.rec = {
    run1: s.raid('run1', 0, '2027-01-12'),
    run2: s.raid('run2', 0, '2027-01-13'),
    named: s.raid('named', 0, '2026-12-14', { mode: 'log', names: ['Newbie'] }),
    plain: s.raid('plain', 0, '2027-01-05'),
    plain2: s.raid('plain2', 0, '2026-12-28'),
  };
  for (const id of Object.values(s.rec)) await s.recompute(id);
  await s.person({ name: 'Newbie' }); // the roster edit: marks run1, run2 and named; plain and plain2 are finished weeks without the name
  s.w.advance(61_000); // the write window of the rate limit starts over
  return s;
}

check('opening Attendance recalculates the stale raids (the marked ones, frozen or not), through the banner\'s own loop, and leaves the finished weeks alone', async () => {
  const s = await staleWorld();
  assert.deepEqual(await s.marked(), [s.rec.named, s.rec.run1, s.rec.run2].sort());
  const G = await openPages(s, 'gm');
  const progress = [];
  const render = G.app.render;
  G.app.render = () => { render(); if (G.app.state.att.recalc) progress.push({ ...G.app.state.att.recalc }); };
  await G.open.attendance();
  assert.equal(G.app.state.att.team.data.staleAuto, 3, 'the team data counts the raids the page recalculates itself');
  await G.settle();
  assert.deepEqual(await s.marked(), [], 'all three are recalculated');
  assert.equal(G.recomputes().length, 3, 'one request per raid, none for the two finished weeks');
  assert.ok(progress.some((p) => p.running && p.total === 3), 'the existing progress notice ran (Recalculating n of 3)');
  assert.equal(G.reloads, 1, 'and the route was read again, like the button does');
  assert.equal(G.app.state.att.recalc, null);
  assert.equal(G.app.state.pageAlert, '');
});

check('opening Raids does the same from the list\'s own flags', async () => {
  const s = await staleWorld();
  const G = await openPages(s, 'gm');
  await G.open.raids();
  assert.ok(G.app.state.att.autoRun, 'a run started');
  await G.settle();
  assert.deepEqual(await s.marked(), []);
  assert.equal(G.recomputes().length, 3);
});

check('nothing runs without the permission, without a stale raid, or on the page of a team the person cannot edit', async () => {
  const s = await staleWorld();
  await s.member('erin', 'Erin');
  const member = await openPages(s, 'erin');
  await member.open.raids();
  await member.settle();
  assert.equal(member.recomputes().length, 0, 'a member sees the stale flags but starts no recalculation');
  assert.equal((await s.marked()).length, 3);
  assert.equal(member.app.state.att.autoRun, undefined);
  // A team lead of Bravo may edit Bravo's raids, not Alpha's.
  await s.lead('lena', [s.tids[1]], 'Lena');
  const lead = await openPages(s, 'lena', 0);
  await lead.open.raids();
  await lead.settle();
  assert.equal(lead.recomputes().length, 0, 'raids.edit on another team is not raids.edit on this one');
  // No stale raid: no request beyond the page's own reads.
  const officer = await openPages(s, 'gm');
  await officer.open.attendance();
  await officer.settle();
  assert.equal((await s.marked()).length, 0);
  const again = await openPages(s, 'gm');
  await again.open.attendance();
  await again.open.raids();
  await again.settle();
  assert.equal(again.recomputes().length, 0);
  assert.ok(!again.requests.some((line) => /\/raids\?team=.*&before=/.test(line)), 'and not even the list walk');
});

check('never two loops at once: two opens together, an open during the button\'s run, and an open right after a run start one loop', async () => {
  const s = await staleWorld();
  const G = await openPages(s, 'gm');
  const gd = G.gd;
  const auto = G.pages.attendance.autoRecalc;
  const [a, b] = [auto(gd, s.tids[0], true, 1000), auto(gd, s.tids[0], true, 1000)];
  await Promise.all([a, b]);
  assert.equal(G.recomputes().length, 3, 'one loop for two simultaneous opens');
  assert.equal((await s.marked()).length, 0);
  // Within the minute: nothing, even with fresh stale raids.
  s.exec("UPDATE raids SET policy_fp = '' WHERE id IN (SELECT id FROM raids LIMIT 2)");
  await auto(gd, s.tids[0], true, 30_000);
  assert.equal(G.recomputes().length, 3, 'a second open within the minute runs nothing');
  await auto(gd, s.tids[0], true, 61_001);
  assert.equal(G.recomputes().length, 5, 'after the minute the next open recalculates the two');
  // The button's loop (a long one) blocks an open.
  s.exec("UPDATE raids SET policy_fp = '' WHERE id IN (SELECT id FROM raids LIMIT 2)");
  G.app.state.att.recalc = { running: true, done: 0, total: 1, failed: 0 };
  await auto(gd, s.tids[0], true, 200_000);
  assert.equal(G.recomputes().length, 5, 'a running loop of this tab is never joined by a second');
  G.app.state.att.recalc = null;
  // A route reload after a run (what recalcDone triggers) opens the page again: its own run is inside the minute and starts nothing.
  const H = await openPages(s, 'gm');
  await H.open.attendance();
  await H.settle();
  const before = H.recomputes().length;
  s.exec("UPDATE raids SET policy_fp = '' WHERE id IN (SELECT id FROM raids LIMIT 2)");
  await H.open.attendance();
  await H.settle();
  assert.equal(H.recomputes().length, before, 'the reload right after a run is not a new open');
});

check('a run takes at most 30 raids, newest first, so one open stays inside the Worker\'s 60 writes a minute; the rest wait for the next open', async () => {
  const s = await world();
  const calendar = await load('worker/attendance-calendar.js');
  const ids = [];
  for (let i = 0; i < 33; i += 1) ids.push(s.raid(`bulk${i}`, 0, calendar.addDays('2026-12-01', i), { fp: '' })); // 2026-12-01 .. 2027-01-02, all marked (e.g. by a name)
  // They are all finished weeks: marked ones recalculate by themselves (a mark is not a rules change).
  const G = await openPages(s, 'gm');
  const gd = G.gd;
  s.w.advance(61_000);
  const list = await s.listOf();
  assert.equal(list.filter((r) => r.stale && r.autoRecalc === true).length, 33);
  await G.pages.attendance.autoRecalc(gd, s.tids[0], true, 1000);
  assert.equal(G.recomputes().length, 30);
  const left = await s.marked();
  assert.equal(left.length, 3);
  assert.deepEqual(left.sort(), ids.slice(0, 3).sort(), 'the three oldest wait');
  assert.equal((await s.rows("SELECT COUNT(*) AS n FROM raids WHERE policy_fp != ''"))[0].n, 30);
  s.w.advance(61_000);
  await G.pages.attendance.autoRecalc(gd, s.tids[0], true, 70_000);
  assert.equal(G.recomputes().length, 33);
  assert.deepEqual(await s.marked(), []);
});

check('the Recalculate button is the deliberate action: after a rules change it recalculates every stale raid, the finished weeks included, and the open leaves those alone', async () => {
  const s = await world();
  const frozenA = s.raid('frozenA', 0, '2027-01-05');
  const frozenB = s.raid('frozenB', 0, '2026-12-22');
  const running = s.raid('running', 0, '2027-01-13');
  for (const id of [frozenA, frozenB, running]) await s.recompute(id);
  await s.ok('gm', 'PUT', '/attendance/policy', { teamId: null, policy: { tentative: 'asSignedUp' }, expectedVersion: 0 }, 200);
  s.w.advance(61_000);
  const G = await openPages(s, 'gm');
  await G.open.attendance();
  await G.settle();
  assert.equal(G.app.state.att.team.data.staleRaids, 3);
  assert.equal(G.app.state.att.team.data.staleAuto, 1);
  assert.equal(G.recomputes().length, 1, 'the open recalculated the running week\'s raid only');
  const stillStale = async () => (await s.listOf()).filter((r) => r.stale).map((r) => r.id).sort();
  assert.deepEqual(await stillStale(), [frozenA, frozenB].sort(), 'the finished weeks wait for the button');
  // The banner's button.
  const gd = G.gd;
  const s2 = G.app.state;
  s2.guilds = { [s.gid]: gd };
  const reloads = G.reloads;
  G.handlers.click['att-recalc']();
  await until(() => G.reloads > reloads && !G.app.state.att.recalc);
  assert.deepEqual(await stillStale(), [], 'the button recalculated the finished weeks as well');
  assert.equal(G.recomputes().length, 3);
  assert.notEqual(await s.fingerprint(frozenB), '');
});

// ---------------------------------------------------------------------------

runChecks(process.argv[2] ? checks.filter((c) => c.name.includes(process.argv[2])) : checks);
