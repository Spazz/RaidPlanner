/**
 * Raidsmith guild tracker - the Planner plan of a raid in the database (migration 0027, worker/plan-doc.js, worker/routes/plan-doc.js) - Worker tests
 * Run: node tests/guild/guild-plandoc-worker-tests.js [name-filter]
 *
 *   - schema: one document per raid, composite FK to raids (cascade), the 256 KB CHECK
 *   - GET / PUT /raids/:rid/plan-doc: first write, revisions, 409 plan_conflict with the current plan, identical JSON = no-op, validation (400 plan_invalid
 *     with the field), 413, the poll (`?since`) reads no plan data when nothing changed
 *   - permissions: a member, another team's lead, another guild, nobody signed in
 *   - the projection into raid_plan / plan_label / plan_synced / version, only when the line-up changed
 *   - the legacy PUT / DELETE /plan also remove the document; sources.plan.full; raid delete cascades
 *   - audit: raid.plan on the first write, raid.plan_edit at most once per actor per raid per 30 minutes
 *   - GET /raid-for-event
 */
const assert = require('node:assert/strict');
const { adminOf, memberOf, makeWorld, signIn, person } = require('../guild-world');

const S1 = '900000000000000001';
const S2 = '900000000000000002';
const ALICE = person(1, 'Alice');
const BOB = person(2, 'Bob');
const CAROL = person(3, 'Carol');
const DAVE = person(4, 'Dave');
const FRANK = person(6, 'Frank');
const BODY = { serverId: S1, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };
const HALF_HOUR = 30 * 60 * 1000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// alice = Guild Master (edits everything), bob = plain member, carol = team lead of Alpha, dave = team lead of Bravo, frank = Guild Master of a second guild.
async function scenario() {
  const w = await makeWorld();
  const alice = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  const made = await w.call(alice, 'POST', '/api/guild', BODY);
  assert.equal(made.status, 201, made.text);
  const s = { w, guildId: made.json.guild.id, teams: made.json.teams.map((team) => team.id), jars: { alice }, ids: {} };
  for (const [name, who] of [['bob', BOB], ['carol', CAROL], ['dave', DAVE]]) s.jars[name] = (await signIn(w, who, [memberOf(S1)])).jar;
  for (const name of Object.keys(s.jars)) s.ids[name] = (await w.call(s.jars[name], 'GET', '/auth/me')).json.user.id;
  s.path = `/api/guild/${s.guildId}`;
  s.call = (who, method, tail, body, extra) => w.call(s.jars[who], method, `${s.path}${tail}`, body, extra);
  const roles = async (name, teamLeadTeamIds) => assert.equal((await w.call(alice, 'PUT', `${s.path}/people/${s.ids[name]}/roles`, { officer: false, teamLeadTeamIds })).status, 200);
  await roles('carol', [s.teams[0]]);
  await roles('dave', [s.teams[1]]);
  const raid = await s.call('alice', 'POST', '/raids', { teamId: s.teams[0], raidOn: '2027-02-20' });
  assert.equal(raid.status, 201, raid.text);
  s.rid = raid.json.raid.id;
  s.doc = (who, rid = s.rid) => ({
    get: (query = '') => s.call(who, 'GET', `/raids/${rid}/plan-doc${query}`),
    put: (body) => s.call(who, 'PUT', `/raids/${rid}/plan-doc`, body),
  });
  return s;
}

const NAMES = ['Aldric', 'Brindle', 'Cassia', 'Dunmar', 'Eliora', 'Fenwick', 'Garrick', 'Hollis', 'Isolde', 'Jorund'];
const member = (name) => ({ uid: `u-${name}`, name, class: 'WARRIOR', spec: 'Arms', role: 'dps', imported: false });
// A PlanStore.capture()-shaped plan: `groups` is a list of lists of names.
function planOf(rid, groups, extra = {}) {
  return {
    planId: `raid:${rid}`, groups: groups.map((names) => names.map(member)), bench: [], unplaced: [], campfires: [], gameVersion: 'tbc', selectedRaid: 'gruul',
    rosterName: 'Gruul night', sourceEventId: null, eventStartTime: null, optimizerMode: 'max_dps', buffOverrides: {}, preferredSlots: [], preserveGroupOrder: false,
    notes: '', sizeBenched: [], assignments: { tankHealers: {}, blessings: {}, debuffs: {} }, backups: {}, playerConstraints: [], drummers: [], ...extra,
  };
}
const planRows = (s, rid = s.rid) => s.w.rows('SELECT name, group_number FROM raid_plan WHERE raid_id = ? ORDER BY group_number, name', rid);
const raidRow = async (s, rid = s.rid) => (await s.w.rows('SELECT plan_label, plan_synced, version, policy_fp, plan_live FROM raids WHERE id = ?', rid))[0];
const auditRows = (s, rid = s.rid) => s.w.rows("SELECT action, actor_user_id, before, after FROM audit_log WHERE entity_id = ? AND action LIKE 'raid.plan%' ORDER BY rowid", rid);

