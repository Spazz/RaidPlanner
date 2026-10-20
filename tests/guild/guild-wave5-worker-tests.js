/**
 * Raidsmith guild tracker - PM wave 5 Worker tests (the pre-raid loot board with TMB / softres pastes, and manual loot awards).
 * Run: node tests/guild/guild-wave5-worker-tests.js [name-filter]
 *
 * Drives worker/index.js over the node:sqlite D1 stand-in (tests/guild-world.js) with a fixed clock. The pure rules (worker/loot-board.js) are pinned
 * directly; the routes, the visibility, the matching on read and the SQL run over HTTP. Nothing touches the network.
 */
const assert = require('node:assert/strict');
const { load, adminOf, memberOf, makeWorld, signIn, newJar } = require('../guild-world');

const SERVER = '900000000000000051';
const person = (n, name) => ({ id: `1100000000000005${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(1, 'Gmfive'), lead: person(2, 'Leadfive'), m1: person(3, 'Memberone'), m2: person(4, 'Membertwo') };
const TZ = 'America/New_York';
const NOW = 1_800_000_000_000; // 2027-01-15T08:00Z: 2027-01-05 and 2027-01-12 are past, 2027-01-20 is upcoming
const at = (date, time) => Date.parse(`${date}T${time}:00-05:00`);

const SPEC_OF = { WARRIOR: 'Arms', MAGE: 'Fire', PRIEST: 'Holy' };
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// A guild with a Guild Master, optionally a team lead (lead) and members (m1 / m2, signed in), one team "Alpha" on Nightslayer.
async function scenario({ members = [], teams = 1 } = {}) {
  const w = await makeWorld();
  w.clock.now = NOW;
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Wave Five', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: TZ,
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
    w, gid, tids, tid: tids[0], jars, uids, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) {
      w.advance(1000);
      return w.call(jars[who], method, `${s.base}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    // A raider on a team: { pid, cid }. link: the key of a signed-in member whose account becomes theirs.
    async person(name, { team = tids[0], cls = 'WARRIOR', link = null } = {}) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId: team, name, class: cls, mainSpec: SPEC_OF[cls], offSpec: null, status: 'raider', ...(link ? { linkUserId: uids[link] } : {}) });
      return { pid: res.person.id, cid: res.characters[0].id };
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    // A past raid (the clock is 2027-01-15) with these people ticked present, or an upcoming one (no attendance yet).
    async raid(raidOn, present = null, team = tids[0]) {
      const res = await s.ok('gm', 'POST', '/raids', { teamId: team, raidOn, startTime: '20:00', zone: "Gruul's Lair" });
      const id = res.raid.id;
      if (present) await s.ok('gm', 'PUT', `/raids/${id}/manual`, { reason: 'No log kept', presentPlayerIds: present }, 200);
      return id;
    },
    signup(who, rid, pid, kind = 'signed') { return s.ok(who, 'PUT', `/raids/${rid}/signups/${pid}`, { kind }, 200); },
    tmb: (rows) => ({ source: 'tmb', rows }),
    softres: (rows) => ({ source: 'softres', rows }),
    paste: (who, rid, body) => s.call(who, 'PUT', `/raids/${rid}/loot-lists`, body),
    board: (who, rid) => s.call(who, 'GET', `/raids/${rid}/loot-board`),
    async audits(action) { return s.rows('SELECT actor_user_id, entity_type, entity_id, before, after FROM audit_log WHERE guild_id = ? AND action = ? ORDER BY created_at, id', gid, action); },
  };
  return s;
}

const prio = (name, itemId, order, extra = {}) => ({ name, itemId, kind: 'prio', prio: order, ...extra });
const wish = (name, itemId, order) => ({ name, itemId, kind: 'wish', prio: order });
const sr = (name, itemId, copies = 1) => ({ name, itemId, copies });
// A Gargul award as the browser normalizes it.
const gargul = (n, over = {}) => ({
  checksum: `GARG${String(n).padStart(12, '0')}`, itemId: 30000 + n, itemName: `Item ${n}`, quality: 4, awardedAt: at('2027-01-05', '20:30'),
  winnerName: 'Aldric', winnerRealm: 'Nightslayer', winnerClass: 'WARRIOR', rollType: 'MS', flags: [], awardedBy: 'Lead-Nightslayer', ...over,
});
const lineOf = (item) => item.line.map((entry) => `${entry.kind}:${entry.name}${entry.prio === null || entry.kind === 'sr' ? '' : '#' + entry.prio}${entry.received ? '(got)' : ''}${entry.guest ? '(guest)' : ''}`);
const itemOf = (board, id) => board.items.find((item) => item.itemId === id);

// ---------------------------------------------------------------------------
// Schema

