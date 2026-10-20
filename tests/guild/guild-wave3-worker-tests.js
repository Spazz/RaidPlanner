/**
 * Raidsmith guild tracker - PM wave 3 Worker tests (recruiting and the WoW Forever launch).
 * Run: node tests/guild/guild-wave3-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/guild-world.js): the class and spec intent board, recruitment needs, the applications
 * inbox with its public form, the CSV roster import and the version-aware default team size. No network, no Wrangler, no real time.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load, adminOf, memberOf, makeWorld, signIn, newJar } = require('../guild-world');

const SERVER = '900000000000000021';
// Discord IDs of 18 digits (a person can be linked to one: the roster checks the length).
const person = (n, name) => ({ id: `1100000000000000${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = {
  gm: person(31, 'Gmwave'), officer: person(32, 'Officerwave'), lead: person(33, 'Leadwave'),
  m1: person(34, 'Memberone'), m2: person(35, 'Membertwo'), stranger: person(36, 'Strangerwave'),
};
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const filter = process.argv[2] || '';

// A guild with a Guild Master, optionally members signed in (they join through the Discord server), and helpers that talk to the Worker as one of them.
async function scenario({ version = 'tbc', teams = 1, members = [], leads = [], officers = [] } = {}) {
  const w = await makeWorld({});
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const realm = version === 'forever' ? 'Normal' : 'Nightslayer';
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Wave Three', gameVersion: version, region: 'US', realm, timeZone: 'America/New_York',
    multipleTeams: teams > 1, ...(teams > 1 ? { teamNames: ['Alpha', 'Bravo', 'Charlie'].slice(0, teams) } : {}),
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  const uids = {};
  for (const key of new Set([...members, ...leads, ...officers])) {
    jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  const s = {
    w, gid, tids, tid: tids[0], jars, uids, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) {
      w.advance(STEP);
      return w.call(jars[who], method, tail.startsWith('/api/') || tail.startsWith('/auth/') ? tail : `${s.base}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    // A person on the roster; link: the key of a signed-in member whose account becomes theirs.
    async person({ name, cls = 'WARRIOR', spec = 'Arms', status = 'raider', team = tids[0], link = null, joinedOn } = {}) {
      const body = { teamId: team, name, class: cls, mainSpec: spec, offSpec: null, status };
      if (link) body.linkUserId = uids[link];
      if (joinedOn) body.joinedOn = joinedOn;
      const res = await s.ok('gm', 'POST', '/roster', body);
      return { pid: res.person.id, cid: res.characters[0].id };
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
  };
  for (const key of officers) await s.ok('gm', 'PUT', `/people/${uids[key]}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  for (const key of leads) await s.ok('gm', 'PUT', `/people/${uids[key]}/roles`, { officer: false, teamLeadTeamIds: [tids[0]] }, 200);
  return s;
}

const CLASS_NAMES = { WARRIOR: 'Warrior', PALADIN: 'Paladin', HUNTER: 'Hunter', ROGUE: 'Rogue', PRIEST: 'Priest', SHAMAN: 'Shaman', MAGE: 'Mage', WARLOCK: 'Warlock', DRUID: 'Druid' };

// ---------------------------------------------------------------------------
// 5. Version-aware default team size

check('default team size: a new guild\'s teams and an added team start at the version\'s usual size; an explicit size still wins', async () => {
  const { defaultTeamSize, DEFAULT_TEAM_SIZES } = await load('worker/raid-zones.js');
  assert.deepEqual(DEFAULT_TEAM_SIZES, { tbc: 25, classic: 40, forever: 20 });
  assert.equal(defaultTeamSize('nope'), 25);
  for (const [version, size] of [['tbc', 25], ['classic', 40], ['forever', 20]]) {
    const s = await scenario({ version, teams: 2 });
    const teams = (await s.ok('gm', 'GET', '')).teams;
    assert.deepEqual(teams.map((t) => t.size), [size, size], `${version}: the teams made with the guild`);
    const added = await s.ok('gm', 'POST', '/teams', { name: 'Delta' });
    assert.equal(added.team.size, size, `${version}: an added team`);
    const explicit = await s.ok('gm', 'POST', '/teams', { name: 'Echo', size: 10 });
    assert.equal(explicit.team.size, 10);
    const changed = await s.ok('gm', 'PATCH', `/teams/${added.team.id}`, { size: 40 }, 200);
    assert.equal(changed.team.size, 40, 'editable as before');
  }
});

// ---------------------------------------------------------------------------
// Role data

check('recruit-data: the four raid roles follow the catalog (melee_dps melee; ranged_dps and caster_dps ranged), defaults and targets', async () => {
  const data = await load('worker/recruit-data.js');
  const { SPECS } = await load('worker/roster-data.js');
  // The catalog is a browser script: run it in a vm to read its spec roles.
  const sandbox = { window: undefined, globalThis: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`${fs.readFileSync(path.join(__dirname, '..', '..', 'js/rules/catalog.js'), 'utf8')}\nthis.__catalog = RulesData.catalog;`, sandbox);
  const catalog = sandbox.__catalog;
  const toRaid = { tank: 'tank', healer: 'healer', melee_dps: 'melee', ranged_dps: 'ranged', caster_dps: 'ranged' };
  for (const [classId, specs] of Object.entries(SPECS)) {
    for (const spec of specs) {
      const planner = spec.startsWith('Feral') ? { name: 'Feral', role: /Tank/.test(spec) ? 'tank' : 'melee_dps' } : Object.values(catalog.specs[classId]).find((entry) => entry.name === spec);
      assert(planner, `${classId} ${spec} is in the catalog`);
      assert.equal(data.raidRoleOf(classId, spec), toRaid[planner.role], `${classId} ${spec}`);
    }
  }
  assert.equal(data.raidRoleOf('WARRIOR', 'Nonsense'), null);
  assert.equal(data.raidRoleOf('NOPE', 'Arms'), null);
  assert.deepEqual(data.defaultTargets(25), { tank: 3, healer: 6, melee: 8, ranged: 8 });
  assert.deepEqual(data.defaultTargets(20), { tank: 2, healer: 5, melee: 7, ranged: 6 });
  assert.deepEqual(data.defaultTargets(10), { tank: 2, healer: 3, melee: 3, ranged: 2 });
  assert.deepEqual(data.defaultTargets(40), { tank: 4, healer: 10, melee: 13, ranged: 13 });
  assert.deepEqual(data.defaultTargets(33), { tank: 3, healer: 6, melee: 8, ranged: 8 }, 'an unknown size falls back to 25');
  for (const size of [10, 20, 25, 40]) assert.equal(Object.values(data.defaultTargets(size)).reduce((a, b) => a + b, 0), size, `${size}-man defaults add up`);
  assert.deepEqual(data.readTargets({ tank: 1, healer: 2, melee: 3, ranged: 4 }), { ok: true, value: { tank: 1, healer: 2, melee: 3, ranged: 4 } });
  for (const bad of [null, [], { tank: 1 }, { tank: -1, healer: 0, melee: 0, ranged: 0 }, { tank: 1.5, healer: 0, melee: 0, ranged: 0 }, { tank: 100, healer: 0, melee: 0, ranged: 0 }, { tank: '1', healer: 0, melee: 0, ranged: 0 }]) {
    assert.equal(data.readTargets(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(data.targetsOf(null, 25), { targets: data.defaultTargets(25), custom: false });
  assert.deepEqual(data.targetsOf('{"tank":1,"healer":1,"melee":1,"ranged":1}', 25), { targets: { tank: 1, healer: 1, melee: 1, ranged: 1 }, custom: true });
  assert.deepEqual(data.targetsOf('not json', 10), { targets: data.defaultTargets(10), custom: false });
  const { counts, unknown } = data.countRoles([{ class: 'WARRIOR', spec: 'Protection' }, { class: 'HUNTER', spec: 'Survival' }, { class: 'MAGE', spec: null }, { class: 'DRUID', spec: 'Feral (Tank)' }]);
  assert.deepEqual(counts, { tank: 2, healer: 0, melee: 0, ranged: 1 });
  assert.equal(unknown, 1);
  assert.deepEqual(data.gapsOf({ tank: 1, healer: 7, melee: 8, ranged: 0 }, { tank: 3, healer: 6, melee: 8, ranged: 8 }), { tank: 2, healer: -1, melee: 0, ranged: 8 });
});

// ---------------------------------------------------------------------------
// 1. Intent board

async function intentScenario() {
  const s = await scenario({ version: 'forever', members: ['m1', 'm2'], officers: ['officer'], leads: ['lead'] });
  s.warrior = await s.person({ name: 'Thornwick', cls: 'WARRIOR', spec: 'Arms', link: 'm1' });
  s.priest = await s.person({ name: 'Mendra', cls: 'PRIEST', spec: 'Holy', link: 'm2' });
  s.rogue = await s.person({ name: 'Quillfeather', cls: 'ROGUE', spec: 'Combat' });
  return s;
}

check('intent: officers open a round (one open per team), the board starts empty with the people who may pick, members cannot open or close', async () => {
  const s = await intentScenario();
  const empty = await s.ok('m1', 'GET', `/intent?team=${s.tid}`);
  assert.equal(empty.round, null);
  assert.deepEqual([empty.canEdit, empty.canPick, empty.picks, empty.rounds], [false, false, [], []]);
  assert.deepEqual(empty.targets, { tank: 2, healer: 5, melee: 7, ranged: 6 }, 'the forever 20-man defaults');
  assert.equal(empty.team.size, 20);
  assert.equal(empty.roles.WARRIOR.Protection, 'tank');
  assert.equal(empty.roles.MAGE.Fire, 'ranged');
  // Members cannot open; the officer can; a second open is a 409.
  assert.equal((await s.call('m1', 'POST', `/teams/${s.tid}/intent`, { title: 'WoW Forever launch' })).status, 403);
  assert.equal((await s.call('officer', 'POST', `/teams/${s.tid}/intent`, { title: '   ' })).status, 400);
  assert.equal((await s.call('officer', 'POST', `/teams/${s.tid}/intent`, { title: 'x'.repeat(81) })).status, 400);
  assert.equal((await s.call('officer', 'POST', `/teams/${s.tid}/intent`, { title: 'Launch', closesOn: 'soon' })).status, 400);
  assert.equal((await s.call('officer', 'POST', `/teams/${s.tid}/intent`, { title: 'Launch', closesOn: '2001-01-01' })).status, 400, 'not in the past');
  const opened = await s.ok('officer', 'POST', `/teams/${s.tid}/intent`, { title: 'WoW Forever launch', closesOn: '2030-11-04' });
  assert.equal(opened.round.title, 'WoW Forever launch');
  assert.equal(opened.round.status, 'open');
  assert.equal(opened.round.closesOn, '2030-11-04');
  assert.equal(opened.canEdit, true);
  assert.deepEqual(opened.undecided.map((u) => u.name).sort(), ['Mendra', 'Quillfeather', 'Thornwick']);
  const again = await s.call('officer', 'POST', `/teams/${s.tid}/intent`, { title: 'Another' });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'intent_open');
  // A member sees the open round and may pick (their person is on the team).
  const seen = await s.ok('m1', 'GET', `/intent?team=${s.tid}`);
  assert.equal(seen.round.id, opened.round.id);
  assert.equal(seen.canPick, true);
  assert.equal(seen.myPersonId, s.warrior.pid);
  assert.equal((await s.call('m1', 'PATCH', `/intent/${opened.round.id}`, { status: 'closed' })).status, 403);
  // Audit: who opened it.
  const audit = await s.rows("SELECT action, entity_type FROM audit_log WHERE guild_id = ? AND action LIKE 'intent.%'", s.gid);
  assert.deepEqual(audit, [{ action: 'intent.open', entity_type: 'intent' }]);
});

check('intent: a member picks a main and an alt for themselves; the board adds up by role and class; an officer picks for someone else; others cannot', async () => {
  const s = await intentScenario();
  const { round } = await s.ok('officer', 'POST', `/teams/${s.tid}/intent`, { title: 'Launch' });
  const pick = (who, pid, body, status) => s.call(who, 'PUT', `/intent/${round.id}/picks/${pid}`, body);
  // An alt needs a main first.
  let res = await pick('m1', s.warrior.pid, { kind: 'alt', class: 'MAGE', spec: 'Fire' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'main_first');
  // Validation: kind, class, a spec of the class, a note of 120 characters.
  assert.equal((await pick('m1', s.warrior.pid, { kind: 'third', class: 'WARRIOR', spec: 'Arms' })).status, 400);
  assert.equal((await pick('m1', s.warrior.pid, { kind: 'main', class: 'NOPE', spec: 'Arms' })).status, 400);
  assert.equal((await pick('m1', s.warrior.pid, { kind: 'main', class: 'WARRIOR', spec: 'Holy' })).status, 400);
  const longNote = await pick('m1', s.warrior.pid, { kind: 'main', class: 'WARRIOR', spec: 'Protection', note: 'n'.repeat(121) });
  assert.equal(longNote.status, 400);
  assert.equal(longNote.json.field, 'note');
  // The member's own pick: the role follows from the spec.
  res = await pick('m1', s.warrior.pid, { kind: 'main', class: 'WARRIOR', spec: 'Protection', note: '  tanking   at launch ' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.picks.map((p) => [p.name, p.kind, p.class, p.spec, p.role, p.note, p.mine]), [['Thornwick', 'main', 'WARRIOR', 'Protection', 'tank', 'tanking at launch', true]]);
  res = await pick('m1', s.warrior.pid, { kind: 'alt', class: 'DRUID', spec: 'Feral (DPS)' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.picks.filter((p) => p.kind === 'alt').map((p) => p.role), ['melee']);
  // The same member cannot pick for somebody else; an officer can.
  assert.equal((await pick('m1', s.priest.pid, { kind: 'main', class: 'PRIEST', spec: 'Holy' })).status, 403);
  assert.equal((await pick('m1', s.rogue.pid, { kind: 'main', class: 'ROGUE', spec: 'Combat' })).status, 403);
  res = await pick('officer', s.rogue.pid, { kind: 'main', class: 'MAGE', spec: 'Fire' });
  assert.equal(res.status, 200, res.text);
  res = await pick('m2', s.priest.pid, { kind: 'main', class: 'PRIEST', spec: 'Holy' });
  assert.equal(res.status, 200);
  // The board: totals by role and class, undecided empty, mine only for the viewer.
  const board = await s.ok('m2', 'GET', `/intent?team=${s.tid}`);
  assert.deepEqual(board.totals.byRole, { tank: 1, healer: 1, melee: 0, ranged: 1 });
  assert.equal(board.totals.mains, 3);
  assert.equal(board.totals.alts, 1);
  assert.deepEqual([board.totals.byClass.WARRIOR, board.totals.byClass.PRIEST, board.totals.byClass.MAGE, board.totals.byClass.ROGUE], [1, 1, 1, 0]);
  assert.deepEqual(board.undecided, []);
  assert.deepEqual(board.picks.filter((p) => p.mine).map((p) => p.name), ['Mendra']);
  // Changing a pick replaces it (one main per person); removing the main takes the alt with it.
  res = await pick('m1', s.warrior.pid, { kind: 'main', class: 'WARRIOR', spec: 'Fury' });
  assert.equal(res.json.picks.filter((p) => p.personId === s.warrior.pid && p.kind === 'main')[0].role, 'melee');
  res = await s.call('m1', 'DELETE', `/intent/${round.id}/picks/${s.warrior.pid}`, { kind: 'main' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.picks.filter((p) => p.personId === s.warrior.pid).length, 0, 'the alt went with the main');
  assert.equal(res.json.undecided.map((u) => u.name).join(), 'Thornwick');
  assert.equal((await s.call('m1', 'DELETE', `/intent/${round.id}/picks/${s.warrior.pid}`, { kind: 'main' })).status, 404, 'nothing left to remove');
  assert.equal((await s.call('m1', 'DELETE', `/intent/${round.id}/picks/${s.priest.pid}`, { kind: 'main' })).status, 403);
  // Audit rows: picks and un-picks, ids and flags only (no note text).
  const audit = await s.rows("SELECT action, after FROM audit_log WHERE guild_id = ? AND action LIKE 'intent.%' ORDER BY created_at, id", s.gid);
  assert(audit.some((row) => row.action === 'intent.pick') && audit.some((row) => row.action === 'intent.unpick'));
  assert(!audit.some((row) => /tanking/.test(row.after || '')), 'no note text in the log');
});

check('intent: a team lead edits only their team; people off the team, inactive people and archived teams cannot pick; closing freezes the round and it stays readable', async () => {
  const s = await scenario({ version: 'tbc', teams: 2, members: ['m1'], leads: ['lead'], officers: ['officer'] });
  const onAlpha = await s.person({ name: 'Alphaperson', team: s.tids[0], link: 'm1' });
  const onBravo = await s.person({ name: 'Bravoperson', team: s.tids[1] });
  const { round } = await s.ok('lead', 'POST', `/teams/${s.tids[0]}/intent`, { title: 'Alpha launch' });
  assert.equal((await s.call('lead', 'POST', `/teams/${s.tids[1]}/intent`, { title: 'Bravo launch' })).status, 403, 'the lead leads Alpha only');
  const pick = (who, iid, pid, extra = {}) => s.call(who, 'PUT', `/intent/${iid}/picks/${pid}`, { kind: 'main', class: 'WARRIOR', spec: 'Arms', ...extra });
  assert.equal((await pick('officer', round.id, onBravo.pid)).status, 409, 'a person of another team');
  assert.equal((await pick('m1', round.id, onAlpha.pid)).status, 200);
  // An inactive person cannot pick.
  await s.ok('gm', 'PATCH', `/roster/${onAlpha.pid}`, { status: 'inactive', leftReason: 'break', expectedVersion: 1 }, 200);
  assert.equal((await pick('officer', round.id, onAlpha.pid)).status, 409);
  await s.ok('gm', 'PATCH', `/roster/${onAlpha.pid}`, { status: 'raider', expectedVersion: 2 }, 200);
  // Close: a second close and any pick after it are refused; the round is still there, with its picks.
  const closed = await s.ok('lead', 'PATCH', `/intent/${round.id}`, { status: 'closed' }, 200);
  assert.equal(closed.round.status, 'closed');
  assert(closed.round.closedAt > 0);
  assert.equal((await s.call('lead', 'PATCH', `/intent/${round.id}`, { status: 'closed' })).json.error, 'intent_closed');
  assert.equal((await s.call('lead', 'PATCH', `/intent/${round.id}`, { status: 'open' })).status, 400);
  const late = await pick('m1', round.id, onAlpha.pid);
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'intent_closed');
  assert.equal((await s.call('m1', 'DELETE', `/intent/${round.id}/picks/${onAlpha.pid}`, { kind: 'main' })).json.error, 'intent_closed');
  const read = await s.ok('m1', 'GET', `/intent?team=${s.tids[0]}`);
  assert.equal(read.round.status, 'closed', 'the latest round is shown when none is open');
  assert.equal(read.picks.length, 1);
  assert.equal(read.canPick, false);
  assert.deepEqual(read.undecided, []);
  // A new round can follow; the old one is still listed and readable with ?round=.
  const second = await s.ok('lead', 'POST', `/teams/${s.tids[0]}/intent`, { title: 'Round two' });
  assert.equal(second.rounds.length, 2);
  assert.equal(second.picks.length, 0);
  const old = await s.ok('m1', 'GET', `/intent?team=${s.tids[0]}&round=${round.id}`);
  assert.equal(old.round.id, round.id);
  assert.equal(old.picks.length, 1);
  assert.equal((await s.call('m1', 'GET', `/intent?team=${s.tids[0]}&round=ir_AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  assert.equal((await s.call('m1', 'GET', `/intent?team=${s.tids[1]}&round=${round.id}`)).status, 404, 'a round of another team');
  assert.equal((await s.call('m1', 'GET', '/intent?team=nope')).status, 400);
  // An archived team cannot open a round.
  await s.ok('gm', 'PATCH', `/teams/${s.tids[1]}`, { archived: true }, 200);
  assert.equal((await s.call('gm', 'POST', `/teams/${s.tids[1]}/intent`, { title: 'Late' })).status, 409);
});

// ---------------------------------------------------------------------------
// 2. Recruitment needs

check('recruiting: roles counted from the Raider and Trial mains of the team against the targets, the open intent round laid over them, the schedule and the apply link', async () => {
  const s = await scenario({ version: 'tbc', teams: 2, members: ['m1'], leads: ['lead'], officers: ['officer'] });
  await s.person({ name: 'Tankone', cls: 'WARRIOR', spec: 'Protection' });
  await s.person({ name: 'Healone', cls: 'PRIEST', spec: 'Holy' });
  await s.person({ name: 'Healtwo', cls: 'SHAMAN', spec: 'Restoration', status: 'trial' });
  await s.person({ name: 'Rogueone', cls: 'ROGUE', spec: 'Combat' });
  await s.person({ name: 'Hunterone', cls: 'HUNTER', spec: 'Survival' });
  await s.person({ name: 'Nospec', cls: 'MAGE', spec: null });
  await s.person({ name: 'Benched', cls: 'WARRIOR', spec: 'Protection', status: 'reserve' });
  await s.person({ name: 'Elsewhere', cls: 'WARRIOR', spec: 'Protection', team: s.tids[1] });
  await s.ok('gm', 'PUT', `/teams/${s.tid}/schedule`, { slots: [{ weekday: 2, startTime: '20:00', zone: 'Karazhan' }, { weekday: 4, startTime: '20:30' }], weeks: 2, auto: false }, 200);
  // Only roster editors of the team may read it.
  assert.equal((await s.call('m1', 'GET', `/recruiting?team=${s.tid}`)).status, 403);
  assert.equal((await s.call('lead', 'GET', `/recruiting?team=${s.tids[1]}`)).status, 403, 'a lead of Alpha does not read Bravo');
  assert.equal((await s.call('gm', 'GET', '/recruiting?team=nope')).status, 400);
  const data = await s.ok('lead', 'GET', `/recruiting?team=${s.tid}`);
  assert.deepEqual(data.targets, { tank: 3, healer: 6, melee: 8, ranged: 8 });
  assert.equal(data.customTargets, false);
  assert.deepEqual(data.roster.counts, { tank: 1, healer: 2, melee: 1, ranged: 1 });
  assert.equal(data.roster.people, 6, 'raiders and trials with a main on the team (the reserve and the other team are not counted)');
  assert.equal(data.roster.unknown, 1);
  assert.deepEqual(data.roster.gaps, { tank: 2, healer: 4, melee: 7, ranged: 7 });
  assert.equal(data.roster.specs.length, 5, 'the main without a spec is not in the buff list');
  assert.equal(data.intent, null);
  assert.deepEqual(data.schedule.map((e) => [e.weekday, e.startTime, e.zone]), [[2, '20:00', 'Karazhan'], [4, '20:30', null]]);
  assert.equal(data.guild.applyEnabled, false);
  assert.equal(data.guild.applyPath, `/#/apply/${s.gid}`);
  assert.deepEqual([data.guild.name, data.guild.gameVersion, data.guild.realm], ['Wave Three', 'tbc', 'Nightslayer']);
  // The open intent round is laid over the roster: a person's pick replaces their main.
  const warrior = (await s.rows("SELECT p.id FROM players p JOIN characters c ON c.player_id = p.id WHERE c.name = 'Tankone'"))[0].id;
  const { round } = await s.ok('officer', 'POST', `/teams/${s.tid}/intent`, { title: 'TBC check' });
  await s.ok('officer', 'PUT', `/intent/${round.id}/picks/${warrior}`, { kind: 'main', class: 'WARRIOR', spec: 'Fury' }, 200);
  const laid = await s.ok('gm', 'GET', `/recruiting?team=${s.tid}`);
  assert.equal(laid.intent.title, 'TBC check');
  assert.equal(laid.intent.replaced, 1);
  assert.deepEqual(laid.intent.counts, { tank: 0, healer: 2, melee: 2, ranged: 1 });
  assert.deepEqual(laid.roster.counts, { tank: 1, healer: 2, melee: 1, ranged: 1 }, 'the plain roster is untouched');
  // Applications on: the post gets a link.
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  assert.equal((await s.ok('gm', 'GET', `/recruiting?team=${s.tid}`)).guild.applyEnabled, true);
});

check('recruiting: targets are set per team (roster.edit on it), validated, reset with null, audited; a custom target changes the gaps', async () => {
  const s = await scenario({ version: 'tbc', teams: 2, leads: ['lead'], members: ['m1'] });
  await s.person({ name: 'Tankone', cls: 'WARRIOR', spec: 'Protection' });
  const url = (tid) => `/teams/${tid}/recruiting`;
  assert.equal((await s.call('m1', 'PUT', url(s.tid), { targets: { tank: 2, healer: 2, melee: 2, ranged: 2 } })).status, 403);
  assert.equal((await s.call('lead', 'PUT', url(s.tids[1]), { targets: { tank: 2, healer: 2, melee: 2, ranged: 2 } })).status, 403);
  for (const bad of [undefined, { tank: 2 }, { tank: -1, healer: 2, melee: 2, ranged: 2 }, { tank: 2.5, healer: 2, melee: 2, ranged: 2 }, { tank: 200, healer: 2, melee: 2, ranged: 2 }]) {
    const res = await s.call('lead', 'PUT', url(s.tid), { targets: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.json.field, 'targets');
  }
  const saved = await s.ok('lead', 'PUT', url(s.tid), { targets: { tank: 2, healer: 3, melee: 4, ranged: 5, extra: 9 } }, 200);
  assert.deepEqual(saved.targets, { tank: 2, healer: 3, melee: 4, ranged: 5 });
  assert.equal(saved.customTargets, true);
  assert.deepEqual(saved.roster.gaps, { tank: 1, healer: 3, melee: 4, ranged: 5 });
  assert.deepEqual(saved.defaultTargets, { tank: 3, healer: 6, melee: 8, ranged: 8 });
  assert.equal((await s.rows('SELECT recruit_targets AS t FROM teams WHERE id = ?', s.tid))[0].t, '{"tank":2,"healer":3,"melee":4,"ranged":5}');
  assert.equal((await s.rows('SELECT recruit_targets AS t FROM teams WHERE id = ?', s.tids[1]))[0].t, null, 'the other team is untouched');
  // The same values again change nothing and write no audit row.
  await s.ok('lead', 'PUT', url(s.tid), { targets: { tank: 2, healer: 3, melee: 4, ranged: 5 } }, 200);
  assert.equal(await s.w.count('audit_log', "action = 'recruiting.targets'"), 1);
  const reset = await s.ok('lead', 'PUT', url(s.tid), { targets: null }, 200);
  assert.equal(reset.customTargets, false);
  assert.deepEqual(reset.targets, { tank: 3, healer: 6, melee: 8, ranged: 8 });
  assert.equal(await s.w.count('audit_log', "action = 'recruiting.targets'"), 2);
});

// ---------------------------------------------------------------------------
// 3. Applications inbox

// A browser on the public form: opens it (which hands out the cookie), then sends. jar: a signed-in account's jar, else a fresh signed-out one.
function applicant(s, jar = newJar()) {
  return {
    jar,
    form: () => s.w.call(jar, 'GET', `/api/apply/${s.gid}`),
    async send(body) {
      const res = await s.w.call(jar, 'POST', `/api/apply/${s.gid}`, body);
      s.w.advance(STEP);
      return res;
    },
  };
}
const application = (s, extra = {}) => ({ teamId: s.tid, name: 'Hopeful', class: 'MAGE', spec: 'Frost', ...extra });

check('applications settings: the switch and up to 8 questions (guild.teams only), ids kept across saves, nothing written when nothing changed', async () => {
  const s = await scenario({ version: 'tbc', members: ['m1'], leads: ['lead'], officers: ['officer'] });
  const url = '/applications/settings';
  const first = await s.ok('gm', 'GET', url);
  assert.deepEqual(first, { enabled: false, questions: [], maxQuestions: 8, path: `/#/apply/${s.gid}`, counts: { new: 0, reviewing: 0, accepted: 0, declined: 0 } });
  for (const who of ['m1', 'lead']) assert.equal((await s.call(who, 'GET', url)).status, 403, who);
  assert.equal((await s.call('m1', 'PUT', url, { enabled: true, questions: [] })).status, 403);
  // Closed for the public while it is off.
  assert.equal((await s.w.call(newJar(), 'GET', `/api/apply/${s.gid}`)).status, 404);
  const bad = async (questions, field = 'questions') => {
    const res = await s.call('officer', 'PUT', url, { enabled: true, questions });
    assert.equal(res.status, 400, JSON.stringify(questions));
    assert.equal(res.json.field, field);
    return res.json;
  };
  await bad('nope');
  await bad(Array.from({ length: 9 }, (_, i) => ({ label: `Q${i}`, type: 'short' })));
  assert.equal((await bad([{ label: 'ok', type: 'short' }, { label: '', type: 'short' }])).index, 1);
  await bad([{ label: 'x'.repeat(121), type: 'short' }]);
  await bad([{ label: 'q', type: 'essay' }]);
  await bad([{ label: 'q', type: 'choice', options: ['only one'] }]);
  await bad([{ label: 'q', type: 'choice', options: ['same', 'SAME'] }]);
  await bad([{ label: 'q', type: 'choice', options: Array.from({ length: 9 }, (_, i) => `o${i}`) }]);
  await bad([{ label: 'q', type: 'short', required: 'yes' }]);
  assert.equal((await s.call('officer', 'PUT', url, { enabled: 'yes', questions: [] })).json.field, 'enabled');
  const saved = await s.ok('officer', 'PUT', url, {
    enabled: true,
    questions: [
      { label: ' Why us? ', type: 'long', required: true },
      { label: 'Raid experience', type: 'choice', options: ['New to raiding', ' Cleared Sunwell ', 'new to raiding'], required: false },
      { label: 'BattleTag', type: 'short' },
    ],
  }, 200);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.questions.map((q) => [q.label, q.type, q.options, q.required]), [
    ['Why us?', 'long', [], true], ['Raid experience', 'choice', ['New to raiding', 'Cleared Sunwell'], false], ['BattleTag', 'short', [], false],
  ]);
  const ids = saved.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, 3);
  // Saving the same questions with their ids changes nothing (no audit row); an edit keeps the id.
  const same = await s.ok('officer', 'PUT', url, { enabled: true, questions: saved.questions }, 200);
  assert.deepEqual(same.questions.map((q) => q.id), ids);
  assert.equal(await s.w.count('audit_log', "action = 'apply.settings'"), 1);
  const edited = await s.ok('officer', 'PUT', url, { enabled: true, questions: [{ ...saved.questions[0], label: 'Why join us?' }] }, 200);
  assert.equal(edited.questions[0].id, ids[0]);
  assert.equal(await s.w.count('audit_log', "action = 'apply.settings'"), 2);
  // The public form lists the questions and the team.
  const form = await applicant(s).form();
  assert.equal(form.status, 200);
  assert.deepEqual(form.json.questions.map((q) => q.label), ['Why join us?']);
  assert.deepEqual(form.json.teams, [{ id: s.tid, name: 'Main team' }]);
  assert.equal(form.json.rosterOptions.specs.MAGE.includes('Frost'), true);
  await s.ok('officer', 'PUT', url, { enabled: false, questions: edited.questions }, 200);
  assert.equal((await applicant(s).form()).status, 404, 'off again');
});

check('apply form: validation, required and choice answers, realm and team rules, the honeypot and duplicates', async () => {
  const s = await scenario({ version: 'tbc', teams: 2 });
  const settings = await s.ok('gm', 'PUT', '/applications/settings', {
    enabled: true,
    questions: [{ label: 'Why us?', type: 'long', required: true }, { label: 'Experience', type: 'choice', options: ['New', 'Veteran'] }, { label: 'Tag', type: 'short' }],
  }, 200);
  const [why, exp, tag] = settings.questions.map((q) => q.id);
  const a = applicant(s);
  await a.form();
  const send = (extra) => a.send(application(s, { answers: { [why]: 'Because' }, ...extra }));
  const refuse = async (extra, field) => {
    const res = await send(extra);
    assert.equal(res.status, 400, `${JSON.stringify(extra)}: ${res.text}`);
    assert.equal(res.json.field, field, res.text);
  };
  await refuse({ name: 'x' }, 'name');
  await refuse({ name: 'Bad Name1' }, 'name');
  await refuse({ class: 'NOPE' }, 'class');
  await refuse({ spec: 'Holy' }, 'spec');
  await refuse({ spec: undefined }, 'spec');
  await refuse({ teamId: undefined }, 'teamId');
  await refuse({ teamId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, 'teamId');
  await refuse({ realm: 'Not A Realm' }, 'realm');
  await refuse({ contact: 'c'.repeat(101) }, 'contact');
  await refuse({ answers: {} }, `answers.${why}`);
  await refuse({ answers: { [why]: 'ok', [exp]: 'Hero' } }, `answers.${exp}`);
  await refuse({ answers: { [why]: 'w'.repeat(1501) } }, `answers.${why}`);
  await refuse({ answers: { [why]: 'ok', [tag]: 't'.repeat(201) } }, `answers.${tag}`);
  assert.equal(await s.w.count('applications'), 0, 'nothing was stored');
  // A good one: answers are stored with the question's wording, the realm in its canonical spelling, text cleaned.
  const sent = await send({ name: 'hopeful', realm: ' dreamscythe ', contact: '  Hopeful#1234  ', teamId: s.tids[1], answers: { [why]: ' Line one\r\n\r\n\r\n\r\nLine two\t', [exp]: 'veteran', ignored: 'x' } });
  assert.equal(sent.status, 201, sent.text);
  const row = (await s.rows('SELECT * FROM applications'))[0];
  assert.deepEqual([row.char_name, row.name_key, row.realm, row.realm_key, row.class, row.spec, row.contact, row.team_id, row.status, row.user_id], ['Hopeful', 'hopeful', 'Dreamscythe', 'dreamscythe', 'MAGE', 'Frost', 'Hopeful#1234', s.tids[1], 'new', null]);
  assert.deepEqual(JSON.parse(row.answers), [{ label: 'Why us?', type: 'long', answer: 'Line one\n\nLine two' }, { label: 'Experience', type: 'choice', answer: 'Veteran' }]);
  // The same character twice: refused while the first waits.
  const dup = await a.send(application(s, { realm: 'Dreamscythe', teamId: s.tids[1], answers: { [why]: 'again' } }));
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'already_applied');
  const audit = await s.rows("SELECT action, actor_user_id, after FROM audit_log WHERE action = 'application.submit'");
  assert.deepEqual(audit.map((r) => [r.action, r.actor_user_id]), [['application.submit', null]]);
  assert(!/Because|Hopeful/.test(audit[0].after), 'no applicant text in the log');
  // The honeypot: a pretend success that stores nothing.
  const bot = await a.send(application(s, { name: 'Botname', website: 'x', answers: { [why]: 'spam' } }));
  assert.equal(bot.status, 201);
  assert.equal(await s.w.count('applications'), 1);
  assert.equal(await s.w.count('rate_limits', "key LIKE 'apply:%'"), 1, 'and it did not use up the rate limit');
});

check('apply form: a single-team guild needs no team, a ruleset guild ignores the realm, the cookie is required, a signed-in applicant\'s account is kept', async () => {
  const s = await scenario({ version: 'forever', members: ['m1'] });
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  const stranger = await signIn(s.w, P.stranger, []);
  const strangerJar = stranger.jar;
  const a = applicant(s, strangerJar);
  const form = await a.form();
  assert.equal(form.json.signedInAs, 'Strangerwave');
  assert.equal(form.json.guild.realmKind, 'ruleset');
  const noCookie = await s.w.call(newJar(), 'POST', `/api/apply/${s.gid}`, { name: 'Hopeful', class: 'MAGE', spec: 'Frost' });
  assert.equal(noCookie.status, 400);
  assert.equal(noCookie.json.error, 'cookies_required');
  // An invalid cookie value is no cookie.
  const forged = { '__Host-rs_apply': 'short' };
  assert.equal((await s.w.call(forged, 'POST', `/api/apply/${s.gid}`, { name: 'Hopeful', class: 'MAGE', spec: 'Frost' })).json.error, 'cookies_required');
  const sent = await a.send({ name: 'Hopeful', class: 'MAGE', spec: 'Frost', realm: 'Whatever Realm' });
  assert.equal(sent.status, 201, sent.text);
  const row = (await s.rows('SELECT realm, realm_key, team_id, user_id FROM applications'))[0];
  assert.deepEqual([row.realm, row.realm_key, row.team_id], [null, '', s.tid]);
  assert.equal(row.user_id, (await s.w.call(strangerJar, 'GET', '/auth/me')).json.user.id);
  // The same account cannot queue a second application while the first waits.
  const second = await a.send({ name: 'Otherchar', class: 'ROGUE', spec: 'Combat' });
  assert.equal(second.status, 409);
  // An account an officer blocked from the guild is refused.
  const blocked = await signIn(s.w, P.m2, [memberOf(SERVER)]);
  const blockedUser = (await s.w.call(blocked.jar, 'GET', '/auth/me')).json.user.id;
  await s.ok('gm', 'POST', `/people/${blockedUser}/block`, {}, 200);
  const b = applicant(s, blocked.jar);
  await b.form();
  const refused = await b.send({ name: 'Blocked', class: 'MAGE', spec: 'Fire' });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error, 'access_removed');
});

check('apply form limits: three an hour per browser and twenty a day per guild, each with a retry time', async () => {
  const s = await scenario({ version: 'tbc' });
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  const names = (i) => `Applicant${'abcdefghijklmnopqrstuvwxyz'[i]}`.slice(0, 12);
  const a = applicant(s);
  await a.form();
  for (let i = 0; i < 3; i++) assert.equal((await a.send(application(s, { name: names(i) }))).status, 201);
  const slow = await a.send(application(s, { name: names(3) }));
  assert.equal(slow.status, 429);
  assert.equal(slow.json.error, 'rate_limited');
  assert(slow.json.retryAfter > 0 && slow.json.retryAfter <= 3600);
  assert(slow.headers.get('Retry-After'));
  // After the hour the same browser may send again.
  s.w.advance(3600 * 1000 + 1000);
  assert.equal((await a.send(application(s, { name: names(3) }))).status, 201);
  // Other browsers fill the day: 20 in all, then the guild is busy until the oldest is a day old.
  let sent = 4;
  for (let i = 4; sent < 20; i++) {
    const fresh = applicant(s);
    await fresh.form();
    const res = await fresh.send(application(s, { name: names(i) }));
    assert.equal(res.status, 201, res.text);
    sent++;
  }
  const late = applicant(s);
  await late.form();
  const busy = await late.send(application(s, { name: 'Onetoomany' }));
  assert.equal(busy.status, 429);
  assert.equal(busy.json.error, 'apply_busy');
  assert(busy.json.retryAfter > 0);
  assert.equal(await s.w.count('applications'), 20);
  s.w.advance(24 * 3600 * 1000);
  assert.equal((await late.send(application(s, { name: 'Onetoomany' }))).status, 201, 'a day later');
});

check('applications inbox: roster editors see their teams\' applications; status, notes and delete; filters and counts', async () => {
  const s = await scenario({ version: 'tbc', teams: 2, members: ['m1'], leads: ['lead'], officers: ['officer'] });
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [{ label: 'Why us?', type: 'short' }] }, 200);
  const send = async (name, teamId, extra = {}) => {
    const a = applicant(s);
    const form = await a.form();
    const q = form.json.questions[0].id;
    const res = await a.send({ teamId, name, class: 'MAGE', spec: 'Fire', contact: `${name}#1`, answers: { [q]: `Answer of ${name}` }, ...extra });
    assert.equal(res.status, 201, res.text);
  };
  await send('Alphaone', s.tids[0]);
  await send('Alphatwo', s.tids[0]);
  await send('Bravoone', s.tids[1]);
  assert.equal((await s.call('m1', 'GET', '/applications')).status, 403);
  const all = await s.ok('officer', 'GET', '/applications');
  assert.equal(all.applications.length, 3);
  assert.deepEqual(all.counts, { new: 3, reviewing: 0, accepted: 0, declined: 0 });
  const first = all.applications.find((x) => x.name === 'Alphaone');
  assert.deepEqual([first.teamName, first.status, first.class, first.spec, first.contact, first.applicant, first.onRoster, first.personId], ['Alpha', 'new', 'MAGE', 'Fire', 'Alphaone#1', null, null, null]);
  assert.deepEqual(first.answers, [{ label: 'Why us?', type: 'short', answer: 'Answer of Alphaone' }]);
  assert.equal(all.applications[0].name, 'Bravoone', 'newest first');
  // A lead sees only their team; may not touch Bravo's.
  const mine = await s.ok('lead', 'GET', '/applications');
  assert.deepEqual(mine.applications.map((x) => x.name).sort(), ['Alphaone', 'Alphatwo']);
  assert.deepEqual(mine.counts, { new: 2, reviewing: 0, accepted: 0, declined: 0 });
  const bravo = all.applications.find((x) => x.name === 'Bravoone');
  assert.equal((await s.call('lead', 'PATCH', `/applications/${bravo.id}`, { status: 'declined' })).status, 403);
  assert.equal((await s.call('lead', 'DELETE', `/applications/${bravo.id}`, {})).status, 403);
  assert.equal((await s.call('lead', 'POST', `/applications/${bravo.id}/accept`, {})).status, 403);
  assert.equal((await s.call('gm', 'GET', '/applications?status=wrong')).status, 400);
  assert.equal((await s.call('gm', 'GET', '/applications?team=nope')).status, 400);
  // Status and notes.
  assert.equal((await s.call('lead', 'PATCH', `/applications/${first.id}`, {})).status, 400);
  assert.equal((await s.call('lead', 'PATCH', `/applications/${first.id}`, { status: 'accepted' })).status, 400, 'accepting is the Accept action');
  assert.equal((await s.call('lead', 'PATCH', `/applications/${first.id}`, { notes: 'n'.repeat(2001) })).status, 400);
  const reviewing = await s.ok('lead', 'PATCH', `/applications/${first.id}`, { status: 'reviewing', notes: ' Looks \r\n good ' }, 200);
  assert.deepEqual([reviewing.application.status, reviewing.application.notes], ['reviewing', 'Looks\ngood']);
  assert.equal((await s.ok('lead', 'GET', '/applications?status=reviewing')).applications.length, 1);
  assert.equal((await s.ok('lead', 'GET', '/applications?status=open')).applications.length, 2);
  assert.equal((await s.ok('gm', 'GET', `/applications?team=${s.tids[1]}`)).applications.length, 1);
  await s.ok('lead', 'PATCH', `/applications/${first.id}`, { status: 'declined' }, 200);
  const declined = await s.ok('lead', 'GET', '/applications');
  assert.deepEqual(declined.counts, { new: 1, reviewing: 0, accepted: 0, declined: 1 });
  await s.ok('lead', 'PATCH', `/applications/${first.id}`, { status: 'reviewing' }, 200);
  // Audit: status changes are logged with the team, never the notes.
  const audit = await s.rows("SELECT action, after FROM audit_log WHERE action = 'application.update' ORDER BY created_at, id");
  assert.equal(audit.length, 3);
  assert(!audit.some((row) => /good/.test(row.after)));
  // Delete.
  assert.equal((await s.call('lead', 'DELETE', `/applications/${first.id}`, {})).status, 200);
  assert.equal((await s.call('lead', 'GET', '/applications')).json.applications.length, 1);
  assert.equal((await s.call('lead', 'DELETE', `/applications/${first.id}`, {})).status, 404);
  assert.equal(await s.w.count('audit_log', "action = 'application.delete'"), 1);
});

check('applications accept: a Trial person with the character as Main, trial dates, the account linked; refused for a taken name, a decided application or a team the officer cannot edit', async () => {
  const s = await scenario({ version: 'tbc', teams: 2, members: ['m1'], leads: ['lead'] });
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  const a = applicant(s, (await signIn(s.w, P.stranger, [])).jar);
  await a.form();
  assert.equal((await a.send({ teamId: s.tids[0], name: 'Hopeful', class: 'MAGE', spec: 'Frost', realm: 'Dreamscythe' })).status, 201);
  const b = applicant(s);
  await b.form();
  assert.equal((await b.send({ teamId: s.tids[1], name: 'Walkin', class: 'ROGUE', spec: 'Combat' })).status, 201);
  const list = (await s.ok('gm', 'GET', '/applications')).applications;
  const hopeful = list.find((x) => x.name === 'Hopeful');
  const walkin = list.find((x) => x.name === 'Walkin');
  assert.equal(hopeful.applicant.displayName, 'Strangerwave');
  // Validation and permission.
  assert.equal((await s.call('lead', 'POST', `/applications/${hopeful.id}/accept`, { trialDays: 0 })).status, 400);
  assert.equal((await s.call('lead', 'POST', `/applications/${hopeful.id}/accept`, { trialDays: 91 })).status, 400);
  assert.equal((await s.call('lead', 'POST', `/applications/${hopeful.id}/accept`, { trialDays: 1.5 })).status, 400);
  assert.equal((await s.call('lead', 'POST', `/applications/${hopeful.id}/accept`, { teamId: s.tids[1] })).status, 403, 'a lead of Alpha cannot place someone on Bravo');
  assert.equal((await s.call('lead', 'POST', `/applications/${walkin.id}/accept`, {})).status, 403);
  // Accept: today in the guild's zone is 2027-01-15 (the test clock), a 14-day trial by default.
  const accepted = await s.ok('lead', 'POST', `/applications/${hopeful.id}/accept`, {}, 201);
  assert.deepEqual([accepted.application.status, accepted.accountLinked, accepted.accountSkipped, accepted.person.trialEnd], ['accepted', true, false, '2027-01-29']);
  const person = (await s.rows('SELECT * FROM players WHERE id = ?', accepted.person.id))[0];
  assert.deepEqual([person.status, person.joined_on, person.trial_start, person.trial_end, person.user_id, person.discord_user_id], ['trial', '2027-01-15', '2027-01-15', '2027-01-29', (await s.w.call(a.jar, 'GET', '/auth/me')).json.user.id, null]);
  const character = (await s.rows('SELECT * FROM characters WHERE player_id = ?', person.id))[0];
  assert.deepEqual([character.name, character.team_id, character.class, character.main_spec, character.is_main, character.realm, character.realm_key], ['Hopeful', s.tids[0], 'MAGE', 'Frost', 1, 'Dreamscythe', 'dreamscythe']);
  assert.equal(accepted.application.personId, accepted.person.id);
  const row = (await s.rows('SELECT status, player_id, reviewed_by FROM applications WHERE id = ?', hopeful.id))[0];
  assert.deepEqual([row.status, row.player_id], ['accepted', person.id]);
  assert(row.reviewed_by);
  // The applicant's account now belongs to the person (so they are a member and "my person").
  assert.equal((await s.w.call(a.jar, 'GET', `${s.base}/roster/${person.id}`)).status, 200);
  // Decided is decided; the audit row names the person, not the text.
  assert.equal((await s.call('lead', 'POST', `/applications/${hopeful.id}/accept`, {})).json.error, 'already_decided');
  assert.equal((await s.call('lead', 'PATCH', `/applications/${hopeful.id}`, { status: 'declined' })).json.error, 'already_decided');
  const audit = (await s.rows("SELECT after FROM audit_log WHERE action = 'application.accept'"))[0];
  assert.deepEqual(JSON.parse(audit.after), { personId: person.id, teamId: s.tids[0], linked: true, trialEnd: '2027-01-29' });
  // An officer places the other one on the team they asked for, with a 30-day trial.
  const walk = await s.ok('gm', 'POST', `/applications/${walkin.id}/accept`, { trialDays: 30 }, 201);
  assert.deepEqual([walk.accountLinked, walk.accountSkipped, walk.person.trialEnd], [false, false, '2027-02-14']);
  assert.equal((await s.rows('SELECT team_id FROM characters WHERE name = ?', 'Walkin'))[0].team_id, s.tids[1]);
  // Name already on the roster: a 409 that names the owner; the application stays open. A name on the roster shows as a hint in the inbox.
  await s.person({ name: 'Taken' });
  const c = applicant(s);
  await c.form();
  assert.equal((await c.send({ teamId: s.tid, name: 'Taken', class: 'MAGE', spec: 'Fire', realm: 'Nightslayer' })).status, 201);
  const taken = (await s.ok('gm', 'GET', '/applications?status=open')).applications.find((x) => x.name === 'Taken');
  assert.equal(taken.onRoster.name, 'Taken');
  const clash = await s.call('gm', 'POST', `/applications/${taken.id}/accept`, {});
  assert.equal(clash.status, 409);
  assert.equal(clash.json.error, 'name_taken');
  assert.equal((await s.rows('SELECT status FROM applications WHERE id = ?', taken.id))[0].status, 'new');
  // A declined application cannot be accepted until it is reopened.
  await s.ok('gm', 'PATCH', `/applications/${taken.id}`, { status: 'declined' }, 200);
  assert.equal((await s.call('gm', 'POST', `/applications/${taken.id}/accept`, {})).json.error, 'already_decided');
});

check('lane W: team trial length (PATCH trialDays, accept default), roster raidRole and team.trialDays, applicationFlags in the guild context', async () => {
  const s = await scenario({ version: 'tbc', teams: 2, members: ['m1'], leads: ['lead'] });
  const teamOf = async (who, tid) => (await s.ok(who, 'GET', '')).teams.find((t) => t.id === tid);
  // Default 14 everywhere a team is sent; nothing applied yet: flags are 0 per team for the officer, {} for the member.
  assert.equal((await teamOf('gm', s.tids[0])).trialDays, 14);
  const ctx0 = await s.ok('gm', 'GET', '');
  assert.deepEqual(ctx0.applicationFlags, { [s.tids[0]]: 0, [s.tids[1]]: 0 });
  assert.deepEqual((await s.ok('m1', 'GET', '')).applicationFlags, {});
  assert.deepEqual((await s.ok('lead', 'GET', '')).applicationFlags, { [s.tids[0]]: 0 }, 'a lead only counts their own team');
  // PATCH validation, permission, audit.
  for (const bad of [0, 91, 1.5, '14', null]) {
    const res = await s.call('gm', 'PATCH', `/teams/${s.tids[0]}`, { trialDays: bad });
    assert.equal(res.status, 400, String(bad));
    assert.deepEqual([res.json.field, res.json.message], ['trialDays', 'Trial length is 1 to 90 days.']);
  }
  assert.equal((await s.call('lead', 'PATCH', `/teams/${s.tids[0]}`, { trialDays: 7 })).status, 403);
  assert.equal((await s.call('gm', 'PATCH', `/teams/${s.tids[0]}`, {})).status, 400);
  const patched = await s.ok('gm', 'PATCH', `/teams/${s.tids[0]}`, { trialDays: 21 }, 200);
  assert.equal(patched.team.trialDays, 21);
  await s.ok('gm', 'PATCH', `/teams/${s.tids[0]}`, { trialDays: 21 }, 200);
  assert.equal(await s.w.count('audit_log', "action = 'team.trial_days'"), 1, 'an unchanged value is not audited');
  assert.equal((await teamOf('m1', s.tids[0])).trialDays, 21);
  assert.equal((await teamOf('m1', s.tids[1])).trialDays, 14, 'the other team keeps its own');
  // Applications: the flag counts New ones for the wanted team only.
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  const send = async (teamId, name, cls, spec) => {
    const a = applicant(s);
    await a.form();
    assert.equal((await a.send({ teamId, name, class: cls, spec })).status, 201);
  };
  await send(s.tids[0], 'Flagone', 'MAGE', 'Fire');
  await send(s.tids[0], 'Flagtwo', 'PRIEST', 'Holy');
  await send(s.tids[1], 'Flagthree', 'ROGUE', 'Combat');
  assert.deepEqual((await s.ok('gm', 'GET', '')).applicationFlags, { [s.tids[0]]: 2, [s.tids[1]]: 1 });
  assert.deepEqual((await s.ok('lead', 'GET', '')).applicationFlags, { [s.tids[0]]: 2 });
  assert.deepEqual((await s.ok('m1', 'GET', '')).applicationFlags, {});
  const list = (await s.ok('gm', 'GET', '/applications')).applications;
  const two = list.find((x) => x.name === 'Flagtwo');
  await s.ok('gm', 'PATCH', `/applications/${two.id}`, { status: 'reviewing' }, 200);
  assert.deepEqual((await s.ok('gm', 'GET', '')).applicationFlags, { [s.tids[0]]: 1, [s.tids[1]]: 1 }, 'only status new counts');
  // Accept uses the chosen team's length; an explicit trialDays still wins; the team chosen in the body decides.
  const one = list.find((x) => x.name === 'Flagone');
  const acc = await s.ok('lead', 'POST', `/applications/${one.id}/accept`, {}, 201);
  assert.equal(acc.person.trialEnd, '2027-02-05', '2027-01-15 + 21');
  const three = list.find((x) => x.name === 'Flagthree');
  assert.equal((await s.ok('gm', 'POST', `/applications/${three.id}/accept`, {}, 201)).person.trialEnd, '2027-01-29', 'Bravo is still 14');
  await send(s.tids[1], 'Moved', 'MAGE', 'Frost');
  const moved = (await s.ok('gm', 'GET', '/applications?status=open')).applications.find((x) => x.name === 'Moved');
  assert.equal((await s.ok('gm', 'POST', `/applications/${moved.id}/accept`, { teamId: s.tids[0] }, 201)).person.trialEnd, '2027-02-05', 'placed on Alpha: its 21 days');
  await send(s.tids[0], 'Explicit', 'MAGE', 'Arcane');
  const explicit = (await s.ok('gm', 'GET', '/applications?status=open')).applications.find((x) => x.name === 'Explicit');
  assert.equal((await s.ok('gm', 'POST', `/applications/${explicit.id}/accept`, { trialDays: 5 }, 201)).person.trialEnd, '2027-01-20');
  // GET /roster?team=: team.trialDays and a raidRole per person from the shown character (null without a spec).
  await s.person({ name: 'Tanky', spec: 'Protection' });
  await s.person({ name: 'Healy', cls: 'PRIEST', spec: 'Holy' });
  await s.person({ name: 'Stabby', cls: 'ROGUE', spec: 'Combat' });
  await s.person({ name: 'Zappy', cls: 'MAGE', spec: 'Fire' });
  const bare = await s.ok('gm', 'POST', '/roster', { teamId: s.tids[0], name: 'Specless', class: 'MAGE', mainSpec: null, offSpec: null, status: 'raider' });
  const roster = await s.ok('m1', 'GET', `/roster?team=${s.tids[0]}`);
  assert.equal(roster.team.trialDays, 21);
  const roleOf = (name) => roster.people.find((p) => p.shown.name === name).raidRole;
  assert.deepEqual(['Tanky', 'Healy', 'Stabby', 'Zappy', 'Specless'].map(roleOf), ['tank', 'healer', 'melee', 'ranged', null]);
  assert(bare.person.id);
  assert.equal((await s.ok('gm', 'GET', `/roster?team=${s.tids[1]}`)).team.trialDays, 14);
});

check('applications accept: an account that already belongs to a person of the guild is not linked a second time', async () => {
  const s = await scenario({ version: 'tbc', members: ['m1'] });
  await s.person({ name: 'Existing', link: 'm1' });
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  const a = applicant(s, s.jars.m1);
  await a.form();
  assert.equal((await a.send({ name: 'Secondchar', class: 'ROGUE', spec: 'Combat' })).status, 201);
  const app = (await s.ok('gm', 'GET', '/applications')).applications[0];
  assert.equal(app.applicant.displayName, 'Memberone');
  const accepted = await s.ok('gm', 'POST', `/applications/${app.id}/accept`, {}, 201);
  assert.deepEqual([accepted.accountLinked, accepted.accountSkipped], [false, true]);
  assert.equal((await s.rows('SELECT user_id FROM players WHERE id = ?', accepted.person.id))[0].user_id, null);
});

check('attention: new applications are listed per team for roster editors of that team and counted; a decided one is not', async () => {
  const s = await scenario({ version: 'tbc', teams: 2, leads: ['lead'] });
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  for (const [name, team] of [['Alphaone', s.tids[0]], ['Alphatwo', s.tids[0]], ['Bravoone', s.tids[1]]]) {
    const a = applicant(s);
    await a.form();
    assert.equal((await a.send({ teamId: team, name, class: 'MAGE', spec: 'Fire' })).status, 201);
  }
  const gm = await s.ok('gm', 'GET', '/attention');
  const items = gm.items.filter((item) => item.kind === 'applications');
  assert.deepEqual(items.map((item) => [item.teamName, item.count, item.severity, item.link]).sort(), [['Alpha', 2, 'action', { name: 'applications' }], ['Bravo', 1, 'action', { name: 'applications' }]]);
  assert(gm.total >= 2);
  const lead = await s.ok('lead', 'GET', '/attention');
  assert.deepEqual(lead.items.filter((item) => item.kind === 'applications').map((item) => [item.teamName, item.count]), [['Alpha', 2]]);
  const one = (await s.ok('gm', 'GET', '/applications')).applications.find((x) => x.name === 'Alphaone');
  await s.ok('gm', 'PATCH', `/applications/${one.id}`, { status: 'reviewing' }, 200);
  assert.equal((await s.ok('lead', 'GET', '/attention')).items.find((item) => item.kind === 'applications').count, 1);
});

check('delete my data: the applications an account sent go with it (the person made from one stays), and the notes it wrote on intent picks', async () => {
  const s = await scenario({ version: 'tbc', members: ['m1'] });
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  const stranger = (await signIn(s.w, P.stranger, [])).jar;
  const a = applicant(s, stranger);
  await a.form();
  assert.equal((await a.send({ name: 'Hopeful', class: 'MAGE', spec: 'Frost' })).status, 201);
  const b = applicant(s);
  await b.form();
  assert.equal((await b.send({ name: 'Walkin', class: 'ROGUE', spec: 'Combat' })).status, 201);
  const hopeful = (await s.ok('gm', 'GET', '/applications')).applications.find((x) => x.name === 'Hopeful');
  const accepted = await s.ok('gm', 'POST', `/applications/${hopeful.id}/accept`, {}, 201);
  // An intent note by the member whose account is deleted.
  const mine = await s.person({ name: 'Notewriter', link: 'm1' });
  const { round } = await s.ok('gm', 'POST', `/teams/${s.tid}/intent`, { title: 'Launch' });
  await s.ok('m1', 'PUT', `/intent/${round.id}/picks/${mine.pid}`, { kind: 'main', class: 'WARRIOR', spec: 'Arms', note: 'my plan' }, 200);
  assert.equal((await s.rows('SELECT note FROM intent_picks'))[0].note, 'my plan');
  // The applicant deletes their data.
  const gone = await s.w.call(stranger, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual((await s.rows('SELECT char_name FROM applications ORDER BY char_name')).map((r) => r.char_name), ['Walkin'], 'only the signed-out applicant\'s stays');
  assert.equal((await s.rows('SELECT id FROM players WHERE id = ?', accepted.person.id)).length, 1, 'the person stays on the roster');
  assert.equal((await s.rows('SELECT user_id FROM players WHERE id = ?', accepted.person.id))[0].user_id, null, 'unlinked');
  const gone2 = await s.w.call(s.jars.m1, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(gone2.status, 200, gone2.text);
  const pick = (await s.rows('SELECT note, class FROM intent_picks'))[0];
  assert.deepEqual([pick.note, pick.class], [null, 'WARRIOR'], 'the pick stays, the note goes');
});

// ---------------------------------------------------------------------------
// 4. CSV roster import

check('csv-roster: reading the text - delimiter, quotes, BOM, blank lines, limits', async () => {
  const csv = await load('worker/csv-roster.js');
  const read = (text) => csv.readCsvText(text);
  assert.deepEqual(read('a,b\n1,2\n').records, [['a', 'b'], ['1', '2']]);
  assert.equal(read('a;b\n1;2').delimiter, ';');
  assert.equal(read('a\tb\n1\t2').delimiter, '\t');
  assert.equal(read('only one column\nsecond').delimiter, ',');
  assert.deepEqual(read('﻿name,class\r\nThornwick,Warrior\r\n\r\n\r\nMendra,Priest').records, [['name', 'class'], ['Thornwick', 'Warrior'], ['Mendra', 'Priest']]);
  assert.deepEqual(read('a,b\n"x, y","say ""hi"""\n"two\nlines",z').records, [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(read('a,b\n1,\n,2').records, [['a', 'b'], ['1', ''], ['', '2']]);
  assert.equal(read('a,b\n"open,2').ok, false);
  assert.equal(read('   \n  ').ok, false);
  assert.equal(read(undefined).ok, false);
  assert.equal(read('x'.repeat(csv.CSV_MAX_CHARS + 1)).ok, false);
  const many = read(`name,class\n${'Name,Mage\n'.repeat(600)}`);
  assert.equal(many.ok, true);
  assert(many.records.length <= csv.CSV_MAX_ROWS + 2, 'reading stops soon after the limit');
});

check('csv-roster: columns - header names and their aliases, TMB-style names, the positional fallback', async () => {
  const csv = await load('worker/csv-roster.js');
  assert.deepEqual(csv.findColumns(['Name', 'Class', 'Spec', 'Realm', 'Team', 'Main/Alt', 'Status', 'Joined']), { header: true, columns: ['name', 'class', 'spec', 'realm', 'team', 'mainalt', 'status', 'joined'], altStyle: 'word' });
  assert.deepEqual(csv.findColumns(['Character Name', 'CLASS', 'raid_group', 'is_alt', 'discord_username', 'created_at', 'Notes']), { header: true, columns: ['name', 'class', 'team', 'mainalt', 'owner', 'joined', null], altStyle: 'alt' });
  assert.equal(csv.findColumns(['name', 'class', 'is_main']).altStyle, 'main');
  assert.deepEqual(csv.findColumns(['name', 'name', 'class']).columns, ['name', null, 'class'], 'a repeated header is read once');
  assert.deepEqual(csv.findColumns(['Name', 'Foo', 'Bar']).columns, ['name', null, null], 'a first cell "name" is a header');
  const positional = csv.findColumns(['Thornwick', 'Warrior', 'Arms', 'Nightslayer', 'Alpha', 'main', 'trial', '2026-10-01']);
  assert.deepEqual(positional, { header: false, columns: ['name', 'class', 'spec', 'realm', 'team', 'mainalt', 'status', 'joined'], altStyle: 'word' });
  assert.deepEqual(csv.findColumns(['Thornwick', 'Warrior']).columns, ['name', 'class']);
});

check('csv-roster: cells - classes, spec names and short forms, statuses, dates, main/alt', async () => {
  const csv = await load('worker/csv-roster.js');
  assert.equal(csv.classOfText(' warrior '), 'WARRIOR');
  assert.equal(csv.classOfText('DRUID'), 'DRUID');
  assert.equal(csv.classOfText('Death Knight'), null);
  assert.equal(csv.specOfText('WARRIOR', 'prot'), 'Protection');
  assert.equal(csv.specOfText('PALADIN', 'Prot'), 'Protection');
  assert.equal(csv.specOfText('SHAMAN', 'resto'), 'Restoration');
  assert.equal(csv.specOfText('HUNTER', 'BM'), 'Beast Mastery');
  assert.equal(csv.specOfText('HUNTER', 'beast mastery'), 'Beast Mastery');
  assert.equal(csv.specOfText('DRUID', 'Feral'), 'Feral (DPS)');
  assert.equal(csv.specOfText('DRUID', 'Guardian'), 'Feral (Tank)');
  assert.equal(csv.specOfText('DRUID', 'feral (tank)'), 'Feral (Tank)');
  assert.equal(csv.specOfText('ROGUE', 'sub'), 'Subtlety');
  assert.equal(csv.specOfText('MAGE', 'Holy'), null);
  assert.equal(csv.specOfText('WARRIOR', ''), null);
  assert.equal(csv.statusOfText('Trial'), 'trial');
  assert.equal(csv.statusOfText('core'), 'raider');
  assert.equal(csv.statusOfText('Bench'), 'reserve');
  assert.equal(csv.statusOfText('inactive'), null);
  assert.equal(csv.dateOfText('2026-10-18'), '2026-10-18');
  assert.equal(csv.dateOfText('2026/10/18'), '2026-10-18');
  assert.equal(csv.dateOfText('2026-10-18T20:00:00Z'), '2026-10-18');
  assert.equal(csv.dateOfText('2026-02-31'), null);
  assert.equal(csv.dateOfText('10/12/2026'), null, 'day first or month first is not guessed');
});

check('csv-roster: rows - problems stop a row, notes do not; owners group characters into people', async () => {
  const csv = await load('worker/csv-roster.js');
  const context = { defaultTeam: { id: 't_a', name: 'Alpha' }, teams: [{ id: 't_a', name: 'Alpha' }, { id: 't_b', name: 'Bravo' }], realmGuild: true, defaultStatus: 'raider' };
  const layout = csv.findColumns(['name', 'class', 'spec', 'realm', 'team', 'main/alt', 'status', 'joined', 'owner']);
  const rows = csv.mapRows([
    ['thornwick', 'Warrior', 'Prot', '', 'bravo', 'Main', 'Trial', '2026-10-01', 'Pat'],
    ['Mendra', 'Priest', 'Dancing', 'Dreamscythe', '', '', '', '', ''],
    ['X', 'Mage', '', '', '', '', '', '', ''],
    ['Quillfeather', 'Dragon', '', '', '', '', '', '', ''],
    ['Zulu', 'Mage', '', '', 'Nowhere', '', 'maybe', '10/12/2026', ''],
    ['Pat', 'Druid', 'Feral', '', '', 'alt', '', '', 'Thornwick'],
  ], layout, context, 2);
  assert.deepEqual([rows[0].name, rows[0].class, rows[0].spec, rows[0].teamId, rows[0].teamName, rows[0].status, rows[0].joinedOn, rows[0].isAlt, rows[0].owner, rows[0].problems], ['Thornwick', 'WARRIOR', 'Protection', 't_b', 'Bravo', 'trial', '2026-10-01', false, 'Pat', []]);
  assert.deepEqual([rows[1].spec, rows[1].realm, rows[1].problems, rows[1].notes.length], [null, 'Dreamscythe', [], 1], 'an unknown spec is a note');
  assert(rows[2].problems[0].includes('not a character name'));
  assert(rows[3].problems[0].includes('is not a class'));
  assert.equal(rows[4].problems.length, 3, 'team, status and date');
  assert.equal(rows[5].isAlt, true);
  assert(rows[5].notes[0].includes('Feral was read as Feral (DPS)'));
  assert.deepEqual(rows.map((r) => r.line), [2, 3, 4, 5, 6, 7]);
  // Grouping: same owner = one person (the first non-alt is the Main); an owner naming another row's character joins that row; alts alone need a decision.
  const planned = csv.planRows([
    { line: 2, name: 'Pat', owner: 'dana', isAlt: false, problems: [], taken: null },
    { line: 3, name: 'Patalt', owner: 'DANA', isAlt: true, problems: [], taken: null },
    { line: 4, name: 'Patbank', owner: 'Dana', isAlt: null, problems: [], taken: null },
    { line: 5, name: 'Solo', owner: null, isAlt: null, problems: [], taken: null },
    { line: 6, name: 'Soloalt', owner: 'Solo', isAlt: true, problems: [], taken: null },
    { line: 7, name: 'Stray', owner: 'Someone', isAlt: true, problems: [], taken: null },
    { line: 8, name: 'Broken', owner: null, isAlt: null, problems: ['bad'], taken: null },
    { line: 9, name: 'Known', owner: null, isAlt: null, problems: [], taken: { personId: 'p', name: 'Known' } },
  ]);
  const view = (line) => planned.get(line);
  assert.deepEqual(view(2), { action: 'new', withLine: null, needsDecision: false });
  assert.deepEqual(view(3), { action: 'alt', withLine: 2, needsDecision: false });
  assert.deepEqual(view(4), { action: 'alt', withLine: 2, needsDecision: false }, 'a second non-alt in a group joins the first as an alt');
  assert.deepEqual(view(5), { action: 'new', withLine: null, needsDecision: false });
  assert.deepEqual(view(6), { action: 'alt', withLine: 5, needsDecision: false }, 'the owner is the name of another row');
  assert.deepEqual(view(7), { action: 'alt', withLine: null, needsDecision: true });
  assert.equal(view(8).action, 'skip');
  assert.equal(view(9).action, 'skip');
});

const CSV_ALPHA_BRAVO = [
  'name,class,spec,team,main/alt,status,joined,owner',
  'Newwarr,Warrior,Prot,Alpha,main,trial,2026-10-01,Pat',
  'Newmage,Mage,Fire,Bravo,alt,,,Pat',
  'Thornwick,Warrior,Arms,,,,,',
  'Lonelyalt,Rogue,Sub,,alt,,,Thornwick',
  'Orphanalt,Priest,Holy,,alt,,,Nobody',
  'Bad,Notaclass,,,,,,',
  'Wrongteam,Mage,Fire,Zulu,,,,',
  'Newwarr,Warrior,Fury,,,,,',
].join('\n');

async function csvScenario() {
  const s = await scenario({ version: 'tbc', teams: 2, members: ['m1'], leads: ['lead'], officers: ['officer'] });
  s.thorn = await s.person({ name: 'Thornwick', cls: 'WARRIOR', spec: 'Arms' });
  return s;
}

check('csv import preview: every line says what it would do - new person, alt of the main in the file, on the roster, a question, or a problem', async () => {
  const s = await csvScenario();
  const preview = (who, body) => s.call(who, 'POST', '/roster/import/csv/preview', body);
  // Shape checks first (no query), then the guild checks.
  for (const [body, field] of [[{}, 'teamId'], [{ teamId: s.tid }, 'text'], [{ teamId: s.tid, text: '   ' }, 'text'], [{ teamId: s.tid, text: 'name,class\n' }, 'text'], [{ teamId: s.tid, text: 'name,spec\nA,Fire\n' }, 'text']]) {
    const res = await preview('officer', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json.field, field, res.text);
  }
  assert.equal((await preview('officer', { teamId: s.tid, text: `name,class\n${'Name,Mage\n'.repeat(501)}` })).status, 400, 'more than 500 rows');
  assert.equal((await preview('m1', { teamId: s.tid, text: CSV_ALPHA_BRAVO })).status, 403, 'a member cannot import');
  assert.equal((await preview('officer', { teamId: s.tid, text: CSV_ALPHA_BRAVO, defaultStatus: 'inactive' })).status, 400);
  const res = await s.ok('officer', 'POST', '/roster/import/csv/preview', { teamId: s.tid, text: CSV_ALPHA_BRAVO }, 200);
  assert.equal(res.header, true);
  assert.deepEqual(res.columns, ['name', 'class', 'spec', 'team', 'mainalt', 'status', 'joined', 'owner']);
  assert.deepEqual(res.team, { id: s.tid, name: 'Alpha' });
  const by = Object.fromEntries(res.rows.map((r) => [r.line, r]));
  assert.deepEqual([by[2].name, by[2].class, by[2].spec, by[2].teamName, by[2].status, by[2].joinedOn, by[2].action, by[2].withLine, by[2].problems], ['Newwarr', 'WARRIOR', 'Protection', 'Alpha', 'trial', '2026-10-01', 'new', null, []]);
  assert.deepEqual([by[3].teamName, by[3].action, by[3].withLine, by[3].needsDecision], ['Bravo', 'alt', 2, false]);
  assert.deepEqual([by[4].taken, by[4].action], [{ personId: s.thorn.pid, name: 'Thornwick' }, 'skip']);
  assert.deepEqual([by[5].action, by[5].needsDecision, by[5].suggestion], ['alt', true, { personId: s.thorn.pid, name: 'Thornwick' }], 'the owner names a character on the roster');
  assert.deepEqual([by[6].needsDecision, by[6].suggestion], [true, null]);
  assert.equal(by[7].problems.length, 1);
  assert(by[8].problems[0].includes('Zulu'));
  assert(by[9].problems[0].includes('twice'), 'a character twice in the file');
  assert.deepEqual(res.totals, { rows: 8, people: 1, alts: 3, taken: 1, problems: 3 });
  // A team lead of Alpha is told which rows they cannot add.
  const lead = await s.ok('lead', 'POST', '/roster/import/csv/preview', { teamId: s.tid, text: CSV_ALPHA_BRAVO }, 200);
  assert(lead.rows.find((r) => r.line === 3).problems[0].includes('cannot add to Bravo'));
  // Without a header the columns are read in the documented order; semicolons and quotes work.
  const plain = await s.ok('officer', 'POST', '/roster/import/csv/preview', { teamId: s.tid, text: 'Hunterone;Hunter;"Beast Mastery";;Alpha;main;reserve;2026-09-09\n' }, 200);
  assert.equal(plain.header, false);
  assert.deepEqual([plain.rows[0].name, plain.rows[0].spec, plain.rows[0].status, plain.rows[0].joinedOn, plain.rows[0].line], ['Hunterone', 'Beast Mastery', 'reserve', '2026-09-09', 1]);
  // The preview stores nothing.
  assert.equal(await s.w.count('players'), 1);
});

check('csv import commit: people and characters in one batch with their own team, status and join date; alts attach to the new person or to one on the roster; the log says CSV', async () => {
  const s = await csvScenario();
  const rows = [
    { line: 2, action: 'new', name: 'Newwarr', class: 'WARRIOR', spec: 'Protection', teamId: s.tid, status: 'trial', joinedOn: '2026-10-01' },
    { line: 3, action: 'alt', withLine: 2, name: 'Newmage', class: 'MAGE', spec: 'Fire', teamId: s.tids[1], status: 'trial' },
    { line: 5, action: 'alt', personId: s.thorn.pid, name: 'Lonelyalt', class: 'ROGUE', teamId: s.tid },
    { line: 6, action: 'new', name: 'Orphanalt', class: 'PRIEST', spec: 'Holy', teamId: s.tids[1] },
    { line: 7, action: 'skip', name: 'Whatever', class: 'MAGE' },
  ];
  const res = await s.ok('officer', 'POST', '/roster/import/csv/commit', { teamId: s.tid, rows }, 201);
  assert.deepEqual([res.people, res.characters], [2, 4]);
  const chars = await s.rows('SELECT c.name, c.team_id, c.is_main, c.main_spec, c.player_id, p.status, p.joined_on, p.trial_start FROM characters c JOIN players p ON p.id = c.player_id ORDER BY c.name');
  const byName = Object.fromEntries(chars.map((c) => [c.name, c]));
  assert.deepEqual([byName.Newwarr.team_id, byName.Newwarr.is_main, byName.Newwarr.main_spec, byName.Newwarr.status, byName.Newwarr.joined_on, byName.Newwarr.trial_start], [s.tid, 1, 'Protection', 'trial', '2026-10-01', '2026-10-01']);
  assert.deepEqual([byName.Newmage.team_id, byName.Newmage.is_main, byName.Newmage.player_id === byName.Newwarr.player_id], [s.tids[1], 0, true], 'an alt on the other team, on the new person');
  assert.deepEqual([byName.Lonelyalt.player_id === s.thorn.pid, byName.Lonelyalt.is_main], [true, 0]);
  assert.deepEqual([byName.Orphanalt.team_id, byName.Orphanalt.status, byName.Orphanalt.is_main], [s.tids[1], 'raider', 1]);
  assert.equal(byName.Orphanalt.joined_on, '2027-01-15', 'no date: joined today (the guild\'s)');
  const audit = (await s.rows("SELECT action, after FROM audit_log WHERE action = 'roster.import'"))[0];
  assert.deepEqual(JSON.parse(audit.after), { source: 'csv', ref: '5 rows', people: 2, characters: 4 });
  const { describeRow } = await load('worker/audit-view.js');
  assert.equal(describeRow({ action: 'roster.import', entityType: 'team', entityId: s.tid, before: null, after: JSON.parse(audit.after) }, { team: () => 'Alpha' }), 'Imported 2 people and 4 characters from a CSV file into Alpha');
  assert.equal(await s.w.count('players'), 3);
});

check('csv import commit: every row is checked again - names, classes, specs, teams, dates, permissions, duplicates, orphans - and nothing is written on a refusal', async () => {
  const s = await csvScenario();
  const base = { line: 2, action: 'new', name: 'Fresh', class: 'MAGE', teamId: s.tid };
  // Imports are limited to ten in ten minutes: every call here waits out the window.
  const commit = (who, rows, extra = {}) => { s.w.advance(11 * 60 * 1000); return s.call(who, 'POST', '/roster/import/csv/commit', { teamId: s.tid, rows, ...extra }); };
  const refuse = async (who, rows, status, code) => {
    const res = await commit(who, rows);
    assert.equal(res.status, status, `${JSON.stringify(rows)}: ${res.text}`);
    if (code) assert.equal(res.json.error === code || res.json.field === code, true, res.text);
    return res;
  };
  const before = await s.w.count('characters');
  assert.equal((await s.call('officer', 'POST', '/roster/import/csv/commit', { teamId: s.tid })).status, 400);
  await refuse('officer', [{ ...base, action: 'maybe' }], 400, 'action');
  await refuse('officer', [{ ...base, line: 0 }], 400, 'line');
  await refuse('officer', [base, { ...base, name: 'Other' }], 400, 'rows');
  await refuse('officer', [{ ...base, name: 'X' }], 400, 'name');
  await refuse('officer', [{ ...base, class: 'DEMON' }], 400, 'class');
  await refuse('officer', [{ ...base, spec: 'Holy' }], 400, 'spec');
  await refuse('officer', [{ ...base, realm: 'Nowhere' }], 400, 'realm');
  await refuse('officer', [{ ...base, teamId: 't_AAAAAAAAAAAAAAAAAAAAAA' }], 400, 'teamId');
  await refuse('officer', [{ ...base, status: 'inactive' }], 400, 'status');
  await refuse('officer', [{ ...base, joinedOn: '2026-13-40' }], 400, 'joinedOn');
  await refuse('officer', [{ ...base, action: 'alt' }], 400, 'personId');
  await refuse('officer', [{ ...base, action: 'alt', withLine: 99 }], 400, 'personId');
  await refuse('officer', [{ ...base, action: 'alt', personId: 'p_AAAAAAAAAAAAAAAAAAAAAA' }], 404);
  await refuse('officer', [{ ...base, action: 'alt', personId: 'nope' }], 400, 'personId');
  const dup = await refuse('officer', [base, { ...base, line: 3, name: 'fresh' }], 400, 'name_taken');
  assert.equal(dup.json.index, 1);
  const taken = await refuse('officer', [{ ...base, name: 'Thornwick' }], 409, 'name_taken');
  assert.equal(taken.json.owner.name, 'Thornwick');
  // Permission: a lead of Alpha may add to Alpha, not to Bravo, and not as an alt of a person whose Main is on Bravo.
  const denied = await refuse('lead', [base, { ...base, line: 3, name: 'Elsewhere', teamId: s.tids[1] }], 403);
  assert.equal(denied.json.index, 1);
  const bravoPerson = await s.person({ name: 'Bravoperson', team: s.tids[1] });
  await refuse('lead', [{ ...base, action: 'alt', personId: bravoPerson.pid }], 403);
  await refuse('m1', [base], 403);
  assert.equal(await s.w.count('characters'), before + 1, 'nothing was written by any refusal (only the Bravo person made above)');
  assert.equal((await commit('lead', [base])).status, 201);
  // The row limit.
  const many = Array.from({ length: 501 }, (_, i) => ({ ...base, line: i + 1, name: `Many${i}` }));
  assert.equal((await commit('officer', many)).status, 400);
});

check('csv import: a ruleset guild takes no realm column, and a realm guild takes only realms it accepts', async () => {
  const forever = await scenario({ version: 'forever' });
  const text = 'name,class,realm\nRealmless,Mage,Anything Goes\n';
  const preview = await forever.ok('gm', 'POST', '/roster/import/csv/preview', { teamId: forever.tid, text }, 200);
  assert.deepEqual([preview.rows[0].realm, preview.rows[0].problems], [null, []]);
  const tbc = await scenario({ version: 'tbc' });
  const mixed = await tbc.ok('gm', 'POST', '/roster/import/csv/preview', { teamId: tbc.tid, text: 'name,class,realm\nHome,Mage,\nAway,Mage,Dreamscythe\nLost,Mage,Atlantis\n' }, 200);
  assert.deepEqual(mixed.rows.map((r) => [r.name, r.realm, r.problems.length]), [['Home', 'Nightslayer', 0], ['Away', 'Dreamscythe', 0], ['Lost', 'Atlantis', 1]]);
  const res = await tbc.ok('gm', 'POST', '/roster/import/csv/commit', { teamId: tbc.tid, rows: [{ line: 2, action: 'new', name: 'Away', class: 'MAGE', realm: 'dreamscythe' }] }, 201);
  assert.equal(res.people, 1);
  assert.equal((await tbc.rows('SELECT realm, realm_key FROM characters'))[0].realm, 'Dreamscythe');
});

// ---------------------------------------------------------------------------
// Migration 0017

check('migration 0017: one open round per team, picks follow their round and person, the inbox holds at most 500, deleting the guild takes it all', async () => {
  const s = await scenario({ version: 'tbc', members: ['m1'] });
  const mine = await s.person({ name: 'Notewriter', link: 'm1' });
  const { round } = await s.ok('gm', 'POST', `/teams/${s.tid}/intent`, { title: 'Launch' });
  await s.ok('gm', 'PUT', `/intent/${round.id}/picks/${mine.pid}`, { kind: 'main', class: 'WARRIOR', spec: 'Arms' }, 200);
  // The unique index: a second open round for the team cannot be written, whatever the Worker thinks.
  assert.throws(() => s.w.db.sqlite.exec(`INSERT INTO intent_rounds (id, guild_id, team_id, title, status, created_at) VALUES ('ir_${'x'.repeat(22)}', '${s.gid}', '${s.tid}', 'Second', 'open', 1)`), /UNIQUE/);
  // A pick of a person who is gone goes with the person; a round goes with its team's guild.
  const ghost = await s.person({ name: 'Ghostname' });
  await s.ok('gm', 'PUT', `/intent/${round.id}/picks/${ghost.pid}`, { kind: 'main', class: 'MAGE', spec: 'Fire' }, 200);
  assert.equal(await s.w.count('intent_picks'), 2);
  await s.ok('gm', 'DELETE', `/roster/${ghost.pid}`, { expectedVersion: 1 }, 200);
  assert.equal(await s.w.count('intent_picks'), 1, 'the pick of the removed person went too');
  // The inbox cap: 500 rows, the 501st is refused with a plain message.
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  const insert = s.w.db.sqlite.prepare(`INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, realm_key, class, answers, created_at, updated_at)
    VALUES (?, ?, ?, 'declined', ?, ?, 'nightslayer', 'MAGE', '[]', 1, 1)`);
  for (let i = 0; i < 500; i++) insert.run(`am_${String(i).padStart(22, '0')}`, s.gid, s.tid, `Filler${i}`, `filler${i}`);
  assert.equal(await s.w.count('applications'), 500);
  const a = applicant(s);
  await a.form();
  const full = await a.send({ name: 'Latecomer', class: 'MAGE', spec: 'Fire' });
  assert.equal(full.status, 409);
  assert.equal(full.json.error, 'inbox_full');
  // Deleting the guild (nobody else is in it) clears the tables of this migration.
  const guildName = 'Wave Three';
  const gone = await s.call('gm', 'DELETE', '', { confirmName: guildName });
  assert.equal(gone.status, 200, gone.text);
  for (const table of ['intent_rounds', 'intent_picks', 'applications']) assert.equal(await s.w.count(table), 0, `${table} is empty`);
});

// ---------------------------------------------------------------------------
// Runner

async function main() {
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
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 14).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