check('migration 0027: one document per raid, a composite FK to the raid that cascades, and the 256 KB CHECK', async () => {
  const s = await scenario();
  const columns = s.w.db.sqlite.prepare("SELECT name FROM pragma_table_info('raid_plan_doc') ORDER BY cid").all().map((row) => row.name);
  assert.deepEqual(columns, ['raid_id', 'guild_id', 'rev', 'write_id', 'schema_ver', 'game_version', 'data', 'lineup_fp', 'created_by', 'created_at', 'updated_by', 'updated_at', 'audited_by', 'audited_at']);
  const fk = s.w.db.sqlite.prepare("SELECT \"table\" AS ref, \"from\" AS col, \"to\" AS target FROM pragma_foreign_key_list('raid_plan_doc') ORDER BY id, seq").all().map((row) => `${row.ref}:${row.col}>${row.target}`);
  assert.deepEqual(fk.sort(), ['raids:guild_id>guild_id', 'raids:raid_id>id', 'users:created_by>id', 'users:updated_by>id']);
  const insert = (data, rev = 1, raidId = s.rid, guildId = s.guildId) => s.w.db.prepare(
    "INSERT INTO raid_plan_doc (raid_id, guild_id, rev, write_id, game_version, data, lineup_fp, created_at, updated_at) VALUES (?, ?, ?, 'w', 'tbc', ?, 'fp', 1, 1)",
  ).bind(raidId, guildId, rev, data).run();
  await assert.rejects(() => insert('{"x":"' + 'a'.repeat(262144) + '"}'), /CHECK constraint/, 'over 262144 characters');
  await assert.rejects(() => insert('not json'), /CHECK constraint/);
  await assert.rejects(() => insert('{}', 0), /CHECK constraint/, 'rev starts at 1');
  await assert.rejects(() => insert('{}', 1, s.rid, 'g_other'), /FOREIGN KEY/, 'the guild must be the raid\'s guild');
  await insert('{}');
  await assert.rejects(() => insert('{}'), /UNIQUE|PRIMARY/, 'one document per raid');
  await s.call('alice', 'DELETE', `/raids/${s.rid}`, {});
  assert.equal(await s.w.count('raid_plan_doc'), 0, 'deleting the raid cascades');
});

check('GET with no document: rev 0, no plan, no legacy plan; with a pasted legacy plan the names and the live link come back', async () => {
  const s = await scenario();
  const empty = await s.doc('alice').get();
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.json, { rev: 0, changed: true, plan: null, legacy: null, live: null });
  assert.deepEqual((await s.doc('alice').get('?since=0')).json, { rev: 0, changed: false });
  assert.equal((await s.call('alice', 'PUT', `/raids/${s.rid}/plan`, { label: 'Pasted', players: [{ name: 'Aldric', group: 1 }, { name: 'Brindle', group: 0 }], live: 'Ab3dEfG' })).status, 200);
  const legacy = await s.doc('alice').get();
  assert.deepEqual(legacy.json, { rev: 0, changed: true, plan: null, legacy: { label: 'Pasted', players: [{ name: 'Aldric', group: 1 }, { name: 'Brindle', group: 0 }] }, live: 'Ab3dEfG' });
});

check('PUT: a first write (baseRev 0) stores the plan whole, GET returns it identically, unknown top-level keys are kept, the answer is small', async () => {
  const s = await scenario();
  const plan = planOf(s.rid, [NAMES.slice(0, 5), NAMES.slice(5)], { futureThing: { keep: ['me'] }, notes: 'MT swaps at 50%' });
  const put = await s.doc('alice').put({ baseRev: 0, plan, schemaVersion: 1 });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.json, { rev: 1, unchanged: false, updatedAt: s.w.clock.now });
  const got = await s.doc('alice').get();
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.plan, plan);
  assert.deepEqual({ rev: got.json.rev, changed: got.json.changed, schemaVersion: got.json.schemaVersion, updatedAt: got.json.updatedAt, updatedBy: got.json.updatedBy },
    { rev: 1, changed: true, schemaVersion: 1, updatedAt: s.w.clock.now, updatedBy: { name: 'Alice' } });
  const stored = (await s.w.rows('SELECT rev, schema_ver, game_version, created_by, updated_by, length(lineup_fp) AS fp FROM raid_plan_doc WHERE raid_id = ?', s.rid))[0];
  assert.deepEqual(stored, { rev: 1, schema_ver: 1, game_version: 'tbc', created_by: s.ids.alice, updated_by: s.ids.alice, fp: 14 });
  // A second write on the revision it started from: rev 2, and the plan changed.
  s.w.advance(1000);
  const second = await s.doc('alice').put({ baseRev: 1, plan: { ...plan, notes: 'MT swaps at 40%' } });
  assert.equal(second.json.rev, 2);
  assert.equal((await s.doc('alice').get()).json.plan.notes, 'MT swaps at 40%');
});