check('migration 0019: manual column and list tables are added, loot_awards keeps its source CHECK (not rebuilt)', async () => {
  const w = await makeWorld();
  const columns = (await w.rows("SELECT name FROM pragma_table_info('loot_awards')")).map((row) => row.name);
  assert(columns.includes('manual'));
  const table = (await w.rows("SELECT sql FROM sqlite_master WHERE name = 'loot_awards'"))[0].sql;
  assert(table.includes("CHECK (source IN ('gargul'))"), 'the 0008 / 0011 CHECK is untouched');
  assert(table.includes('manual INTEGER NOT NULL DEFAULT 0'), 'ADD COLUMN');
  const tables = (await w.rows("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name);
  assert(tables.includes('raid_loot_lists') && tables.includes('raid_loot_imports'));
  assert.equal((await w.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'loot_awards_%' AND type = 'table'"))[0].n, 0);
});

// ---------------------------------------------------------------------------
// Pure rules

check('readListRows: TMB rows are validated, the same person and item merge (best order), softres copies add up, an empty list is fine', async () => {
  const { readListRows, MAX_LIST_ROWS } = await load('worker/loot-board.js');
  const rows = readListRows('tmb', [prio('thornwick', 28770, 3), prio('Thornwick', 28770, 1), wish('Thornwick', 28770, 2), prio('Mendra', 28770, null), { name: 'Quill', itemId: 5, kind: 'prio', itemName: '  Edge  ' }]);
  assert.deepEqual(rows.map((r) => [r.kind, r.name, r.nameKey, r.itemId, r.prio]), [
    ['prio', 'Thornwick', 'thornwick', 28770, 1], ['wish', 'Thornwick', 'thornwick', 28770, 2], ['prio', 'Mendra', 'mendra', 28770, null], ['prio', 'Quill', 'quill', 5, null],
  ]);
  assert.equal(rows[3].itemName, 'Edge');
  const soft = readListRows('softres', [sr('Pugone', 28770), sr('pugone', 28770, 2), { name: 'Pugtwo', itemId: 7 }]);
  assert.deepEqual(soft.map((r) => [r.kind, r.name, r.copies]), [['sr', 'Pugone', 3], ['sr', 'Pugtwo', 1]]);
  assert.deepEqual(readListRows('tmb', []), []);
  const refused = (source, list, field) => assert.throws(() => readListRows(source, list), (e) => e.status === 400 && (field === undefined || e.extra.field === field || e.extra.rowField === field), JSON.stringify(list).slice(0, 80));
  refused('other', [], 'source');
  refused('tmb', 'x', 'rows');
  refused('tmb', [prio('X', 1, 1)], 'name');
  refused('tmb', [prio('Thornwick', 0, 1)], 'itemId');
  refused('tmb', [prio('Thornwick', 1.5, 1)], 'itemId');
  refused('tmb', [{ name: 'Thornwick', itemId: 1, kind: 'bonus' }], 'kind');
  refused('tmb', [prio('Thornwick', 1, 10000)], 'prio');
  refused('tmb', [prio('Thornwick', 1, -1)], 'prio');
  refused('softres', [sr('Pugone', 1, 0)], 'copies');
  refused('softres', [sr('Pugone', 1, 21)], 'copies');
  refused('tmb', [null], 'row');
  refused('tmb', Array.from({ length: MAX_LIST_ROWS + 1 }, (_, i) => prio('Thornwick', i + 1, 1)), 'rows');
  try { readListRows('tmb', [prio('Thornwick', 1, 1), prio('Z', 2, 1)]); assert.fail('refused'); } catch (e) { assert.equal(e.extra.index, 1); assert.match(e.message, /^Row 2:/); }
});

check('expectedPeople: a Raidsmith sign-up replaces the Raid-Helper row, standby counts, the plan and attendance add people, nothing known falls back to the team', async () => {
  const { expectedPeople } = await load('worker/loot-board.js');
  const row = (source, player_id, kind, standby = 0) => ({ source, player_id, kind, standby });
  const got = expectedPeople({
    signupRows: [row('raid_helper', 'p1', 'signed'), row('raidsmith', 'p1', 'absence'), row('raid_helper', 'p2', 'signed'), row('raidsmith', 'p3', 'signed', 1), row('raid_helper', 'p4', 'tentative'),
      row('plan', 'p5', 'bench'), row('plan', 'p6', 'signed'), row('raid_helper', 'p7', 'late'), row('raid_helper', null, 'signed')],
    attendanceRows: [{ player_id: 'p4', outcome: 'present' }, { player_id: 'p8', outcome: 'fill_in' }, { player_id: 'p9', outcome: 'missed' }],
    teamPeopleIds: ['p1', 'p2', 'p10'],
  });
  assert.equal(got.source, 'signups');
  assert.deepEqual([...got.ids].sort(), ['p2', 'p3', 'p4', 'p6', 'p7', 'p8']);
  const none = expectedPeople({ signupRows: [row('raid_helper', 'p1', 'absence')], attendanceRows: [], teamPeopleIds: ['p1', 'p10'] });
  assert.deepEqual([none.source, [...none.ids]], ['team', ['p1', 'p10']]);
});

check('buildBoard: prio order, roll-off rules (same top prio, two soft-reserves, prio plus soft-res, one person on both counts once), received, wishlists, guests, results', async () => {
  const { buildBoard } = await load('worker/loot-board.js');
  const ch = (name, player, cls = 'WARRIOR') => ({ player_id: player, name, class: cls, team_id: 't1', is_main: 1 });
  const characters = new Map([['aldric', ch('Aldric', 'pA')], ['brindle', ch('Brindle', 'pB')], ['cassia', ch('Cassia', 'pC')], ['dunmar', ch('Dunmar', 'pD')]]);
  const expected = new Set(['pA', 'pB', 'pC']);
  const r = (kind, name, item, prioValue = null, over = {}) => ({ source: kind === 'sr' ? 'softres' : 'tmb', kind, name, name_key: name.toLowerCase(), item_id: item, item_name: null, prio: prioValue, copies: 1, ...over });
  const rows = [
    r('prio', 'Brindle', 1, 2), r('prio', 'Aldric', 1, 1), r('prio', 'Dunmar', 1, 1), r('wish', 'Cassia', 1, 1),     // 1: Dunmar is not coming; Aldric alone at the top
    r('prio', 'Aldric', 2, 1), r('prio', 'Brindle', 2, 1),                                                         // 2: two at the same top prio
    r('sr', 'Pugone', 3), r('sr', 'Pugtwo', 3),                                                                     // 3: two soft-reserves
    r('prio', 'Cassia', 4, 1), r('sr', 'Pugone', 4),                                                                // 4: one prio plus a pug
    r('prio', 'Aldric', 5, 1), r('sr', 'Aldric', 5),                                                                // 5: one person on both lists
    r('wish', 'Aldric', 6, 1),                                                                                      // 6: wishlist only: not an item of this raid
    r('prio', 'Aldric', 7, 1), r('prio', 'Brindle', 7, 2),                                                          // 7: the top entry already got it
    r('prio', 'Aldric', 8, 1, { item_name: 'Pasted Name' }), r('prio', 'Zeta', 9, 1),                               // 8: named by the paste; 9: nobody on the roster
    r('sr', 'Aldric', 10, 1, { copies: 2 }), r('sr', 'Dunmar', 10),                                                // 10: a member with two copies; a member who is not coming
  ];
  const board = buildBoard({
    rows, characters, expected,
    receivedKeys: new Set(['7|aldric']), itemNames: new Map([[2, 'Named By Awards']]),
    awards: [
      { item_id: 1, tag: 'MS', winner_name: 'Aldric', winner_name_key: 'aldric', personId: 'pA' },
      { item_id: 2, tag: 'MS', winner_name: 'Cassia', winner_name_key: 'cassia', personId: 'pC' },
      { item_id: 3, tag: 'MS', winner_name: 'Pugtwo', winner_name_key: 'pugtwo', personId: null },
      { item_id: 7, tag: 'MS', winner_name: 'Brindle', winner_name_key: 'brindle', personId: 'pB' },
      { item_id: 7, tag: 'DE', winner_name: null, winner_name_key: null, personId: null },
    ],
  });
  assert.deepEqual(board.items.map((i) => i.itemId), [2, 3, 4, 8, 1, 5, 7, 10], 'contested first, then named items, then by id; items 6 and 9 are not shown');
  assert.equal(itemOf(board, 6), undefined);
  assert.equal(itemOf(board, 9), undefined);
  const one = itemOf(board, 1);
  assert.deepEqual(lineOf(one), ['prio:Aldric#1', 'prio:Brindle#2', 'wish:Cassia#1']);
  assert.deepEqual([one.contested, one.done, one.omitted, one.line.map((e) => e.top)], [false, false, 1, [true, false, false]]);
  assert.deepEqual(one.results.map((x) => x.result), ['top']);
  const two = itemOf(board, 2);
  assert.deepEqual([two.contested, two.itemName], [true, 'Named By Awards']);
  assert.deepEqual(two.results.map((x) => x.result), ['elsewhere']);
  const three = itemOf(board, 3);
  assert.deepEqual([three.contested, lineOf(three)], [true, ['sr:Pugone(guest)', 'sr:Pugtwo(guest)']]);
  assert.deepEqual(three.results.map((x) => [x.result, x.kind]), [['top', 'sr']], 'a soft-reserve holder is at the head of the line');
  const four = itemOf(board, 4);
  assert.deepEqual([four.contested, lineOf(four)], [true, ['prio:Cassia#1', 'sr:Pugone(guest)']]);
  assert.equal(itemOf(board, 5).contested, false, 'one person on both lists is one contender');
  const seven = itemOf(board, 7);
  assert.deepEqual([seven.contested, lineOf(seven), seven.done], [false, ['prio:Aldric#1(got)', 'prio:Brindle#2'], false]);
  assert.deepEqual(seven.line.map((e) => e.top), [false, true], 'the one who already has it is not the top');
  assert.deepEqual(seven.results.map((x) => x.result), ['top', 'disenchanted']);
  assert.equal(itemOf(board, 8).itemName, 'Pasted Name');
  const ten = itemOf(board, 10);
  assert.deepEqual([lineOf(ten), ten.omitted, ten.line[0].copies], [['sr:Aldric'], 1, 2]);
  assert.deepEqual(board.unmatched, ['Zeta']);
  const done = buildBoard({ rows: [r('prio', 'Aldric', 7, 1)], characters, expected, receivedKeys: new Set(['7|aldric']), itemNames: new Map(), awards: [] });
  assert.deepEqual([done.items[0].done, done.items[0].contested], [true, false]);
});

check('audit sentences for the two new actions', async () => {
  const { describeRow, ACTION_GROUP, unmappedActions } = await load('worker/audit-view.js');
  assert.deepEqual(unmappedActions(), []);
  assert.equal(ACTION_GROUP['loot.list'], 'loot');
  assert.equal(ACTION_GROUP['loot.add'], 'loot');
  const names = { raid: () => 'Tue Jan 5', award: () => 'Tier Token' };
  assert.equal(describeRow({ action: 'loot.list', entityType: 'raid', entityId: 'r_x', before: null, after: { source: 'tmb', rows: 12, items: 4, people: 3 } }, names),
    'Pasted the TMB loot prios for the raid on Tue Jan 5 (12 rows for 4 items)');
  assert.equal(describeRow({ action: 'loot.list', entityType: 'raid', entityId: 'r_x', before: null, after: { source: 'softres', rows: 1, items: 1, people: 1 } }, names),
    'Pasted the soft-reserves for the raid on Tue Jan 5 (1 row for 1 item)');
  assert.equal(describeRow({ action: 'loot.list', entityType: 'raid', entityId: 'r_x', before: null, after: { source: 'softres', rows: 0, items: 0, people: 0 } }, names),
    'Cleared the soft-reserves of the raid on Tue Jan 5');
  assert.equal(describeRow({ action: 'loot.add', entityType: 'loot', entityId: 'lo_x', before: null, after: { raidId: 'r_x', itemId: 28770, tag: 'MS', manual: true } }, names),
    'Added Tier Token by hand to the raid on Tue Jan 5');
  assert.equal(describeRow({ action: 'loot.add', entityType: 'loot', entityId: 'lo_x', before: null, after: { raidId: 'r_x', itemId: 28770 } }, {}),
    'Added a loot award (item 28770) by hand to the raid on a raid');
});

// ---------------------------------------------------------------------------
// Pasted lists and the board

check('PUT loot-lists: an officer pastes TMB and softres on an upcoming raid; a paste replaces only its own source; an empty paste clears it; each is audited', async () => {
  const s = await scenario({ members: ['m1'] });
  const up = await s.raid('2027-01-20');
  const first = await s.paste('gm', up, s.tmb([prio('Thornwick', 28770, 1), prio('Mendra', 28770, 2), wish('Mendra', 30311, 1)]));
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.lists.tmb.rows, 3);
  assert.equal(first.json.lists.softres, null);
  assert.equal(first.json.canEdit, true);
  assert.equal(first.json.raid.upcoming, true);
  assert.equal((await s.paste('gm', up, s.softres([sr('Pugone', 28770, 2)]))).status, 200);
  assert.equal(await s.w.count('raid_loot_lists', "raid_id = ? AND source = 'tmb'", up), 3);
  assert.equal(await s.w.count('raid_loot_lists', "raid_id = ? AND source = 'softres'", up), 1);
  const again = await s.paste('gm', up, s.tmb([prio('Thornwick', 28770, 1)]));
  assert.equal(again.json.lists.tmb.rows, 1);
  assert.equal(await s.w.count('raid_loot_lists', "raid_id = ? AND source = 'tmb'", up), 1, 're-paste replaces');
  assert.equal(await s.w.count('raid_loot_lists', "raid_id = ? AND source = 'softres'", up), 1, 'the other source stays');
  const rows = await s.rows("SELECT position, kind, name, name_key, prio, copies FROM raid_loot_lists WHERE raid_id = ? ORDER BY source, position", up);
  assert.deepEqual(rows.map((r) => [r.kind, r.name_key, r.prio, r.copies, r.position]), [['sr', 'pugone', null, 2, 0], ['prio', 'thornwick', 1, 1, 0]]);
  const cleared = await s.paste('gm', up, s.softres([]));
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.lists.softres, null);
  assert.equal(await s.w.count('raid_loot_imports', 'raid_id = ?', up), 1);
  const audits = await s.audits('loot.list');
  assert.deepEqual(audits.map((a) => JSON.parse(a.after)), [
    { source: 'tmb', rows: 3, items: 2, people: 2 }, { source: 'softres', rows: 1, items: 1, people: 1 }, { source: 'tmb', rows: 1, items: 1, people: 1 }, { source: 'softres', rows: 0, items: 0, people: 0 },
  ]);
  assert.deepEqual([audits[0].entity_type, audits[0].entity_id], ['raid', up]);
  const meta = await s.rows('SELECT source, row_count, imported_by FROM raid_loot_imports WHERE raid_id = ?', up);
  assert.deepEqual(meta.map((m) => [m.source, m.row_count]), [['tmb', 1]]);
  assert(meta[0].imported_by);
});

check('PUT loot-lists: loot.edit only (a member 403, a team lead of another team 403), bad input 400 with the row, another guild\'s raid 404, a deleted raid takes its lists', async () => {
  const s = await scenario({ members: ['m1', 'lead'], teams: 2 });
  await s.ok('gm', 'PUT', `/people/${s.uids.lead}/roles`, { officer: false, teamLeadTeamIds: [s.tids[1]] }, 200);
  const up = await s.raid('2027-01-20');
  const body = s.tmb([prio('Thornwick', 28770, 1)]);
  assert.equal((await s.paste('m1', up, body)).status, 403);
  assert.equal((await s.paste('lead', up, body)).status, 403, 'a lead of Bravo is not an editor of Alpha');
  assert.equal(await s.w.count('raid_loot_lists'), 0);
  const badRow = await s.paste('gm', up, s.tmb([prio('Thornwick', 28770, 1), prio('X', 5, 1)]));
  assert.equal(badRow.status, 400);
  assert.equal(badRow.json.field, 'rows');
  assert.equal(badRow.json.index, 1);
  assert.equal(await s.w.count('raid_loot_lists'), 0, 'nothing is written for a refused paste');
  assert.equal((await s.paste('gm', up, { source: 'wowhead', rows: [] })).status, 400);
  assert.equal((await s.paste('gm', up, { source: 'tmb' })).status, 400);
  assert.equal((await s.paste('gm', 'r_AAAAAAAAAAAAAAAAAAAAAA', body)).status, 404);
  assert.equal((await s.paste('gm', up, body)).status, 200);
  await s.ok('gm', 'PUT', `/people/${s.uids.lead}/roles`, { officer: false, teamLeadTeamIds: [s.tids[0]] }, 200);
  assert.equal((await s.paste('lead', up, s.tmb([prio('Thornwick', 28770, 2)]))).status, 200, 'the lead of Alpha may');
  assert.equal((await s.call('gm', 'DELETE', `/raids/${up}`, {})).status, 200);
  assert.equal(await s.w.count('raid_loot_lists'), 0);
  assert.equal(await s.w.count('raid_loot_imports'), 0);
});

check('GET loot-board: the roster is the Raidsmith sign-ups, TMB prio people on it come first, pugs after, a person who is away from the raid is left out', async () => {
  const s = await scenario({ members: ['m1'] });
  const a = await s.person('Aldric');
  const b = await s.person('Brindle', { cls: 'MAGE' });
  const c = await s.person('Cassia', { cls: 'PRIEST' });
  const up = await s.raid('2027-01-20');
  await s.signup('gm', up, a.pid);
  await s.signup('gm', up, b.pid, 'late');
  await s.signup('gm', up, c.pid, 'absence');
  assert.equal((await s.paste('gm', up, s.tmb([prio('Brindle', 28770, 2), prio('aldric', 28770, 1), prio('Cassia', 30311, 1), prio('Nobody', 28770, 3), wish('Aldric', 28770, 1)]))).status, 200);
  const res = await s.paste('gm', up, s.softres([sr('Pugone', 28770), sr('Cassia', 28770)]));
  assert.equal(res.status, 200);
  const board = (await s.board('gm', up)).json;
  assert.deepEqual(board.roster, { source: 'signups', people: 2 });
  assert.deepEqual(board.items.map((i) => i.itemId), [28770], 'Cassia (absent) is the only prio on 30311: nobody is in line, so the item is not shown');
  const item = board.items[0];
  assert.deepEqual(lineOf(item), ['prio:Aldric#1', 'prio:Brindle#2', 'sr:Pugone(guest)', 'wish:Aldric#1']);
  assert.deepEqual([item.contested, item.omitted, item.itemName], [true, 2, null]);
  assert.deepEqual(item.line[0], { key: 'prio:aldric', name: 'Aldric', nameKey: 'aldric', personId: a.pid, class: 'WARRIOR', kind: 'prio', prio: 1, copies: 1, guest: false, received: false, top: true });
  assert.deepEqual(board.unmatched, ['Nobody']);
  assert.equal(board.lists.tmb.rows, 5);
  assert.equal(typeof board.lists.tmb.importedAt, 'number');
});

check('GET loot-board: with no sign-ups the whole team is expected', async () => {
  const s = await scenario();
  const a = await s.person('Aldric');
  await s.person('Brindle', { cls: 'MAGE' });
  const up = await s.raid('2027-01-20');
  await s.paste('gm', up, s.tmb([prio('Brindle', 1, 1), prio('Aldric', 1, 1), prio('Zed', 2, 1)]));
  const board = (await s.board('gm', up)).json;
  assert.deepEqual(board.roster, { source: 'team', people: 2 });
  assert.deepEqual([board.items[0].contested, lineOf(board.items[0])], [true, ['prio:Aldric#1', 'prio:Brindle#1']]);
  assert.equal(a.pid.startsWith('p_'), true);
});

check('GET loot-board: item names come from the guild\'s earlier awards; an item received on an earlier raid of the team is greyed, another team\'s is not', async () => {
  const s = await scenario({ teams: 2 });
  const [A, B] = s.tids;
  const aldric = await s.person('Aldric', { team: A });
  const brindle = await s.person('Brindle', { team: A, cls: 'MAGE' });
  const past = await s.raid('2027-01-05', [aldric.pid, brindle.pid]);
  const other = await s.raid('2027-01-05', [], B);
  await s.ok('gm', 'POST', `/raids/${past}/loot`, { awards: [gargul(1, { itemId: 28770, itemName: 'Tier Token', winnerName: 'Aldric' }), gargul(2, { itemId: 30311, itemName: 'Other Thing', winnerName: 'Aldric' })] }, 200);
  const [shard] = await s.rows("SELECT id FROM loot_awards WHERE item_id = 30311");
  await s.ok('gm', 'PATCH', `/loot/${shard.id}`, { tag: 'DE' }, 200);
  await s.ok('gm', 'POST', `/raids/${other}/loot`, { awards: [gargul(3, { itemId: 30312, itemName: 'Bravo Drop', winnerName: 'Brindle' })] }, 200);
  const up = await s.raid('2027-01-20');
  await s.paste('gm', up, s.tmb([prio('Aldric', 28770, 1), prio('Brindle', 28770, 2), prio('Aldric', 30311, 1), prio('Brindle', 30312, 1)]));
  const board = (await s.board('gm', up)).json;
  const tier = itemOf(board, 28770);
  assert.equal(tier.itemName, 'Tier Token');
  assert.deepEqual(lineOf(tier), ['prio:Aldric#1(got)', 'prio:Brindle#2']);
  assert.deepEqual(tier.line.map((e) => e.top), [false, true]);
  assert.equal(tier.contested, false);
  assert.deepEqual(lineOf(itemOf(board, 30311)), ['prio:Aldric#1'], 'a disenchant is not a received item');
  assert.deepEqual(lineOf(itemOf(board, 30312)), ['prio:Brindle#1'], 'an award on another team\'s raid does not count');
});

check('GET loot-board after the raid: each Gargul award is compared with the line (went to prio #1, lower, elsewhere, disenchanted); the Loot import and the board agree on the winner', async () => {
  const s = await scenario();
  const aldric = await s.person('Aldric');
  const brindle = await s.person('Brindle', { cls: 'MAGE' });
  const cassia = await s.person('Cassia', { cls: 'PRIEST' });
  const past = await s.raid('2027-01-05', [aldric.pid, brindle.pid, cassia.pid]);
  assert.equal((await s.paste('gm', past, s.tmb([prio('Aldric', 1, 1), prio('Brindle', 1, 2), prio('Brindle', 2, 1), prio('Aldric', 2, 2), prio('Aldric', 3, 1), prio('Brindle', 4, 1)]))).status, 200, 'a past raid takes a paste too');
  await s.paste('gm', past, s.softres([sr('Visitor', 5)]));
  await s.ok('gm', 'POST', `/raids/${past}/loot`, { awards: [
    gargul(1, { itemId: 1, winnerName: 'Aldric' }), gargul(2, { itemId: 2, winnerName: 'Aldric' }), gargul(3, { itemId: 3, winnerName: 'Cassia' }),
    gargul(4, { itemId: 4, winnerName: null, winnerRealm: null, winnerClass: null, disenchanted: true }), gargul(5, { itemId: 5, winnerName: 'Visitor' }),
  ] }, 200);
  const board = (await s.board('gm', past)).json;
  assert.equal(board.raid.upcoming, false);
  const result = (id) => itemOf(board, id).results.map((r) => `${r.winner}:${r.result}`);
  assert.deepEqual(result(1), ['Aldric:top']);
  assert.deepEqual(result(2), ['Aldric:lower']);
  assert.deepEqual(result(3), ['Cassia:elsewhere']);
  assert.deepEqual(result(4), [`${null}:disenchanted`]);
  assert.deepEqual(result(5), ['Visitor:top']);
  assert.deepEqual(board.roster, { source: 'signups', people: 3 }, 'attendance gives the expected people of a past raid');
  assert.deepEqual(itemOf(board, 5).line.map((e) => e.guest), [true]);
});

check('GET loot-board: who may read it follows the loot visibility (own -> 403; the team members and a lead of the team read; another team\'s lead does not)', async () => {
  const s = await scenario({ members: ['m1', 'lead'], teams: 2 });
  await s.ok('gm', 'PUT', `/people/${s.uids.lead}/roles`, { officer: false, teamLeadTeamIds: [s.tids[1]] }, 200);
  const a = await s.person('Aldric', { link: 'm1' });
  const up = await s.raid('2027-01-20');
  await s.paste('gm', up, s.tmb([prio('Aldric', 1, 1)]));
  const seen = await s.board('m1', up);
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json.canEdit, false);
  assert.equal(seen.json.items.length, 1);
  assert.equal((await s.paste('m1', up, s.tmb([]))).status, 403);
  assert.equal((await s.board('lead', up)).status, 403, 'a lead of the other team has no loot.view on Alpha');
  await s.ok('gm', 'PUT', '/loot/policy', { teamId: null, override: { visibility: { members: 'own' } }, version: 0 }, 200);
  assert.equal((await s.board('m1', up)).status, 403, 'own: the members see only their own loot, not the board');
  assert.equal((await s.board('gm', up)).status, 200);
  await s.ok('gm', 'PUT', '/loot/policy', { teamId: null, override: { visibility: { members: 'guild' } }, version: 1 }, 200);
  assert.equal((await s.board('m1', up)).status, 200);
  assert.equal(a.pid.startsWith('p_'), true);
  assert.equal((await s.w.call({}, 'GET', `${s.base}/raids/${up}/loot-board`)).status, 401);
});

// ---------------------------------------------------------------------------
// Manual awards

check('POST loot/manual: an award by hand is a manual row with an m-checksum, shows in the raid\'s loot and in the balance, and a Gargul import never touches it', async () => {
  const s = await scenario({ members: ['m1'] });
  const aldric = await s.person('Aldric');
  const past = await s.raid('2027-01-05', [aldric.pid]);
  const res = await s.call('gm', 'POST', `/raids/${past}/loot/manual`, { itemId: 28770, itemName: 'Tier Token', winnerName: 'aldric', tag: 'MS', note: 'Traded back' });
  assert.equal(res.status, 201, res.text);
  const award = res.json.award;
  assert.equal(award.manual, true);
  assert.deepEqual([award.itemId, award.itemName, award.tag, award.tagSetBy, award.note, award.flags, award.rollType], [28770, 'Tier Token', 'MS', 'officer', 'Traded back', [], null]);
  assert.deepEqual([award.winner.name, award.winner.realm, award.match.kind, award.match.personId, award.raidId, award.raidOn], ['Aldric', 'Nightslayer', 'character', aldric.pid, past, '2027-01-05']);
  const stored = (await s.rows('SELECT * FROM loot_awards'))[0];
  assert.equal(stored.source, 'gargul');
  assert.equal(stored.manual, 1);
  assert.match(stored.checksum, /^m-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stored.checksum.length, 38);
  assert.equal(stored.awarded_at, s.w.clock.now);
  const listed = (await s.ok('gm', 'GET', `/raids/${past}/loot`)).awards;
  assert.deepEqual(listed.map((a) => [a.id, a.manual]), [[award.id, true]]);
  const balance = await s.ok('gm', 'GET', `/loot/balance?team=${s.tid}`);
  assert.equal(balance.people.find((p) => p.personId === aldric.pid).items.MS.all, 1, 'the balance counts it');
  // A Gargul export on the same raid adds its own awards and leaves the manual one alone; a normal award has no `manual` key.
  const imported = await s.ok('gm', 'POST', `/raids/${past}/loot`, { awards: [gargul(1, { itemId: 28770 })] }, 200);
  assert.equal(imported.inserted, 1);
  const both = (await s.ok('gm', 'GET', `/raids/${past}/loot`)).awards;
  assert.deepEqual(both.map((a) => [a.manual === true, a.itemId]), [[false, 28770], [true, 28770]]);
  assert.equal('manual' in both[0], false);
  assert.equal((await s.ok('gm', 'POST', `/raids/${past}/loot`, { awards: [gargul(1, { itemId: 28770 })] }, 200)).unchanged, 1);
  // Tag, note and delete work like on any award.
  assert.equal((await s.call('gm', 'PATCH', `/loot/${award.id}`, { tag: 'OS', note: null })).json.award.tag, 'OS');
  assert.equal((await s.call('gm', 'DELETE', `/loot/${award.id}`, {})).status, 200);
  assert.equal(await s.w.count('loot_awards', 'manual = 1'), 0);
  const audits = await s.audits('loot.add');
  assert.deepEqual(audits.map((a) => [a.entity_type, a.entity_id, JSON.parse(a.after)]), [['loot', award.id, { raidId: past, itemId: 28770, tag: 'MS', manual: true }]]);
});

check('POST loot/manual: a free name goes the unmatched / guest way, no winner means a disenchant, a winner of another realm keeps the realm', async () => {
  const s = await scenario();
  const aldric = await s.person('Aldric');
  const past = await s.raid('2027-01-05', [aldric.pid]);
  const free = (await s.call('gm', 'POST', `/raids/${past}/loot/manual`, { itemId: 100, winnerName: 'Zorgax' })).json.award;
  assert.deepEqual([free.match.kind, free.tag, free.manual], ['unmatched', 'MS', true]);
  const guest = await s.call('gm', 'POST', `/raids/${past}/unmatched`, { key: 'zorgax|nightslayer', action: 'guest' });
  assert.equal(guest.status, 200, guest.text);
  assert.equal((await s.ok('gm', 'GET', `/raids/${past}/loot`)).awards.find((a) => a.id === free.id).match.kind, 'guest');
  const de = (await s.call('gm', 'POST', `/raids/${past}/loot/manual`, { itemId: 101, tag: 'DE' })).json.award;
  assert.deepEqual([de.match.kind, de.tag, de.winner.name], ['disenchanted', 'DE', null]);
  const stored = (await s.rows('SELECT winner_name, winner_name_key, winner_realm_key FROM loot_awards WHERE id = ?', de.id))[0];
  assert.deepEqual(stored, { winner_name: null, winner_name_key: null, winner_realm_key: '' });
  const bank = (await s.call('gm', 'POST', `/raids/${past}/loot/manual`, { itemId: 102, winnerName: 'Guildbank', winnerRealm: 'Maladath (AU)', tag: 'BANK' })).json.award;
  assert.deepEqual([bank.tag, bank.winner.realm], ['BANK', 'Maladath (AU)']);
  assert.equal((await s.rows('SELECT winner_realm_key FROM loot_awards WHERE id = ?', bank.id))[0].winner_realm_key, 'maladath');
});

check('POST loot/manual: validation, permission, a raid that has not started, another guild', async () => {
  const s = await scenario({ members: ['m1'], teams: 2 });
  const past = await s.raid('2027-01-05');
  const up = await s.raid('2027-01-20');
  const send = (who, rid, body) => s.call(who, 'POST', `/raids/${rid}/loot/manual`, body);
  const refused = async (body, field) => {
    const res = await send('gm', past, body);
    assert.equal(res.status, 400, JSON.stringify(body) + res.text);
    assert.equal(res.json.field, field, JSON.stringify(body));
  };
  await refused({ winnerName: 'Aldric' }, 'itemId');
  await refused({ itemId: 0, winnerName: 'Aldric' }, 'itemId');
  await refused({ itemId: '28770', winnerName: 'Aldric' }, 'itemId');
  await refused({ itemId: 5 }, 'winnerName');
  await refused({ itemId: 5, winnerName: '   ' }, 'winnerName');
  await refused({ itemId: 5, winnerName: 'Al' + 'x'.repeat(12) }, 'winnerName');
  await refused({ itemId: 5, winnerName: 'R2D2' }, 'winnerName');
  await refused({ itemId: 5, winnerName: 'Aldric', tag: 'XX' }, 'tag');
  await refused({ itemId: 5, winnerName: 'Aldric', note: 'n'.repeat(201) }, 'note');
  await refused({ itemId: 5, winnerName: 'Aldric', itemName: 'n'.repeat(101) }, 'itemName');
  await refused({ itemId: 5, winnerName: 'Aldric', winnerRealm: '()' }, 'winnerRealm');
  assert.equal(await s.w.count('loot_awards'), 0);
  const early = await send('gm', up, { itemId: 5, winnerName: 'Aldric' });
  assert.equal(early.status, 409);
  assert.equal(early.json.error, 'raid_not_started');
  assert.equal((await send('m1', past, { itemId: 5, winnerName: 'Aldric' })).status, 403);
  assert.equal((await send('gm', 'r_AAAAAAAAAAAAAAAAAAAAAA', { itemId: 5, winnerName: 'Aldric' })).status, 404);
  assert.equal(await s.w.count('loot_awards'), 0);
  const ok = await send('gm', past, { itemId: 5, winnerName: 'Aldric' });
  assert.equal(ok.status, 201);
  assert.equal(await s.w.count('loot_awards'), 1);
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
