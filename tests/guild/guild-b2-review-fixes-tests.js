/**
 * Raidsmith guild tracker - the fixes of the review of release R2 (lane B2): six findings, one regression check each
 * Run: node tests/guild/guild-b2-review-fixes-tests.js
 *
 *   1. PATCH /roster/:pid mirrors a field into players only when that field changed: a legacy players row the characters cannot carry (a Break with its
 *      left date, trial dates on a person who is not on trial) survives an unrelated PATCH; a real change still mirrors; mismatch.sql stays 0;
 *   2. the trial review of a Trial alt shows the officer notes of the person's HOME team only: the lead of the alt's team reads attendance and loot, not the notes;
 *   3. a lost Make-Main race (the same move already done by another request) does not copy the old Main's empty trial dates over the new Main's;
 *   4. a custom role that holds signups.self at guild or team scope still needs a character on the raid's team roster to sign up (U R4-Q1);
 *   5. a Team Lead cannot make a character on no team the Main (Make Main, or a new Main with no team): the person would be left without a home team and
 *      the lead locked out of it; the whole-guild editor can;
 *   6. the What's new page carries the R2 entry.
 * The guild is built through the API; a character is placed on a team (the team routes of lane B3 will do that) with the column itself.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, adminOf, load, memberOf, makeWorld, signIn } = require('../guild-world');

const MISMATCH = fs.readFileSync(path.join(ROOT, 'tools/hierarchy/mismatch.sql'), 'utf8');
const ZERO = { core_rank: 0, left_on: 0, left_reason: 0, trial_start: 0, trial_end: 0 };
const SERVER = '900000000000000093';
const person = (n, name) => ({ id: `1100000000000010${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = {
  gm: person(1, 'Gmfix'), lead: person(2, 'Leadfix'), lead2: person(3, 'Leadtwofix'), member: person(4, 'Memberfix'),
};
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function scenario({ teams = ['Alpha', 'Bravo'] } = {}) {
  const w = await makeWorld({});
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Review fixes', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York',
    multipleTeams: true, teamNames: teams,
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tids = made.json.teams.map((team) => team.id);
  const uids = {};
  const s = {
    w, gid, tids, jars, uids, base: `/api/guild/${gid}`,
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
    exec: (sql) => w.db.sqlite.exec(sql),
    async member(key) {
      jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
      uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
      return uids[key];
    },
    async lead(key, teamIds) {
      const id = await s.member(key);
      await s.ok('gm', 'PUT', `/people/${id}/roles`, { officer: false, teamLeadTeamIds: teamIds }, 200);
      return id;
    },
    async newPerson(body = {}, who = 'gm') {
      const res = await s.ok(who, 'POST', '/roster', { teamId: tids[0], class: 'MAGE', mainSpec: 'Fire', offSpec: null, ...body });
      return { pid: res.person.id, cid: res.characters[0].id, version: res.person.version, today: res.today, res };
    },
    async alt(pid, name, body = {}, who = 'gm') {
      const res = await s.ok(who, 'POST', `/roster/${pid}/characters`, { teamId: tids[0], class: 'ROGUE', mainSpec: 'Combat', offSpec: null, name, ...body });
      return res.characters.find((c) => c.name === name).id;
    },
    async inSync(label) { assert.deepEqual(await w.db.prepare(MISMATCH).first(), ZERO, `in sync after ${label}`); },
    playerRow: async (pid) => (await s.rows('SELECT status, joined_on, trial_start, trial_end, left_on, left_reason, version FROM players WHERE id = ?', pid))[0],
  };
  return s;
}

// ---------------------------------------------------------------------------
// 1. The players mirror writes only the fields that changed

check('PATCH: a joinedOn-only change keeps the legacy Break + left date of an old Inactive row and the stored trial dates of a person who is not on trial', async () => {
  const s = await scenario();
  const brk = await s.newPerson({ name: 'Legacybreak' });
  // R1 data: Inactive with the reason Break and a left date, on players only; migration 0030 maps the characters to Social with no left date.
  s.exec(`UPDATE players SET status = 'inactive', left_on = '2026-01-05', left_reason = 'break', version = version + 1 WHERE id = '${brk.pid}'`);
  s.exec(`UPDATE characters SET core_rank = 'social', left_on = NULL, left_reason = NULL WHERE player_id = '${brk.pid}'`);
  const stale = await s.newPerson({ name: 'Legacytrial' });
  s.exec(`UPDATE players SET trial_start = '2026-12-01', trial_end = '2027-01-01', version = version + 1 WHERE id = '${stale.pid}'`);
  await s.inSync('the seeded legacy rows');

  for (const [who, expected] of [
    [brk, { status: 'inactive', trial_start: null, trial_end: null, left_on: '2026-01-05', left_reason: 'break' }],
    [stale, { status: 'raider', trial_start: '2026-12-01', trial_end: '2027-01-01', left_on: null, left_reason: null }],
  ]) {
    const record = await s.ok('gm', 'GET', `/roster/${who.pid}`);
    const patched = await s.ok('gm', 'PATCH', `/roster/${who.pid}`, { expectedVersion: record.person.version, joinedOn: '2025-12-01' }, 200);
    assert.equal(patched.person.joinedOn, '2025-12-01');
    assert.equal(patched.person.version, record.person.version + 1);
    const row = await s.playerRow(who.pid);
    assert.deepEqual({ ...row, joined_on: undefined, version: undefined }, { ...expected, joined_on: undefined, version: undefined }, 'the old values are still there');
    assert.equal(row.joined_on, '2025-12-01');
    await s.inSync(`a joinedOn-only PATCH of ${patched.characters[0].name}`);
  }
});

check('PATCH: a change of status or of a date still mirrors into players, and only that field changes', async () => {
  const s = await scenario();
  const p = await s.newPerson({ name: 'Mirrorone' });
  let record = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: record.person.version, status: 'inactive', leftReason: 'kicked', leftOn: '2027-01-10' }, 200);
  assert.deepEqual(await s.playerRow(p.pid), { status: 'inactive', joined_on: p.res.person.joinedOn, trial_start: null, trial_end: null, left_on: '2027-01-10', left_reason: 'kicked', version: 2 });
  await s.inSync('Inactive + Kicked');
  record = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: record.person.version, leftOn: '2027-01-12' }, 200);
  const dated = await s.playerRow(p.pid);
  assert.deepEqual([dated.status, dated.left_on, dated.left_reason], ['inactive', '2027-01-12', 'kicked'], 'only the left date moved');
  record = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: record.person.version, status: 'trial', trialStart: '2027-01-15', trialEnd: '2027-02-15' }, 200);
  const trial = await s.playerRow(p.pid);
  assert.deepEqual([trial.status, trial.trial_start, trial.trial_end, trial.left_on, trial.left_reason], ['trial', '2027-01-15', '2027-02-15', null, null]);
  await s.inSync('Trial with dates');
  record = await s.ok('gm', 'GET', `/roster/${p.pid}`);
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: record.person.version, trialEnd: '2027-02-20' }, 200);
  const moved = await s.playerRow(p.pid);
  assert.deepEqual([moved.status, moved.trial_start, moved.trial_end], ['trial', '2027-01-15', '2027-02-20']);
  await s.inSync('a new trial end');
  // A legacy Break row that really changes (back to Raider) mirrors the new status.
  const brk = await s.newPerson({ name: 'Breakback' });
  s.exec(`UPDATE players SET status = 'inactive', left_on = '2026-01-05', left_reason = 'break', version = version + 1 WHERE id = '${brk.pid}'`);
  s.exec(`UPDATE characters SET core_rank = 'social', left_on = NULL, left_reason = NULL WHERE player_id = '${brk.pid}'`);
  record = await s.ok('gm', 'GET', `/roster/${brk.pid}`);
  await s.ok('gm', 'PATCH', `/roster/${brk.pid}`, { expectedVersion: record.person.version, status: 'raider' }, 200);
  assert.equal((await s.playerRow(brk.pid)).status, 'raider');
  assert.deepEqual((await s.rows('SELECT core_rank FROM characters WHERE player_id = ?', brk.pid)).map((r) => r.core_rank), ['raider']);
  await s.inSync('Break row back to Raider');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 8).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