check('PUT: a stale baseRev loses with 409 plan_conflict and the current plan; baseRev 0 over an existing plan and baseRev > 0 without one lose too', async () => {
  const s = await scenario();
  const first = planOf(s.rid, [NAMES.slice(0, 5)]);
  const stale = await s.doc('alice').put({ baseRev: 3, plan: first });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'plan_conflict');
  assert.deepEqual({ rev: stale.json.rev, plan: stale.json.plan }, { rev: 0, plan: null }, 'no document yet');
  assert.equal(await s.w.count('raid_plan_doc'), 0);
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan: first })).status, 200);
  const mine = planOf(s.rid, [NAMES.slice(0, 4)]);
  const theirs = planOf(s.rid, [NAMES.slice(0, 3)]);
  assert.equal((await s.doc('carol').put({ baseRev: 1, plan: theirs })).json.rev, 2);
  const lost = await s.doc('alice').put({ baseRev: 1, plan: mine });
  assert.equal(lost.status, 409, lost.text);
  assert.equal(lost.json.error, 'plan_conflict');
  assert.deepEqual({ rev: lost.json.rev, plan: lost.json.plan, updatedBy: lost.json.updatedBy, schemaVersion: lost.json.schemaVersion }, { rev: 2, plan: theirs, updatedBy: { name: 'Carol' }, schemaVersion: 1 });
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan: mine })).status, 409, 'a first write over an existing plan');
  assert.deepEqual((await planRows(s)).map((row) => row.name), ['Aldric', 'Brindle', 'Cassia'], 'the loser projected nothing');
  assert.equal((await s.w.rows('SELECT rev FROM raid_plan_doc WHERE raid_id = ?', s.rid))[0].rev, 2);
});

check('PUT: identical JSON is a no-op - no new revision, no projection, no audit row, even from a stale baseRev', async () => {
  const s = await scenario();
  const plan = planOf(s.rid, [NAMES.slice(0, 5)]);
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan })).json.rev, 1);
  const before = { raid: await raidRow(s), audit: (await auditRows(s)).length, updated: (await s.w.rows('SELECT updated_at FROM raid_plan_doc'))[0].updated_at };
  s.w.advance(HALF_HOUR * 2);
  const again = await s.doc('carol').put({ baseRev: 1, plan });
  assert.deepEqual(again.json, { rev: 1, unchanged: true, updatedAt: before.updated });
  const stale = await s.doc('carol').put({ baseRev: 0, plan });
  assert.equal(stale.status, 200);
  assert.equal(stale.json.unchanged, true);
  assert.deepEqual({ raid: await raidRow(s), audit: (await auditRows(s)).length, updated: (await s.w.rows('SELECT updated_at FROM raid_plan_doc'))[0].updated_at }, before);
});

