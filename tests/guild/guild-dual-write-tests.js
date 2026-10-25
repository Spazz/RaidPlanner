/**
 * Raidsmith guild tracker - the dual write R1 -> R2 (user-hierarchy build, lane B1a-1)
 * Run: node tests/guild/guild-dual-write-tests.js
 *
 * Every Worker writer of players.status / trial_start / trial_end / left_on / left_reason also writes characters.core_rank / left_on / left_reason /
 * trial_start / trial_end in the same batch (worker/person-legacy.js). The mapping of migration 0030: raider / trial / reserve -> that core_rank on every
 * character of the person, inactive -> social; left_on + left_reason only when inactive and the reason is left or kicked; trial dates only on the main
 * while trial. After each writer the re-derive tool's mismatch query (tools/hierarchy/mismatch.sql) must say 0 in all five fields, and the values are
 * pinned by name.
 *
 * Writers covered: create person, add character (+ make main), make main, patch person (status and dates), application accept, attendance "add as a
 * person / alt" (unmatched), Battle.net claim approval (new person, alt), CSV roster import (writeImport, shared by all four imports).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, adminOf, memberOf, makeWorld, signIn } = require('../guild-world');

const MISMATCH = fs.readFileSync(path.join(ROOT, 'tools/hierarchy/mismatch.sql'), 'utf8');
const ZERO = { core_rank: 0, left_on: 0, left_reason: 0, trial_start: 0, trial_end: 0 };
const SERVER = '900000000000000041';
const person = (n, name) => ({ id: `1100000000000000${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(61, 'Gmdual'), claimant: person(62, 'Claimdual'), claimant2: person(63, 'Claimtwo') };
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function scenario() {
  const w = await makeWorld({});
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Dual Write', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York',
    multipleTeams: true, teamNames: ['Alpha', 'Bravo'],
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  const s = {
    w, gid, tids, jars, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) {
      w.advance(STEP);
      return w.call(jars[who], method, tail.startsWith('/api/') || tail.startsWith('/auth/') ? tail : `${s.base}${tail}`, body);
    },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    rows: (sql, ...values) => w.rows(sql, ...values),
    async member(key) {
      jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
      return (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
    },
    async inSync(label) { assert.deepEqual(await w.db.prepare(MISMATCH).first(), ZERO, `in sync after ${label}`); },
    // The five character columns of the characters of one person, by character name.
    async chars(playerId) {
      const rows = await w.rows('SELECT name, is_main, core_rank, left_on, left_reason, trial_start, trial_end FROM characters WHERE player_id = ? ORDER BY name', playerId);
      return Object.fromEntries(rows.map((row) => [row.name, row]));
    },
    async newPerson(body) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId: tids[0], class: 'MAGE', mainSpec: 'Fire', offSpec: null, ...body });
      return { pid: res.person.id, cid: res.characters[0].id, version: res.person.version, today: res.today, res };
    },
  };
  return s;
}

const cols = (row) => [row.core_rank, row.left_on, row.left_reason, row.trial_start, row.trial_end];

check('create person: a raider, a trial with dates and a reserve start with their rank on the main; trial dates only on a trial main', async () => {
  const s = await scenario();
  const raider = await s.newPerson({ name: 'Raiderone' });
  assert.deepEqual(cols((await s.chars(raider.pid)).Raiderone), ['raider', null, null, null, null]);
  const trial = await s.newPerson({ name: 'Trialone', status: 'trial', trialEnd: '2027-02-10' });
  assert.deepEqual(cols((await s.chars(trial.pid)).Trialone), ['trial', null, null, trial.today, '2027-02-10']);
  const reserve = await s.newPerson({ name: 'Reserveone', status: 'reserve' });
  assert.deepEqual(cols((await s.chars(reserve.pid)).Reserveone), ['reserve', null, null, null, null]);
  await s.inSync('create person');
});

check('add character and make main: the alt takes the person\'s rank, the trial dates move with the main', async () => {
  const s = await scenario();
  const trial = await s.newPerson({ name: 'Trialmain', status: 'trial', trialEnd: '2027-02-10' });
  const added = await s.ok('gm', 'POST', `/roster/${trial.pid}/characters`, { teamId: s.tids[1], name: 'Trialalt', class: 'ROGUE', mainSpec: 'Combat', offSpec: null });
  const alt = added.characters.find((c) => c.name === 'Trialalt');
  let chars = await s.chars(trial.pid);
  assert.deepEqual(cols(chars.Trialalt), ['trial', null, null, null, null], 'an alt of a trial person is Trial, with no dates');
  assert.deepEqual(cols(chars.Trialmain), ['trial', null, null, trial.today, '2027-02-10']);
  await s.inSync('add character');

  const moved = await s.ok('gm', 'POST', `/roster/${trial.pid}/characters`, { teamId: s.tids[0], name: 'Thirdone', class: 'WARLOCK', mainSpec: 'Destruction', offSpec: null, makeMain: true });
  assert.equal(moved.characters.find((c) => c.name === 'Thirdone').isMain, true);
  chars = await s.chars(trial.pid);
  assert.deepEqual([cols(chars.Thirdone), cols(chars.Trialmain), cols(chars.Trialalt)], [
    ['trial', null, null, trial.today, '2027-02-10'], ['trial', null, null, null, null], ['trial', null, null, null, null],
  ], 'the dates sit on the new main only');
  await s.inSync('add character with make main');

  await s.ok('gm', 'POST', `/roster/${trial.pid}/characters/${alt.id}/main`, {}, 200);
  chars = await s.chars(trial.pid);
  assert.deepEqual([cols(chars.Trialalt), cols(chars.Thirdone)], [['trial', null, null, trial.today, '2027-02-10'], ['trial', null, null, null, null]]);
  await s.inSync('make main');
});

check('patch person: every status change reaches every character; left dates only for left / kicked; trial dates only on the main', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Mainone', status: 'trial', trialEnd: '2027-02-10' });
  await s.ok('gm', 'POST', `/roster/${p.pid}/characters`, { teamId: s.tids[1], name: 'Alttwo', class: 'ROGUE', mainSpec: 'Combat', offSpec: null });
  let version = (await s.rows('SELECT version FROM players WHERE id = ?', p.pid))[0].version;
  const patch = async (body) => {
    const res = await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: version, ...body }, 200);
    version = res.person.version;
    return res;
  };

  await patch({ status: 'inactive', leftReason: 'left', leftOn: '2027-01-10' });
  assert.deepEqual([cols((await s.chars(p.pid)).Mainone), cols((await s.chars(p.pid)).Alttwo)], [
    ['social', '2027-01-10', 'left', null, null], ['social', '2027-01-10', 'left', null, null]]);
  await s.inSync('inactive, left');

  await patch({ leftReason: 'kicked' });
  assert.deepEqual(cols((await s.chars(p.pid)).Alttwo), ['social', '2027-01-10', 'kicked', null, null]);
  await s.inSync('left reason changed');

  await patch({ leftReason: 'break' });
  assert.deepEqual(cols((await s.chars(p.pid)).Mainone), ['social', null, null, null, null], 'a break is not a leaving: the characters keep no left date');
  assert.equal((await s.rows('SELECT left_on FROM players WHERE id = ?', p.pid))[0].left_on, '2027-01-10', 'players keeps it (legacy)');
  await s.inSync('inactive, break');

  await patch({ status: 'reserve' });
  assert.deepEqual([cols((await s.chars(p.pid)).Mainone), cols((await s.chars(p.pid)).Alttwo)], [['reserve', null, null, null, null], ['reserve', null, null, null, null]]);
  await s.inSync('reserve');

  await patch({ status: 'trial', trialStart: '2027-01-02', trialEnd: '2027-01-30' });
  assert.deepEqual([cols((await s.chars(p.pid)).Mainone), cols((await s.chars(p.pid)).Alttwo)], [
    ['trial', null, null, '2027-01-02', '2027-01-30'], ['trial', null, null, null, null]]);
  await s.inSync('trial with dates');

  await patch({ trialEnd: '2027-03-01' });
  assert.equal((await s.chars(p.pid)).Mainone.trial_end, '2027-03-01');
  await s.inSync('trial end moved');

  await patch({ status: 'raider' });
  assert.deepEqual(cols((await s.chars(p.pid)).Mainone), ['raider', null, null, null, null], 'the trial dates stay on players (legacy) but not on the character');
  await s.inSync('raider');

  // A no-op patch and a stale version change nothing on either side.
  const stale = await s.call('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: 1, status: 'inactive' });
  assert.equal(stale.status, 409);
  await s.inSync('stale patch');
});

check('application accept: the new Trial person\'s main is Trial with the trial dates', async () => {
  const s = await scenario();
  const id = 'am_' + 'a'.repeat(22);
  s.w.db.sqlite.exec(`INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, realm, realm_key, class, spec, created_at, updated_at)
                      VALUES ('${id}', '${s.gid}', '${s.tids[0]}', 'new', 'Hopefuldual', 'hopefuldual', 'Nightslayer', 'nightslayer', 'MAGE', 'Frost', 1, 1)`);
  const accepted = await s.ok('gm', 'POST', `/applications/${id}/accept`, {}, 201);
  const chars = await s.chars(accepted.person.id);
  assert.deepEqual(cols(chars.Hopefuldual), ['trial', null, null, (await s.rows('SELECT trial_start FROM players WHERE id = ?', accepted.person.id))[0].trial_start, accepted.person.trialEnd]);
  assert(chars.Hopefuldual.trial_start && chars.Hopefuldual.trial_end);
  await s.inSync('application accept');
});

check('attendance "add as a person" and "add as an alt": the new character follows the players row', async () => {
  const s = await scenario();
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.tids[0], raidOn: '2027-01-02' })).raid;
  const manual = (name) => s.w.db.sqlite.exec(`INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key)
                                              VALUES ('${raid.id}', '${s.gid}', '${name}', '${name.toLowerCase()}', 'Nightslayer', 'nightslayer')`);
  manual('Walkindual');
  manual('Walkintwo');
  manual('Walkinthree');
  const asPerson = await s.ok('gm', 'POST', `/raids/${raid.id}/unmatched`, { key: 'walkindual|nightslayer', action: 'person', status: 'trial', joinedOn: '2026-12-20', class: 'MAGE' }, 200);
  assert(asPerson.raid);
  const owner = (await s.rows("SELECT player_id FROM characters WHERE name = 'Walkindual'"))[0].player_id;
  assert.deepEqual(cols((await s.chars(owner)).Walkindual), ['trial', null, null, '2026-12-20', null]);
  await s.inSync('unmatched -> person');

  await s.ok('gm', 'POST', `/raids/${raid.id}/unmatched`, { key: 'walkintwo|nightslayer', action: 'alt', personId: owner, class: 'ROGUE' }, 200);
  let chars = await s.chars(owner);
  assert.deepEqual([cols(chars.Walkindual), cols(chars.Walkintwo)], [['trial', null, null, '2026-12-20', null], ['trial', null, null, null, null]]);
  await s.inSync('unmatched -> alt');

  await s.ok('gm', 'POST', `/raids/${raid.id}/unmatched`, { key: 'walkinthree|nightslayer', action: 'alt', personId: owner, class: 'WARLOCK', makeMain: true }, 200);
  chars = await s.chars(owner);
  assert.deepEqual([cols(chars.Walkinthree), cols(chars.Walkindual)], [['trial', null, null, '2026-12-20', null], ['trial', null, null, null, null]], 'the dates follow the new main');
  await s.inSync('unmatched -> alt as main');
});

check('Battle.net claim approval: a new person and an alt take the status the person gets', async () => {
  const s = await scenario();
  const userId = await s.member('claimant');
  const claim = (id, name) => s.w.db.sqlite.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
                                                  VALUES ('${id}', '${s.gid}', '${userId}', '${name}', '${name.toLowerCase()}', 'Nightslayer', 'nightslayer', 'MAGE', 70, 'pending', 1)`);
  const first = 'cl_' + 'b'.repeat(22);
  claim(first, 'Claimeddual');
  const approved = await s.ok('gm', 'POST', `/claims/${first}/approve`, { expectedKind: 'new_person', teamId: s.tids[0], status: 'trial' }, 200);
  const chars = await s.chars(approved.personId);
  const players = (await s.rows('SELECT trial_start, trial_end FROM players WHERE id = ?', approved.personId))[0];
  assert.deepEqual(cols(chars.Claimeddual), ['trial', null, null, players.trial_start, players.trial_end]);
  assert(players.trial_start);
  await s.inSync('claim -> new person');

  const second = 'cl_' + 'c'.repeat(22);
  claim(second, 'Claimedalt');
  await s.ok('gm', 'POST', `/claims/${second}/approve`, { expectedKind: 'add_alt', teamId: s.tids[1] }, 200);
  const both = await s.chars(approved.personId);
  assert.deepEqual([cols(both.Claimedalt), cols(both.Claimeddual)], [['trial', null, null, null, null], ['trial', null, null, players.trial_start, players.trial_end]]);
  await s.inSync('claim -> alt');
});

check('CSV roster import (writeImport): people, alts of new people and alts of existing people take their person\'s rank; one sync for the whole batch', async () => {
  const s = await scenario();
  const existing = await s.newPerson({ name: 'Existingdual', status: 'reserve' });
  const rows = [
    { line: 2, action: 'new', name: 'Csvtrial', class: 'WARRIOR', spec: 'Protection', teamId: s.tids[0], status: 'trial', joinedOn: '2026-12-01' },
    { line: 3, action: 'alt', withLine: 2, name: 'Csvalt', class: 'MAGE', spec: 'Fire', teamId: s.tids[1] },
    { line: 4, action: 'alt', personId: existing.pid, name: 'Csvexalt', class: 'ROGUE', teamId: s.tids[0] },
    { line: 5, action: 'new', name: 'Csvraider', class: 'PRIEST', spec: 'Holy', teamId: s.tids[1] },
  ];
  const batches = [];
  const realBatch = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => { batches.push(statements.map((st) => st.sql)); return realBatch(statements); };
  await s.ok('gm', 'POST', '/roster/import/csv/commit', { teamId: s.tids[0], rows }, 201);
  s.w.db.batch = realBatch;
  const writes = batches.filter((statements) => statements.some((sql) => /INSERT INTO players/.test(sql)));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].filter((sql) => /^UPDATE characters SET\s+core_rank/.test(sql)).length, 1, 'one sync statement, whatever the size');
  const trialPerson = (await s.rows("SELECT player_id FROM characters WHERE name = 'Csvtrial'"))[0].player_id;
  const trialChars = await s.chars(trialPerson);
  assert.deepEqual([cols(trialChars.Csvtrial), cols(trialChars.Csvalt)], [['trial', null, null, '2026-12-01', null], ['trial', null, null, null, null]]);
  assert.deepEqual(cols((await s.chars(existing.pid)).Csvexalt), ['reserve', null, null, null, null]);
  const raider = (await s.rows("SELECT core_rank, left_on, left_reason, trial_start, trial_end FROM characters WHERE name = 'Csvraider'"))[0];
  assert.deepEqual(cols(raider), ['raider', null, null, null, null]);
  await s.inSync('csv import');
});

check('a second writer cannot leave a character behind: after a mixed run every character agrees with its person', async () => {
  const s = await scenario();
  const a = await s.newPerson({ name: 'Mixone', status: 'trial', trialEnd: '2027-02-01' });
  await s.ok('gm', 'POST', `/roster/${a.pid}/characters`, { teamId: s.tids[1], name: 'Mixtwo', class: 'ROGUE', mainSpec: 'Combat', offSpec: null });
  await s.ok('gm', 'PATCH', `/roster/${a.pid}`, { expectedVersion: a.version, status: 'inactive', leftReason: 'kicked' }, 200);
  await s.ok('gm', 'POST', `/roster/${a.pid}/characters`, { teamId: s.tids[0], name: 'Mixthree', class: 'WARLOCK', mainSpec: 'Destruction', offSpec: null });
  const chars = await s.chars(a.pid);
  for (const name of ['Mixone', 'Mixtwo', 'Mixthree']) assert.equal(chars[name].core_rank, 'social', name);
  assert.equal(chars.Mixthree.left_reason, 'kicked', 'an alt added to a person who left carries the left date');
  await s.inSync('mixed run');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 7).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
