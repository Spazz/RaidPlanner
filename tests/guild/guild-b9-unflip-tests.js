/**
 * Raidsmith guild tracker - lane B9 of the user-hierarchy build: the UNFLIP tool (tools/hierarchy/unflip.js) and the acceptance of the whole flip
 * Run: node tests/guild/guild-b9-unflip-tests.js
 *
 *   - the tool refuses with a clear message when the guild has no Owner seat, is not in-game, does not exist or already has a stored Guild Master row for someone else;
 *   - its SQL restores exactly the membership and permission facts (rank source NULL, the stored Guild Master row from the seat, the seat cleared, one audit row), leaves the rest
 *     (core ranks, Trial dates, identity keys, the hand-set roles, the pin), and a second run - or a run against a guild that is not flipped - changes nothing;
 *   - a person the in-game sign-in match made after the flip stays linked after the unflip and is a member under the legacy rule;
 *   - B9 ACCEPTANCE: after flip + unflip, GET /auth/me, GET /api/guild/:gid (the permissions) and the claim list answer as they did before the flip, for every kind of account.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runChecks } = require('../guild-b3-world');
const { entry, profileOf } = require('../guild-claim');
const { flipWorld, dryRun, flipWith, rosterRow } = require('../guild-flip');
const unflip = require('../../tools/hierarchy/unflip');

globalThis.__flipWorlds = [];
const checks = [];
function check(name, fn) {
  checks.push({
    name,
    fn: async () => {
      globalThis.__flipWorlds = [];
      try {
        await fn();
      } finally {
        for (const world of globalThis.__flipWorlds) await world.close();
      }
    },
  });
}

async function flipped(options) {
  const s = await flipWorld(options);
  const dry = (await dryRun(s)).json;
  const res = await flipWith(s, dry);
  assert.equal(res.status, 200, res.text);
  return s;
}
const runUnflip = (s) => s.w.db.sqlite.exec(unflip.buildUnflipSql(s.gid));
const dump = (s) => ({
  guilds: s.w.db.sqlite.prepare('SELECT * FROM guilds ORDER BY id').all().map((row) => ({ ...row })),
  roles: s.w.db.sqlite.prepare('SELECT user_id, role_id, team_id, source FROM role_assignments ORDER BY user_id, role_id, team_id, source').all().map((row) => ({ ...row })),
  audit: s.w.db.sqlite.prepare('SELECT action FROM audit_log ORDER BY id').all().map((row) => ({ ...row })),
});

// ---------------------------------------------------------------------------
// The refusals

check('the tool refuses with a clear message: no Owner seat, not in-game, no such guild, a stored Guild Master row for another account', () => {
  const id = 'g_AAAAAAAAAAAAAAAAAAAAAA';
  assert.match(unflip.refusalFor({ id, rank_source: 'ingame', owner_user_id: null, stored_master_user: null }, id), /no Owner seat \(owner_user_id is NULL\)/);
  assert.match(unflip.refusalFor({ id, rank_source: null, owner_user_id: 'u_x', stored_master_user: 'u_x' }, id), /not on the in-game roster \(rank_source is NULL\)/);
  assert.match(unflip.refusalFor({ id, rank_source: 'manual', owner_user_id: 'u_x', stored_master_user: null }, id), /rank_source is 'manual'/);
  assert.match(unflip.refusalFor(null, id), /no guild g_/);
  assert.match(unflip.refusalFor({ id, rank_source: 'ingame', owner_user_id: 'u_x', stored_master_user: 'u_y' }, id), /another account/);
  assert.equal(unflip.refusalFor({ id, rank_source: 'ingame', owner_user_id: 'u_x', stored_master_user: null }, id), null);
  assert.equal(unflip.refusalFor({ id, rank_source: 'ingame', owner_user_id: 'u_x', stored_master_user: 'u_x' }, id), null, 'an earlier half run is finished, not refused');
});

check('the facts come out of wrangler\'s --json answer, a bare row or a list of rows; garbage is no facts', () => {
  const row = { id: 'g_x', rank_source: 'ingame', owner_user_id: 'u_x', stored_master_user: null };
  assert.deepEqual(unflip.parseFacts(`[{"results":[${JSON.stringify(row)}],"success":true,"meta":{}}]`), row);
  assert.deepEqual(unflip.parseFacts(`some banner\n[{"results":[${JSON.stringify(row)}]}]`), row);
  assert.deepEqual(unflip.parseFacts(JSON.stringify(row)), row);
  assert.deepEqual(unflip.parseFacts(JSON.stringify([row])), row);
  assert.equal(unflip.parseFacts('[{"results":[]}]'), null);
  assert.equal(unflip.parseFacts('nothing here'), null);
});

check('the command line: usage errors exit 2, a refusal exits 1, --apply needs a local --state, the SQL goes to stdout or a file, and nothing is pasted from a bad id', () => {
  const capture = () => {
    const out = { text: '', write(chunk) { this.text += chunk; } };
    return out;
  };
  const gid = 'g_AAAAAAAAAAAAAAAAAAAAAA';
  const run = (argv) => {
    const stdout = capture();
    const stderr = capture();
    return { code: unflip.main(argv, { stdout, stderr }), stdout: stdout.text, stderr: stderr.text };
  };
  assert.equal(run([]).code, 2);
  assert.equal(run(['--guild', "g_x'; DROP TABLE guilds; --"]).code, 2);
  assert.equal(run(['--guild', gid, '--apply']).code, 2);
  assert.match(run(['--guild', gid, '--apply']).stderr, /local state only/);
  assert.equal(run(['--guild', gid, '--bogus']).code, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unflip-test-'));
  try {
    const facts = path.join(dir, 'facts.json');
    fs.writeFileSync(facts, JSON.stringify([{ results: [{ id: gid, rank_source: 'ingame', owner_user_id: null, stored_master_user: null }] }]));
    const refused = run(['--guild', gid, '--facts', facts]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /REFUSED: .*owner_user_id is NULL/);
    assert.equal(refused.stdout, '');
    fs.writeFileSync(facts, JSON.stringify([{ results: [{ id: gid, rank_source: 'ingame', owner_user_id: 'u_AAAAAAAAAAAAAAAAAAAAAA', stored_master_user: null }] }]));
    const printed = run(['--guild', gid, '--facts', facts]);
    assert.equal(printed.code, 0);
    assert.equal(printed.stdout, unflip.buildUnflipSql(gid));
    const out = path.join(dir, 'unflip.sql');
    const written = run(['--guild', gid, '--facts', facts, '--out', out]);
    assert.equal(written.code, 0);
    assert.equal(fs.readFileSync(out, 'utf8'), unflip.buildUnflipSql(gid));
    assert.match(written.stdout, /--remote --file/);
    assert.match(run(['--guild', gid]).stderr, /not checked/);
    assert.equal(run(['--guild', gid, '--print-facts-query']).stdout.trim(), unflip.factsSql(gid));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => unflip.buildUnflipSql("g_x'; DROP TABLE guilds; --"), /not a guild id/);
});

// ---------------------------------------------------------------------------
// The SQL

check('the unflip restores the legacy rule: rank source NULL, the stored Guild Master row back for the seat, the seat cleared, one audit row; ranks, keys, dates, hand-set roles and the pin stay', async () => {
  const s = await flipped();
  const afterFlip = {
    chars: await s.rows('SELECT id, namespace, blizzard_char_id, core_rank, trial_start, trial_end FROM characters WHERE guild_id = ? ORDER BY id', s.gid),
    pin: await s.one('SELECT pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id, last_good_sync_id FROM guilds WHERE id = ?', s.gid),
    roles: await s.rows("SELECT user_id, role_id, team_id, source FROM role_assignments WHERE guild_id = ? AND role_id <> 'guild_master' ORDER BY user_id, role_id", s.gid),
    persons: await s.rows('SELECT id, user_id FROM players WHERE guild_id = ? ORDER BY id', s.gid),
  };
  const facts = unflip.parseFacts(JSON.stringify(await s.rows(unflip.factsSql(s.gid))));
  assert.equal(unflip.refusalFor(facts, s.gid), null);
  runUnflip(s);
  assert.deepEqual(await s.one('SELECT rank_source, owner_user_id FROM guilds WHERE id = ?', s.gid), { rank_source: null, owner_user_id: null });
  const master = await s.rows("SELECT user_id, role_id, team_id, source, assigned_by FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.gid);
  assert.deepEqual(master, [{ user_id: s.uids.gm, role_id: 'guild_master', team_id: null, source: 'manual', assigned_by: null }]);
  assert.match((await s.one("SELECT id FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.gid)).id, /^ra_[0-9a-f]{22}$/);
  const audit = await s.rows("SELECT actor_user_id, before, after FROM audit_log WHERE guild_id = ? AND action = 'guild.source_switch'", s.gid);
  assert.equal(audit.length, 2, "the flip's row and the unflip's");
  const row = audit.find((entry) => JSON.parse(entry.after).unflip);
  assert.deepEqual(JSON.parse(row.before), { rankSource: 'ingame' });
  assert.deepEqual(JSON.parse(row.after), { rankSource: null, unpinned: false, unflip: true });
  assert.equal(row.actor_user_id, null);
  assert.deepEqual(await s.rows('SELECT id, namespace, blizzard_char_id, core_rank, trial_start, trial_end FROM characters WHERE guild_id = ? ORDER BY id', s.gid), afterFlip.chars);
  assert.deepEqual(await s.one('SELECT pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id, last_good_sync_id FROM guilds WHERE id = ?', s.gid), afterFlip.pin);
  assert.deepEqual(await s.rows("SELECT user_id, role_id, team_id, source FROM role_assignments WHERE guild_id = ? AND role_id <> 'guild_master' ORDER BY user_id, role_id", s.gid), afterFlip.roles);
  assert.deepEqual(await s.rows('SELECT id, user_id FROM players WHERE guild_id = ? ORDER BY id', s.gid), afterFlip.persons);
  // The Owner is the Owner again by the legacy rule, and a second flip is possible without a new pin.
  const dry = await dryRun(s);
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.owner.source, 'stored_guild_master');
});

check('every statement is guarded: a second run changes nothing, and neither does a run against a guild that is not flipped or has no seat', async () => {
  const s = await flipped();
  runUnflip(s);
  const once = dump(s);
  runUnflip(s);
  assert.deepEqual(dump(s), once, 'a second run');
  // Never flipped.
  const legacy = await flipWorld();
  const before = dump(legacy);
  runUnflip(legacy);
  assert.deepEqual(dump(legacy), before, 'a guild that was never flipped');
  // In-game with no seat: nothing happens (and the tool refuses it up front).
  const seatless = await flipped();
  seatless.exec(`UPDATE guilds SET owner_user_id = NULL WHERE id = '${seatless.gid}'`);
  const seatlessBefore = dump(seatless);
  runUnflip(seatless);
  assert.deepEqual(dump(seatless), seatlessBefore, 'a flipped guild without a seat');
  // A half run (the row was written, the guild not yet cleared) is finished by the next run.
  const half = await flipped();
  half.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at, source) VALUES ('ra_half', '${half.gid}', '${half.uids.gm}', 'guild_master', NULL, NULL, 1, 'manual')`);
  runUnflip(half);
  assert.deepEqual(await half.one('SELECT rank_source, owner_user_id FROM guilds WHERE id = ?', half.gid), { rank_source: null, owner_user_id: null });
  assert.equal(await half.w.count('role_assignments', "guild_id = ? AND role_id = 'guild_master'", half.gid), 1);
});

// ---------------------------------------------------------------------------
// After the flip, before the unflip

check('a person the in-game sign-in match made after the flip stays linked after the unflip and is a member under the legacy rule (it is on the in-game roster)', async () => {
  const s = await flipped();
  // A Battle.net-only account whose character is on the stored roster: the match makes its person.
  const account = { id: '780000001', battletag: 'Newcomer#7801' };
  rosterRow(s, { name: 'Newcomer', id: 9900, rank: 4 });
  s.bnet.state.override.profile = ({ account: who }) => profileOf(who.id === account.id ? [entry('Newcomer', 9900)] : []);
  await s.bnetSignUp('newcomer', account);
  const person = await s.one('SELECT id, user_id, user_id_backfilled FROM players WHERE guild_id = ? AND user_id = ?', s.gid, s.uids.newcomer);
  assert(person, 'the sign-in match made a person for the account');
  assert.equal(person.user_id_backfilled, 0);
  const inGame = await s.call('newcomer', 'GET', '/auth/me');
  assert(inGame.json.guilds.some((guild) => guild.id === s.gid), 'a member under the in-game rule');

  runUnflip(s);

  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', person.id)).user_id, s.uids.newcomer, 'still linked');
  assert((await s.rows('SELECT id FROM characters WHERE player_id = ?', person.id)).length >= 1, 'with its character');
  const legacy = await s.call('newcomer', 'GET', '/auth/me');
  assert(legacy.json.guilds.some((guild) => guild.id === s.gid), 'a member under the legacy rule too');
  const view = await s.call('newcomer', 'GET', '');
  assert.equal(view.status, 200, view.text);
});

// ---------------------------------------------------------------------------
// B9 acceptance

// What the pre-R4 paths answer to every kind of account: the login (GET /auth/me), the guild view with the viewer's permissions (GET /api/guild/:gid), the claim list.
// Two things are not compared, because the unflip leaves them as they are BY DESIGN (plan: "scope = membership and permissions only"): the number of players on a team page, which
// follows core_rank (the flip's applyRankMap made some characters Social, and ranks stay), and the `fromDiscord` flag of a role (the roles the flip made hand-set stay hand-set;
// the Discord role sync gives its own rows again at its next run). Both are asserted separately below.
const withoutFlag = (value) => JSON.parse(JSON.stringify(value, (key, entry) => (key === 'fromDiscord' ? undefined : entry)));
async function snapshot(s) {
  const out = {};
  const players = {};
  for (const key of ['gm', 'off', 'mem', 'dis', 'out']) {
    const me = await s.call(key, 'GET', '/auth/me');
    const guild = await s.call(key, 'GET', '');
    const claims = await s.call(key, 'GET', '/claims');
    if (guild.json && guild.json.teams) {
      players[key] = guild.json.teams.map((team) => team.players);
      for (const team of guild.json.teams) delete team.players;
    }
    out[key] = withoutFlag({ me: [me.status, me.json], guild: [guild.status, guild.json], claims: [claims.status, claims.json] });
  }
  return { out, players };
}

check('B9 acceptance: after flip + unflip the login, the permissions and the claim list answer to every account as they did before the flip', async () => {
  const s = await flipWorld({ memRank: 3 });
  const before = await snapshot(s);
  assert.equal(before.out.gm.guild[0], 200);
  assert(before.out.gm.guild[1].me.can, 'the Owner has permissions to compare');
  assert.equal(before.out.dis.guild[0], 200, 'the Discord-only member is a member before');
  assert.equal(before.out.out.guild[0] >= 400, true);
  const dry = (await dryRun(s)).json;
  const res = await flipWith(s, dry);
  assert.equal(res.status, 200, res.text);
  // (Under the in-game rule the Discord-only member is out: the flip really changed the answers.)
  const during = await snapshot(s);
  assert.notDeepEqual(during.out.dis, before.out.dis);
  runUnflip(s);
  const after = await snapshot(s);
  for (const key of Object.keys(before.out)) assert.deepEqual(after.out[key], before.out[key], `${key}: the answers after flip + unflip differ from the answers before`);
  // The two things the unflip leaves: the team player counts (ranks stay) and the Discord flag (hand-set roles stay hand-set).
  assert.deepEqual(after.players.gm, during.players.gm, 'ranks stay: the team page counts the same as under the in-game rule');
  assert.notDeepEqual(after.players.gm, before.players.gm);
  const flags = async () => (await s.call('mem', 'GET', '/auth/me')).json.guilds.find((guild) => guild.id === s.gid).roles.map((role) => role.fromDiscord);
  assert.deepEqual(await flags(), [undefined], 'the Discord-given Officer role of mem is a hand-set one now');
});

runChecks(checks);