check('PUT validation: 400 plan_invalid names the field; nothing is written', async () => {
  const s = await scenario();
  const good = planOf(s.rid, [NAMES.slice(0, 5)]);
  const many = (count) => planOf(s.rid, [Array.from({ length: count }, (_, i) => `Pl${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`)]);
  const cases = [
    ['plan', { baseRev: 0, plan: 'nope' }],
    ['plan', { baseRev: 0, plan: [1] }],
    ['baseRev', { baseRev: -1, plan: good }],
    ['baseRev', { baseRev: '0', plan: good }],
    ['baseRev', { plan: good }],
    ['schemaVersion', { baseRev: 0, plan: good, schemaVersion: 2 }],
    ['schemaVersion', { baseRev: 0, plan: good, schemaVersion: 'x' }],
    ['source', { baseRev: 0, plan: good, source: 'cheese' }],
    ['planId', { baseRev: 0, plan: { ...good, planId: 'raid:r_other' } }],
    ['planId', { baseRev: 0, plan: { ...good, planId: undefined } }],
    ['gameVersion', { baseRev: 0, plan: { ...good, gameVersion: 'classic', selectedRaid: 'mc' } }],
    ['selectedRaid', { baseRev: 0, plan: { ...good, selectedRaid: 'mc' } }],
    ['selectedRaid', { baseRev: 0, plan: { ...good, selectedRaid: 'nope' } }],
    ['optimizerMode', { baseRev: 0, plan: { ...good, optimizerMode: 'turbo' } }],
    ['rosterName', { baseRev: 0, plan: { ...good, rosterName: 5 } }],
    ['rosterName', { baseRev: 0, plan: { ...good, rosterName: 'x'.repeat(301) } }],
    ['groups', { baseRev: 0, plan: { ...good, groups: [member('Aldric')] } }],
    ['groups', { baseRev: 0, plan: planOf(s.rid, Array.from({ length: 9 }, (_, i) => [NAMES[i]])) }],
    ['bench', { baseRev: 0, plan: { ...good, bench: {} } }],
    ['notes', { baseRev: 0, plan: { ...good, notes: 'x'.repeat(2001) } }],
    ['notes', { baseRev: 0, plan: { ...good, notes: null } }],
    ['buffOverrides', { baseRev: 0, plan: { ...good, buffOverrides: [] } }],
    ['backups', { baseRev: 0, plan: { ...good, backups: [] } }],
    ['sizeBenched', { baseRev: 0, plan: { ...good, sizeBenched: 'x' } }],
    ['playerConstraints', { baseRev: 0, plan: { ...good, playerConstraints: {} } }],
    ['drummers', { baseRev: 0, plan: { ...good, drummers: {} } }],
    ['unplaced', { baseRev: 0, plan: { ...good, unplaced: {} } }],
    ['players', { baseRev: 0, plan: { ...good, groups: [[{ name: 'Aldric', class: 'WARRIOR', spec: 'Arms', role: 'dps' }]] } }],
    ['players', { baseRev: 0, plan: { ...good, bench: [null] } }],
    ['players', { baseRev: 0, plan: { ...good, bench: [{ ...member('Aldric'), name: 'x'.repeat(81) }] } }],
    ['players', { baseRev: 0, plan: many(201) }],
    ['players', { baseRev: 0, plan: { ...many(150), unplaced: Array.from({ length: 51 }, () => ({})) } }],
  ];
  for (const [field, body] of cases) {
    const res = await s.doc('alice').put(body);
    assert.equal(res.status, 400, `${field}: ${res.text.slice(0, 200)}`);
    assert.equal(res.json.error, 'plan_invalid', field);
    assert.equal(res.json.field, field, `${field}: ${res.text.slice(0, 200)}`);
  }
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan: many(200) })).status, 200, '200 players is the limit');
  assert.equal(await s.w.count('raid_plan_doc'), 1);
  assert.equal(await s.w.count('raid_plan_doc', 'rev > 1'), 0);
});

check('PUT: 413 above the body cap and above 256 KB of plan; a plan just under the cap is saved and read back', async () => {
  const s = await scenario();
  const huge = await s.call('alice', 'PUT', `/raids/${s.rid}/plan-doc`, undefined, { rawBody: JSON.stringify({ baseRev: 0, plan: planOf(s.rid, [[]], { notes: 'n', pad: 'x'.repeat(270000) }) }) });
  assert.equal(huge.status, 413, huge.text.slice(0, 100));
  const justOver = await s.doc('alice').put({ baseRev: 0, plan: planOf(s.rid, [NAMES.slice(0, 5)], { pad: 'x'.repeat(262144) }) });
  assert.equal(justOver.status, 413, 'the plan alone is over the limit');
  assert.equal(await s.w.count('raid_plan_doc'), 0);
  const empty = planOf(s.rid, [NAMES.slice(0, 5)]);
  const room = 262144 - JSON.stringify({ ...empty, pad: '' }).length;
  const big = { ...empty, pad: 'x'.repeat(room) };
  assert.equal(JSON.stringify(big).length, 262144, 'exactly the limit');
  const saved = await s.doc('alice').put({ baseRev: 0, plan: big });
  assert.equal(saved.status, 200, saved.text.slice(0, 200));
  assert.deepEqual((await s.doc('alice').get()).json.plan, big);
});

check('the poll: ?since equal to the revision answers { rev, changed: false } and reads no plan data; a newer revision answers the plan', async () => {
  const s = await scenario();
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan: planOf(s.rid, [NAMES.slice(0, 5)]) })).json.rev, 1);
  const seen = [];
  const execute = s.w.db.execute.bind(s.w.db);
  s.w.db.execute = (statement) => { const result = execute(statement); seen.push({ sql: statement.sql, rows: result.results }); return result; };
  const quiet = await s.doc('carol').get('?since=1');
  assert.deepEqual(quiet.json, { rev: 1, changed: false });
  const docReads = seen.filter((entry) => /raid_plan_doc|raid_plan\b/.test(entry.sql));
  assert.equal(docReads.length, 1, 'one statement reads the plan tables');
  assert.equal(docReads[0].rows.length, 1);
  assert.equal(docReads[0].rows[0].data, null, 'the plan JSON is not read when nothing changed');
  assert.equal(seen.filter((entry) => /\braids\b/.test(entry.sql) && !/raid_plan_doc/.test(entry.sql) && /SELECT r\.\*/.test(entry.sql)).length, 0, 'not the heavy raid read');
  s.w.db.execute = execute;
  const moved = await s.doc('carol').get('?since=0');
  assert.equal(moved.json.changed, true);
  assert.equal(moved.json.rev, 1);
  assert.equal(moved.json.plan.planId, `raid:${s.rid}`);
  assert.deepEqual((await s.doc('carol').get('?since=7')).json.changed, true, 'any revision but the current one');
  assert.deepEqual((await s.doc('carol').get('?since=abc')).json.changed, true, 'a since that is not a number reads the plan');
});

check('permissions: a member, another team\'s lead, nobody signed in and another guild are refused; a raid of another guild is a 404', async () => {
  const s = await scenario();
  const plan = planOf(s.rid, [NAMES.slice(0, 5)]);
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan })).status, 200);
  for (const who of ['bob', 'dave']) {
    assert.equal((await s.doc(who).get()).status, 403, `${who} GET`);
    assert.equal((await s.doc(who).get('?since=1')).status, 403, `${who} poll`);
    assert.equal((await s.doc(who).put({ baseRev: 1, plan: { ...plan, notes: 'x' } })).status, 403, `${who} PUT`);
  }
  assert.equal((await s.doc('carol').get()).status, 200, 'the lead of the raid\'s team');
  assert.equal((await s.doc('carol').put({ baseRev: 1, plan: { ...plan, notes: 'x' } })).status, 200);
  assert.equal((await s.w.call({}, 'GET', `${s.path}/raids/${s.rid}/plan-doc`)).status, 401);
  assert.equal((await s.w.call({}, 'PUT', `${s.path}/raids/${s.rid}/plan-doc`, { baseRev: 2, plan })).status, 401);
  // Another guild: its Guild Master is not a member of this guild at all, and this guild's raid is not found in his guild.
  const frank = (await signIn(s.w, FRANK, [adminOf(S2)])).jar;
  const other = await s.w.call(frank, 'POST', '/api/guild', { ...BODY, serverId: S2, name: 'Other', multipleTeams: false, teamNames: undefined });
  assert.equal(other.status, 201, other.text);
  const otherPath = `/api/guild/${other.json.guild.id}`;
  assert.equal((await s.w.call(frank, 'GET', `${s.path}/raids/${s.rid}/plan-doc`)).status, 403);
  assert.equal((await s.w.call(frank, 'PUT', `${s.path}/raids/${s.rid}/plan-doc`, { baseRev: 2, plan })).status, 403);
  assert.equal((await s.w.call(frank, 'GET', `${otherPath}/raids/${s.rid}/plan-doc`)).status, 404, 'this guild\'s raid id under his own guild');
  assert.equal((await s.w.call(frank, 'PUT', `${otherPath}/raids/${s.rid}/plan-doc`, { baseRev: 2, plan })).status, 404);
  assert.equal((await s.w.call(s.jars.alice, 'GET', `${s.path}/raids/r_${'A'.repeat(22)}/plan-doc`)).status, 404, 'a raid that does not exist');
  assert.equal((await s.w.call(s.jars.alice, 'PUT', `${s.path}/raids/r_${'A'.repeat(22)}/plan-doc`, { baseRev: 0, plan })).status, 404);
  assert.equal((await s.w.rows('SELECT rev FROM raid_plan_doc'))[0].rev, 2, 'refused writes changed nothing');
});

check('projection: the line-up lands in raid_plan, plan_label and plan_synced, the raid is re-versioned; only a changed line-up projects again', async () => {
  const s = await scenario();
  const base = planOf(s.rid, [['Aldric', 'Brindle'], ['Cassia']], { bench: [member('Dunmar')], unplaced: [member('Eliora')] });
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan: base })).json.rev, 1);
  assert.deepEqual(await planRows(s), [{ name: 'Dunmar', group_number: 0 }, { name: 'Aldric', group_number: 1 }, { name: 'Brindle', group_number: 1 }, { name: 'Cassia', group_number: 2 }]);
  const first = await raidRow(s);
  assert.equal(first.plan_label, 'Gruul night');
  assert.equal(first.plan_synced, s.w.clock.now);
  assert.equal(first.policy_fp, '');
  const list = await s.call('alice', 'GET', `/raids?team=${s.teams[0]}`);
  assert.equal(list.json.upcoming.find((r) => r.id === s.rid).planned, true);
  const detail = (await s.call('alice', 'GET', `/raids/${s.rid}`)).json;
  assert.deepEqual({ label: detail.sources.plan.label, players: detail.sources.plan.players, full: detail.sources.plan.full }, { label: 'Gruul night', players: 4, full: true });
  // Notes, buffs and a shuffled group are not a new line-up: no re-projection, no version bump.
  s.w.advance(5000);
  const put = async (baseRev, plan) => { const res = await s.doc('alice').put({ baseRev, plan }); assert.equal(res.status, 200, res.text); return res; };
  await put(1, { ...base, notes: 'new notes', buffOverrides: { x: 1 } });
  await put(2, { ...base, notes: 'new notes', buffOverrides: { x: 1 }, groups: [[member('Brindle'), member('Aldric')], [member('Cassia')]] });
  assert.deepEqual(await raidRow(s), first, 'the raid row is untouched');
  // A move, a rename and a seat out re-project (and re-version).
  s.w.advance(5000);
  await put(3, { ...base, rosterName: 'Gruul   night 2', groups: [[member('Aldric')], [member('Cassia'), member('Brindle')]], bench: [] });
  assert.deepEqual(await planRows(s), [{ name: 'Aldric', group_number: 1 }, { name: 'Brindle', group_number: 2 }, { name: 'Cassia', group_number: 2 }]);
  const moved = await raidRow(s);
  assert.deepEqual({ label: moved.plan_label, synced: moved.plan_synced, version: moved.version, fp: moved.policy_fp }, { label: 'Gruul   night 2', synced: s.w.clock.now, version: first.version + 1, fp: '' });
  assert.equal(moved.plan_live, first.plan_live, 'plan_live is not touched');
});

check('projection: invalid and repeated names are skipped, 80 names at most, nobody seated = no plan at all', async () => {
  const s = await scenario();
  const letters = (i) => `Pl${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
  const mixed = planOf(s.rid, [['Aldric', 'x1!', 'ALDRIC', 'Brindle']], { bench: [member('Brindle'), member('Cassia')] });
  await s.doc('alice').put({ baseRev: 0, plan: mixed });
  assert.deepEqual(await planRows(s), [{ name: 'Cassia', group_number: 0 }, { name: 'Aldric', group_number: 1 }, { name: 'Brindle', group_number: 1 }], 'a seat wins over the bench');
  const crowd = planOf(s.rid, Array.from({ length: 8 }, (_, g) => Array.from({ length: 12 }, (__, i) => letters(g * 12 + i))));
  assert.equal((await s.doc('alice').put({ baseRev: 1, plan: crowd })).status, 200);
  assert.equal(await s.w.count('raid_plan', 'raid_id = ?', s.rid), 80);
  const benchOnly = planOf(s.rid, [[]], { bench: [member('Aldric')] });
  assert.equal((await s.doc('alice').put({ baseRev: 2, plan: benchOnly })).status, 200);
  assert.equal(await s.w.count('raid_plan', 'raid_id = ?', s.rid), 0);
  const empty = await raidRow(s);
  assert.deepEqual({ label: empty.plan_label, synced: empty.plan_synced }, { label: null, synced: null });
  const detail = (await s.call('alice', 'GET', `/raids/${s.rid}`)).json;
  assert.equal(detail.sources.plan, null, 'not planned: opening a plan alone never marks the raid');
  assert.equal((await s.doc('alice').get()).json.rev, 3, 'the document itself is kept');
});

check('attendance is recalculated only for a raid with a log or hand-entered presence', async () => {
  const s = await scenario();
  const plain = planOf(s.rid, [['Aldric']]);
  await s.doc('alice').put({ baseRev: 0, plan: plain });
  assert.equal((await raidRow(s)).policy_fp, '', 'an upcoming raid with no log has nothing to recalculate');
  const past = (await s.call('alice', 'POST', '/raids', { teamId: s.teams[0], raidOn: '2027-01-02' })).json.raid.id;
  assert.equal((await s.call('alice', 'PUT', `/raids/${past}/manual`, { reason: 'No log', presentPlayerIds: [] })).status, 200);
  const settled = (await raidRow(s, past)).policy_fp;
  assert.notEqual(settled, '', 'the manual raid is calculated');
  const res = await s.doc('alice', past).put({ baseRev: 0, plan: planOf(past, [['Aldric']]) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.recomputeFailed, undefined);
  assert.deepEqual((await planRows(s, past)).map((row) => row.name), ['Aldric']);
  assert.equal((await raidRow(s, past)).policy_fp, settled, 'recalculated again straight after the projection marked it stale');
});

check('legacy PUT /plan replaces the document too, legacy DELETE /plan removes it even when nobody is seated; sources.plan.full follows', async () => {
  const s = await scenario();
  await s.doc('alice').put({ baseRev: 0, plan: planOf(s.rid, [['Aldric', 'Brindle']]) });
  assert.equal((await s.call('alice', 'GET', `/raids/${s.rid}`)).json.sources.plan.full, true);
  const pasted = await s.call('alice', 'PUT', `/raids/${s.rid}/plan`, { label: 'Pasted', players: [{ name: 'Cassia', group: 2 }] });
  assert.equal(pasted.status, 200, pasted.text);
  assert.equal(await s.w.count('raid_plan_doc'), 0, 'the pasted plan replaced the full plan');
  assert.equal(pasted.json.sources.plan.full, false);
  assert.deepEqual(await planRows(s), [{ name: 'Cassia', group_number: 2 }]);
  assert.deepEqual((await s.doc('alice').get()).json.legacy.players, [{ name: 'Cassia', group: 2 }]);
  // A document nobody sits in has no projection (plan_synced is NULL): the DELETE still removes it.
  await s.doc('alice').put({ baseRev: 0, plan: planOf(s.rid, [[]], { bench: [member('Aldric')] }) });
  assert.equal(await s.w.count('raid_plan_doc'), 1);
  assert.equal((await s.call('alice', 'DELETE', `/raids/${s.rid}/plan`, {})).status, 200);
  assert.equal(await s.w.count('raid_plan_doc'), 0);
  assert.equal(await s.w.count('raid_plan', 'raid_id = ?', s.rid), 0);
  const rows = await auditRows(s);
  const last = rows[rows.length - 1];
  assert.deepEqual([last.action, JSON.parse(last.before), JSON.parse(last.after)], ['raid.plan', { plan: true, full: true }, { plan: false }]);
  const replaced = rows.find((row) => JSON.parse(row.after).source === 'legacy');
  assert.deepEqual(JSON.parse(replaced.before), { plan: true, full: true });
  assert.deepEqual(JSON.parse(replaced.after), { players: 1, live: false, source: 'legacy' });
  // After the legacy delete the raid takes a new document from baseRev 0.
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan: planOf(s.rid, [['Aldric']]) })).json.rev, 1);
});

check('deleting the raid removes its document and projection', async () => {
  const s = await scenario();
  await s.doc('alice').put({ baseRev: 0, plan: planOf(s.rid, [['Aldric']]) });
  assert.equal((await s.call('alice', 'DELETE', `/raids/${s.rid}`, {})).status, 200);
  assert.equal(await s.w.count('raid_plan_doc'), 0);
  assert.equal(await s.w.count('raid_plan', 'raid_id = ?', s.rid), 0);
  assert.equal((await s.doc('alice').get()).status, 404);
  assert.equal((await s.doc('alice').put({ baseRev: 0, plan: planOf(s.rid, [['Aldric']]) })).status, 404);
});

check('audit: raid.plan on the first write (with its source), raid.plan_edit at most once per actor per raid per 30 minutes', async () => {
  const s = await scenario();
  const plan = planOf(s.rid, [NAMES.slice(0, 4)]);
  await s.doc('alice').put({ baseRev: 0, plan, source: 'local' });
  const revise = (rev, extra, who = 'alice') => s.doc(who).put({ baseRev: rev, plan: { ...plan, ...extra } });
  s.w.advance(60 * 1000);
  assert.equal((await revise(1, { notes: 'a' })).json.rev, 2);
  s.w.advance(60 * 1000);
  assert.equal((await revise(2, { notes: 'b' })).json.rev, 3);
  let rows = await auditRows(s);
  assert.deepEqual(rows.map((row) => row.action), ['raid.plan'], 'the same officer editing within the half hour adds nothing');
  assert.deepEqual([JSON.parse(rows[0].before), JSON.parse(rows[0].after)], [{ plan: false }, { players: 4, source: 'local' }]);
  assert.equal(rows[0].actor_user_id, s.ids.alice);
  // Another officer is its own row at once; then alice again after the window.
  s.w.advance(60 * 1000);
  assert.equal((await revise(3, { notes: 'c' }, 'carol')).json.rev, 4);
  rows = await auditRows(s);
  assert.deepEqual(rows.map((row) => [row.action, row.actor_user_id]), [['raid.plan', s.ids.alice], ['raid.plan_edit', s.ids.carol]]);
  assert.deepEqual(JSON.parse(rows[1].after), { players: 4 });
  assert.equal(rows[1].before, null);
  s.w.advance(HALF_HOUR - 1000);
  await revise(4, { notes: 'd' }, 'carol');
  assert.equal((await auditRows(s)).length, 2, 'carol again inside her half hour');
  s.w.advance(2000);
  await revise(5, { notes: 'e' }, 'carol');
  assert.equal((await auditRows(s)).length, 3, 'a new half hour');
  await revise(6, { notes: 'f' }, 'alice');
  assert.equal((await auditRows(s)).length, 4, 'alice\'s last row was long ago and carol edited since');
  const stamp = (await s.w.rows('SELECT audited_by, audited_at FROM raid_plan_doc'))[0];
  assert.deepEqual(stamp, { audited_by: s.ids.alice, audited_at: s.w.clock.now });
  // The Activity log words both actions.
  const log = await s.call('alice', 'GET', '/audit');
  assert.equal(log.status, 200, log.text);
  const sentences = log.json.rows.map((row) => row.text);
  assert(sentences.some((text) => /^Attached a plan of 4 players to the raid on /.test(text)), sentences.join(' | '));
  assert(sentences.some((text) => /^Edited the plan of the raid on .*: 4 players seated$/.test(text)), sentences.join(' | '));
});

check('the shared writer limit (60 a minute) covers plan-doc writes and answers 429 with Retry-After', async () => {
  const s = await scenario();
  const plan = planOf(s.rid, [['Aldric']]);
  let last;
  for (let i = 0; i < 61; i++) last = await s.doc('alice').put({ baseRev: 0, plan: { ...plan, notes: `n${i}` } });
  assert.equal(last.status, 429);
  assert(Number(last.headers.get('Retry-After')) >= 1);
  assert.equal((await s.doc('alice').get('?since=0')).status, 200, 'reads (the poll) are not limited');
});

check('GET /raid-for-event: the raid made from that event for someone who may edit its team, else { raid: null }; a bad id is a 400', async () => {
  const s = await scenario();
  const EVENT = '1483258698854826006';
  await s.w.db.prepare('UPDATE raids SET event_id = ?, event_title = ?, title = NULL WHERE id = ?').bind(EVENT, 'Gruul clear', s.rid).run();
  const ask = (who, event = EVENT) => s.call(who, 'GET', `/raid-for-event?event=${event}`);
  const found = await ask('alice');
  assert.equal(found.status, 200, found.text);
  assert.deepEqual(found.json, { raid: { id: s.rid, raidOn: '2027-02-20', title: 'Gruul clear', teamId: s.teams[0] } });
  assert.deepEqual((await ask('carol')).json.raid && (await ask('carol')).json.raid.id, s.rid);
  await s.w.db.prepare("UPDATE raids SET title = 'Custom' WHERE id = ?").bind(s.rid).run();
  assert.equal((await ask('alice')).json.raid.title, 'Custom');
  assert.deepEqual((await ask('dave')).json, { raid: null }, 'another team\'s lead');
  assert.deepEqual((await ask('bob')).json, { raid: null }, 'a member');
  assert.deepEqual((await ask('alice', '123456')).json, { raid: null });
  for (const bad of ['', '12345', 'abc', `${EVENT}9999999`, '12%2034']) assert.equal((await ask('alice', bad)).status, 400, `event=${bad}`);
  assert.equal((await s.w.call({}, 'GET', `${s.path}/raid-for-event?event=${EVENT}`)).status, 401);
  const frank = (await signIn(s.w, FRANK, [adminOf(S2)])).jar;
  assert.equal((await s.w.call(frank, 'POST', '/api/guild', { ...BODY, serverId: S2, name: 'Other', multipleTeams: false, teamNames: undefined })).status, 201);
  assert.equal((await s.w.call(frank, 'GET', `${s.path}/raid-for-event?event=${EVENT}`)).status, 403, 'not a member of this guild');
});

async function main() {
  const filter = process.argv[2];
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
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 30).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
