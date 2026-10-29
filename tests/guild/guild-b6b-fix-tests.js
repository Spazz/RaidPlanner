/**
 * Raidsmith guild tracker - the security-review fixes of lane B6b parts 1 + 2a (branch guild/hier-b6b-fix; tasks/open/audit-b6b-security.md F1, F2, F5-F9)
 * Run: node tests/guild/guild-b6b-fix-tests.js [name filter]
 * (and tasks/open/audit-b6b2b-b7b-security.md G1, G3 [People list], G5; G2, G3 [Users list] and G4 are in guild-b7b-users-tests.js)
 *
 *   F1  DELETE /auth/me needs a fresh grant (purpose account_delete, params {}) when the account is protected or the delete takes a guild with it; every statement of the batch carries
 *       the marker; a lost grant or an account that became staff between the read and the batch deletes nothing; the 409s come first;
 *   F2  Edit roles does not copy a role the person holds through a DERIVED row into a hand row unless the body says pin: true;
 *   F5  both link callbacks: a refresh can never insert or first-link (the link removed between the read and the batch links nothing);
 *   F6  fresh.failed / guild.claim_failed rows are written only for an account with a tie to the guild; a stranger's failure is logged only;
 *   F7  the Battle.net refresh fills a missing first_linked_at once (the old link time), so the identity ages;
 *   F8  the fresh-start budget is per SESSION (10 per 10 minutes) with a per-account ceiling (30), both fail closed; Delete my data sweeps both keys;
 *   F9  a block row on the live Owner is kept, listed (People `removed`, B7b blocked segment) with ignoredWhileOwner, and can be restored;
 *   G1  the reviewer's scenario (a cookie-only attacker steers the seat through self-suspension and Delete my data) ends in 403 fresh_required;
 *   G3  GET /people has a per-user limit of its own; G5  deleteImpact.succession names the successor only to a member.
 * Drives worker/index.js over the node:sqlite D1 stand-in, Discord faked by an injected fetch, Battle.net by tools/fake-battlenet.js on a local port.
 */
const assert = require('node:assert/strict');
const { load, runChecks } = require('../guild-b3-world');
const { claimWorld, claim, ACCOUNT, ID, entry, refused, tieToGuild } = require('../guild-claim');
const { freshScenario, sessionHashOf } = require('../guild-fresh');
const { adminOf, signIn } = require('../guild-world');
const { flip, makeProven, rolesOf } = require('../guild-ingame');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({
    name,
    fn: async () => {
      globalThis.__fixWorlds = [];
      globalThis.__claimWorlds = globalThis.__fixWorlds;
      try { await fn(); } finally { await Promise.all(globalThis.__fixWorlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 100)); }
    },
  });
}
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const BNET = { gm: { id: '750000001', battletag: 'Gm#0001' }, ivy: { id: '750000002', battletag: 'Ivy#0002' }, other: { id: '750000009', battletag: 'Other#0009' } };

async function world(options) {
  const s = await freshScenario(options);
  globalThis.__fixWorlds.push(s);
  s.audit = (action) => s.rows('SELECT actor_user_id, entity_id, actor_role, before, after FROM audit_log WHERE action = ? ORDER BY created_at, id', action);
  s.accountDelete = async (key, deleteGuildIds = []) => s.call(key, 'DELETE', '/auth/me', { deleteGuildIds });
  s.allowDelete = async (key, provider = 'discord') => {
    const flow = await s.fresh(key, { purpose: 'account_delete', provider });
    assert.equal(flow.location, '/#/fresh?done=account_delete', `${key}: ${flow.location}`);
  };
  return s;
}

// A hook on db.batch: `action` runs once, just before the first batch with a statement that matches.
function beforeBatch(s, matcher, action) {
  const real = s.w.db.batch.bind(s.w.db);
  let fired = false;
  s.w.db.batch = async (statements) => {
    if (!fired && statements.some((statement) => matcher.test(statement.sql))) { fired = true; action(); }
    return real(statements);
  };
  return () => { s.w.db.batch = real; };
}
// The statements of the first batch with a statement that matches, recorded.
function captureBatch(s, matcher) {
  const real = s.w.db.batch.bind(s.w.db);
  const captured = [];
  s.w.db.batch = async (statements) => {
    if (!captured.length && statements.some((statement) => matcher.test(statement.sql))) captured.push(...statements);
    return real(statements);
  };
  return captured;
}

// The in-game guild of the Owner suites, with a derived Officer 'dof' (rank 1) and a derived Team Lead 'dtl' (rank 2, Main on team Alpha), a derived Guild Master 'dgm' (rank 0).
async function ingameWorld() {
  const s = await world({ teams: ['Alpha', 'Bravo'] });
  s.people = {};
  s.proven = {};
  for (const [key, name, rank, proof] of [['own', 'Seatowner', 4, 'bnet'], ['dgm', 'Derivedgm', 0, 'bnet'], ['dof', 'Derivedoff', 1, 'bnet'], ['dtl', 'Derivedlead', 2, 'bnet'], ['mem', 'Plainmember', 5, 'officer']]) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
    s.proven[key] = makeProven(s, key, s.people[key], { rank, proof, link: proof === 'bnet' });
  }
  flip(s, { owner: 'own' });
  s.demote = (key, rank = 5) => s.exec(`UPDATE guild_roster SET rank = ${rank} WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${s.proven[key].id}`);
  s.suspend = () => s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.own.cid}'`);
  s.restore = () => s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.own}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${s.uids.own}') WHERE id = '${s.people.own.cid}'`);
  s.handRows = (key) => s.rows("SELECT role_id, team_id FROM role_assignments WHERE guild_id = ? AND user_id = ? AND source = 'manual' ORDER BY role_id, team_id", s.gid, s.uids[key]);
  s.setRoles = (key, body, who = 'own') => s.call(who, 'PUT', `/people/${s.uids[key]}/roles`, body);
  return s;
}

// ---------------------------------------------------------------------------
// F1. Delete my data is a fresh-auth act

check('F1: a protected account that takes a guild with it needs a grant (403 fresh_required { purpose: account_delete }); the 409s come first; the real flow then deletes', async () => {
  const s = await world();
  const gid = s.gid;
  // The checks that were there first stay first: an echo of the wrong guilds is a 409 whatever the grant.
  const wrong = await s.accountDelete('gm', []);
  assert.deepEqual([wrong.status, wrong.json.error], [409, 'confirm_mismatch'], wrong.text);
  // Without a grant: refused, nothing is deleted, nothing is audited.
  const refusedDelete = await s.accountDelete('gm', [gid]);
  assert.deepEqual([refusedDelete.status, refusedDelete.json.error, refusedDelete.json.purpose], [403, 'fresh_required', 'account_delete'], refusedDelete.text);
  assert.equal(await s.w.count('guilds'), 1);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.gm), 1);
  assert.equal((await s.audit('account.delete')).length, 0);
  // A grant for another purpose (or another act's parameters) is no grant for this one.
  await s.grant('gm', { purpose: 'guild_delete', guildId: gid, params: {} });
  assert.equal((await s.accountDelete('gm', [gid])).json.error, 'fresh_required');
  await s.grant('gm', { purpose: 'identity_change', params: { change: 'unlink_discord' } });
  assert.equal((await s.accountDelete('gm', [gid])).json.error, 'fresh_required');
  assert.equal(await s.w.count('guilds'), 1);
  // The start step: account scope, no params.
  const guildRoute = await s.call('gm', 'POST', `/api/guild/${gid}/fresh/start`, { purpose: 'account_delete', provider: 'discord' });
  assert.deepEqual([guildRoute.status, guildRoute.json.field], [400, 'purpose'], 'it belongs to the account, not to a guild');
  const withParams = await s.call('gm', 'POST', '/api/fresh/start', { purpose: 'account_delete', params: { x: 1 }, provider: 'discord' });
  assert.deepEqual([withParams.status, withParams.json.field], [400, 'params']);
  // The real flow: start, Discord, callback, then the act.
  await s.allowDelete('gm');
  const done = await s.accountDelete('gm', [gid]);
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.w.count('guilds'), 0, 'the guild went with its only member account');
  assert.equal(await s.w.count('users', 'id = ?', s.uids.gm), 0);
  assert.equal(await s.w.count('fresh_act_markers', "purpose = 'account_delete'"), 1, 'the marker of the act');
  assert.equal((await s.audit('account.delete')).length, 1);
  assert.equal((await s.audit('guild.delete')).length, 1);
});

check('F1: a protected account without a guild to delete (Officer, Team Lead) needs the grant too; an account with no role deletes with none', async () => {
  const s = await world();
  await s.officer('off', 'Officerone');
  await s.lead('tl', [s.tids[0]], 'Teamlead');
  await s.member('mem', 'Plainmember');
  for (const key of ['off', 'tl']) {
    const refusedDelete = await s.accountDelete(key);
    assert.deepEqual([refusedDelete.status, refusedDelete.json.error, refusedDelete.json.purpose], [403, 'fresh_required', 'account_delete'], `${key}: ${refusedDelete.text}`);
    assert.equal(await s.w.count('users', 'id = ?', s.uids[key]), 1, `${key} is still there`);
    assert((await s.w.count('role_assignments', 'user_id = ?', s.uids[key])) > 0, `${key} still has the role`);
    await s.allowDelete(key);
    const done = await s.accountDelete(key);
    assert.equal(done.status, 200, `${key}: ${done.text}`);
    assert.equal(await s.w.count('users', 'id = ?', s.uids[key]), 0);
    assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.uids[key]), 0);
  }
  // Nobody to be protected: no grant, still deleted (unchanged by the fix).
  const plain = await s.accountDelete('mem');
  assert.equal(plain.status, 200, plain.text);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.mem), 0);
  assert.equal(await s.w.count('guilds'), 1, 'the guild stays: it still has a member');
});

check('F1: a legacy Guild Master with others still hands over first (409), a suspended Owner needs the grant for the succession, a Guild Master who left the server needs it for the auto-promotion', async () => {
  const s = await world();
  await s.officer('off', 'Officerone');
  // A live legacy Guild Master with others: 409 before any grant is asked for.
  const handOver = await s.accountDelete('gm');
  assert.deepEqual([handOver.status, handOver.json.error], [409, 'hand_over_guild_master'], handOver.text);
  // The Guild Master leaves the Discord server: not a member, others exist: the earliest Officer takes the guild (autoPromote), and the account is still protected.
  s.exec(`DELETE FROM user_servers WHERE user_id = '${s.uids.gm}'`);
  const impact = (await s.ok('gm', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual(impact.autoPromote.map((entryOf) => [entryOf.id, entryOf.to && entryOf.to.id]), [[s.gid, s.uids.off]]);
  const refusedDelete = await s.accountDelete('gm');
  assert.deepEqual([refusedDelete.status, refusedDelete.json.error], [403, 'fresh_required'], refusedDelete.text);
  assert.equal(await s.w.count('role_assignments', "role_id = 'guild_master' AND user_id = ?", s.uids.gm), 1, 'nothing moved');
  const captured = captureBatch(s, /DELETE FROM users WHERE id/);
  await s.allowDelete('gm');
  const done = await s.accountDelete('gm');
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.w.count('role_assignments', "role_id = 'guild_master' AND user_id = ?", s.uids.off), 1, 'the Officer is the Guild Master now');
  assert.equal((await s.audit('guild_master.auto_promote')).length, 1);
  // EVERY statement of the batch is under the marker: the pair that opens the act, then nothing without `fresh_act_markers`.
  assert(captured.length > 12, `the delete's batch was captured (${captured.length})`);
  assert.match(captured[0].sql, /^\s*UPDATE sessions SET fresh_purpose = NULL/);
  assert.match(captured[1].sql, /^\s*INSERT INTO fresh_act_markers/);
  const unguarded = captured.slice(2).filter((statement) => !/fresh_act_markers/.test(statement.sql)).map((statement) => statement.sql.replace(/\s+/g, ' ').slice(0, 90));
  assert.deepEqual(unguarded, [], 'every statement of the delete carries the marker');
});

check('F1: a suspended Owner\'s delete (the succession statements) and a guild delete carry the marker on every statement, and the seat still passes on', async () => {
  const s = await claimWorld({ ownerLive: false });
  const captured = captureBatch(s, /DELETE FROM users WHERE id/);
  const refusedDelete = await s.call('gm', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.deepEqual([refusedDelete.status, refusedDelete.json.error], [403, 'fresh_required'], refusedDelete.text);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.gm), 1);
  await s.grant('gm', { purpose: 'account_delete' });
  const done = await s.call('gm', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(done.status, 200, done.text);
  assert(captured.some((statement) => /UPDATE guilds SET owner_user_id/.test(statement.sql)), 'the succession is in the batch');
  assert(captured.some((statement) => /guild\.succession/.test(statement.sql)), 'and its audit row');
  const unguarded = captured.slice(2).filter((statement) => !/fresh_act_markers/.test(statement.sql)).map((statement) => statement.sql.replace(/\s+/g, ' ').slice(0, 90));
  assert.deepEqual(unguarded, [], 'every statement, the succession pair included, carries the marker');
  assert.equal((await s.rows('SELECT action FROM audit_log WHERE action = ?', 'guild.succession')).length, 1);
});

check('F1: a grant spent by a parallel request, or an account that became staff between the read and the batch, deletes NOTHING', async () => {
  // The grant is gone when the batch runs: the consuming UPDATE changes no row, no marker is written, no statement applies.
  const s = await world();
  await s.officer('off', 'Officerone');
  await s.allowDelete('off');
  const restore = beforeBatch(s, /DELETE FROM users WHERE id/, () => s.exec(`UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL WHERE user_id = '${s.uids.off}'`));
  const raced = await s.accountDelete('off');
  restore();
  assert.deepEqual([raced.status, raced.json.error, raced.json.purpose], [403, 'fresh_required', 'account_delete'], raced.text);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.off), 1);
  assert.equal(await s.w.count('role_assignments', 'user_id = ?', s.uids.off), 1);
  assert.equal((await s.audit('account.delete')).length, 0, 'not even the audit row');
  assert.equal(await s.w.count('fresh_act_markers', "purpose = 'account_delete'"), 0);

  // A plain member made an Officer between the read ("no grant needed") and the batch: the marker's NOT protected fails, nothing applies.
  await s.member('mem', 'Plainmember');
  s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, position, guild_id, note, updated_by) SELECT 'r_none', 'raidsmith', 1, 'x', 'signed', 1, '${s.gid}', 'a note', '${s.uids.mem}' WHERE 0`);
  const undo = beforeBatch(s, /DELETE FROM users WHERE id/, () => s.exec(
    `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_by, assigned_at) VALUES ('ra_race', '${s.gid}', '${s.uids.mem}', 'officer', NULL, 'manual', '${s.uids.gm}', 1)`,
  ));
  const becameStaff = await s.accountDelete('mem');
  undo();
  assert.deepEqual([becameStaff.status, becameStaff.json.error, becameStaff.json.purpose], [403, 'fresh_required', 'account_delete'], becameStaff.text);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.mem), 1);
  assert.equal((await s.audit('account.delete')).length, 0);
  // The next try asks for the grant, as it should.
  await s.allowDelete('mem');
  assert.equal((await s.accountDelete('mem')).status, 200);
});

check('F1: the D1 statement budget of the delete (45 per invocation, every batch member counted)', async () => {
  const s = await world();
  await s.officer('off', 'Officerone');
  s.exec(`DELETE FROM user_servers WHERE user_id = '${s.uids.gm}'`);
  await s.allowDelete('gm');
  let mark = s.w.db.statementLog.length;
  assert.equal((await s.accountDelete('gm')).status, 200);
  const autoPromote = s.w.db.statementLog.length - mark;
  const solo = await world();
  await solo.allowDelete('gm');
  mark = solo.w.db.statementLog.length;
  assert.equal((await solo.accountDelete('gm', [solo.gid])).status, 200);
  const guildDelete = solo.w.db.statementLog.length - mark;
  const suspended = await claimWorld({ ownerLive: false });
  await suspended.grant('gm', { purpose: 'account_delete' });
  mark = suspended.w.db.statementLog.length;
  assert.equal((await suspended.call('gm', 'DELETE', '/auth/me', { deleteGuildIds: [] })).status, 200);
  const succession = suspended.w.db.statementLog.length - mark;
  console.log(`      statements: auto-promotion ${autoPromote}, guild delete ${guildDelete}, succession ${succession}`);
  for (const [label, count] of [['auto-promotion', autoPromote], ['guild delete', guildDelete], ['succession', succession]]) assert(count <= 45, `${label}: ${count} statements`);
});

// ---------------------------------------------------------------------------
// F2. Edit roles never copies a derived role into a hand row

check('F2: the unchanged Edit roles payload of a DERIVED Officer writes no hand row; after the in-game demotion the person is no Officer', async () => {
  const s = await ingameWorld();
  assert.deepEqual(rolesOf(s, 'dof'), [['officer', null, 'ingame']]);
  const auditBefore = (await s.audit('roles.set')).length;
  // The dialog ticks every role that is not from Discord, so it sends officer: true for a derived Officer.
  const saved = await s.setRoles('dof', { officer: true, teamLeadTeamIds: [] });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(await s.handRows('dof'), [], 'no hand row');
  assert.deepEqual(rolesOf(s, 'dof'), [['officer', null, 'ingame']]);
  assert.equal((await s.audit('roles.set')).length, auditBefore, 'nothing changed, nothing audited');
  s.demote('dof');
  assert.deepEqual(rolesOf(s, 'dof'), [], 'demoted in game: no Officer, nobody chose a permanent one');
});

check('F2: pin: true writes the hand row on purpose and it survives the demotion; pin must be a boolean; removing a hand role is unchanged', async () => {
  const s = await ingameWorld();
  const bad = await s.setRoles('dof', { officer: true, teamLeadTeamIds: [], pin: 'yes' });
  assert.deepEqual([bad.status, bad.json.field], [400, 'pin']);
  const pinned = await s.setRoles('dof', { officer: true, teamLeadTeamIds: [], pin: true });
  assert.equal(pinned.status, 200, pinned.text);
  assert.deepEqual(await s.handRows('dof'), [{ role_id: 'officer', team_id: null }]);
  const audit = (await s.audit('roles.set')).map((row) => JSON.parse(row.after));
  assert.deepEqual(audit.at(-1), { officer: true, teamLeadTeamIds: [] }, 'the audit row records the hand roles');
  s.demote('dof');
  assert.deepEqual(rolesOf(s, 'dof'), [['officer', null, 'manual']], 'the pinned role outlives the in-game demotion (U R5-Q1)');
  // Un-ticking removes the hand row only (unchanged).
  const removed = await s.setRoles('dof', { officer: false, teamLeadTeamIds: [] });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(await s.handRows('dof'), []);
});

check('F2: a derived Team Lead gets no hand row for the team the rank gives, and adding ANOTHER team writes only that one; pin writes the first as well', async () => {
  const s = await ingameWorld();
  const alpha = s.tids[0];
  const bravo = s.tids[1];
  assert.deepEqual(rolesOf(s, 'dtl'), [['team_lead', alpha, 'ingame']]);
  assert.equal((await s.setRoles('dtl', { officer: false, teamLeadTeamIds: [alpha] })).status, 200);
  assert.deepEqual(await s.handRows('dtl'), [], 'the derived Team Lead of Alpha is not copied');
  // The dialog of a derived Officer, adding a Team Lead tick: the Officer stays derived, only the new tick is a hand role.
  const both = await s.setRoles('dof', { officer: true, teamLeadTeamIds: [bravo] });
  assert.equal(both.status, 200, both.text);
  assert.deepEqual(await s.handRows('dof'), [{ role_id: 'team_lead', team_id: bravo }]);
  assert.deepEqual((await s.audit('roles.set')).map((row) => JSON.parse(row.after)).at(-1), { officer: false, teamLeadTeamIds: [bravo] });
  s.demote('dtl');
  assert.deepEqual(rolesOf(s, 'dtl'), [], 'demoted in game: gone');
  // pin: Alpha as a hand role too.
  const s2 = await ingameWorld();
  assert.equal((await s2.setRoles('dtl', { officer: false, teamLeadTeamIds: [alpha === s2.tids[0] ? s2.tids[0] : alpha], pin: true })).status, 200);
  assert.deepEqual(await s2.handRows('dtl'), [{ role_id: 'team_lead', team_id: s2.tids[0] }]);
  s2.demote('dtl');
  assert.deepEqual(rolesOf(s2, 'dtl'), [['team_lead', s2.tids[0], 'manual']]);
});

// ---------------------------------------------------------------------------
// F5 and F7. The link callbacks

check('F5: a Discord refresh whose link was removed between the read and the batch links NOTHING (no grant-less first link, no audit row), and says so', async () => {
  const s = await world();
  const before = await s.one('SELECT discord_id, discord_linked_at FROM users WHERE id = ?', s.uids.gm);
  assert(before.discord_id && before.discord_linked_at, 'the Owner has Discord linked');
  // Control: a refresh with the link in place works as before.
  assert.equal(await s.linkDiscord('gm'), '/#/linked');
  assert.equal((await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.gm)).discord_id, before.discord_id);
  // The link goes (the real owner's own unlink in a second tab) just before the callback's batch.
  const restore = beforeBatch(s, /UPDATE users SET discord_id = \?/, () => s.exec(`UPDATE users SET discord_id = NULL, discord_linked_at = NULL WHERE id = '${s.uids.gm}'`));
  const location = await s.linkDiscord('gm');
  restore();
  assert.equal(location, '/#/linked?error=state', 'a lost race: connect again');
  assert.deepEqual(await s.one('SELECT discord_id, discord_linked_at FROM users WHERE id = ?', s.uids.gm), { discord_id: null, discord_linked_at: null }, 'nothing was linked');
  assert.equal((await s.audit('identity.change')).length, 0);
  assert.equal(await s.w.count('audit_log', "action = 'discord.link'"), 0);
});

check('F5: a Battle.net refresh whose link was removed (or swapped for another account) between the read and the batch inserts NOTHING', async () => {
  const s = await world();
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.gm}', '${BNET.gm.id}', 'Gm#1', 1, '{}', 1, 1)`);
  // Control: the refresh with the link in place.
  assert.equal(await s.linkBnet('gm', BNET.gm), '/#/characters');
  const refreshed = await s.one('SELECT bnet_account_id, linked_at, first_linked_at FROM bnet_links WHERE user_id = ?', s.uids.gm);
  assert.deepEqual([refreshed.bnet_account_id, refreshed.first_linked_at], [BNET.gm.id, 1], 'refreshed: linked_at moves, first_linked_at does not');
  assert(refreshed.linked_at > 1);
  // The link is removed just before the batch.
  const linkAudits = await s.w.count('audit_log', "action IN ('bnet.link', 'identity.change')");
  let restore = beforeBatch(s, /(INSERT INTO|UPDATE) bnet_links/, () => s.exec(`DELETE FROM bnet_links WHERE user_id = '${s.uids.gm}'`));
  assert.equal(await s.linkBnet('gm', BNET.gm), '/#/linked?error=state');
  restore();
  assert.equal(await s.w.count('bnet_links', 'user_id = ?', s.uids.gm), 0, 'no row was made: not a first link without a grant');
  assert.equal(await s.w.count('audit_log', "action IN ('bnet.link', 'identity.change')"), linkAudits, 'no audit row of a link that did not happen');
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  // Another Battle.net account linked in between: the old answer, has_bnet; the row is the other account's, untouched.
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.gm}', '${BNET.gm.id}', 'Gm#1', 1, '{}', 1, 1)`);
  restore = beforeBatch(s, /(INSERT INTO|UPDATE) bnet_links/, () => s.exec(`UPDATE bnet_links SET bnet_account_id = '${BNET.other.id}', battletag = 'Other#9' WHERE user_id = '${s.uids.gm}'`));
  assert.equal(await s.linkBnet('gm', BNET.gm), '/#/linked?error=has_bnet');
  restore();
  assert.deepEqual(await s.one('SELECT bnet_account_id, battletag, first_linked_at FROM bnet_links WHERE user_id = ?', s.uids.gm), { bnet_account_id: BNET.other.id, battletag: 'Other#9', first_linked_at: 1 });
});

check('F7: a Battle.net link with no first_linked_at gets its OLD link time on the next refresh and then ages (the fallback stays correct even though no rule reads it now); a set value never moves', async () => {
  const s = await world();
  await s.bnetSignUp('ivy', BNET.ivy);
  s.w.advance(12 * DAY);
  const tenDaysAgo = s.w.clock.now - 10 * DAY;
  // A link written by older code: linked 10 days ago, no first-link time, and refreshed every few days since (each refresh moves linked_at).
  s.exec(`UPDATE bnet_links SET first_linked_at = NULL, linked_at = ${tenDaysAgo} WHERE user_id = '${s.uids.ivy}'`);
  const identityChange = (account) => s.fresh('ivy', { purpose: 'identity_change', params: { change: 'unlink_bnet' }, provider: 'bnet', account });
  assert.equal((await identityChange(BNET.ivy)).location, '/#/fresh?done=identity_change', 'a link 10 days old passes before any refresh (the fallback is the link time)');
  s.exec(`UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL WHERE user_id = '${s.uids.ivy}'`);
  assert.equal(await s.linkBnet('ivy', BNET.ivy), '/#/characters', 'refreshed today');
  const row = await s.one('SELECT linked_at, first_linked_at FROM bnet_links WHERE user_id = ?', s.uids.ivy);
  assert.equal(row.first_linked_at, tenDaysAgo, 'filled in with the link time as it stood BEFORE the refresh');
  assert(row.linked_at > tenDaysAgo);
  assert.equal((await identityChange(BNET.ivy)).location, '/#/fresh?done=identity_change', 'still passes after the refresh');
  // Refreshing again moves linked_at only.
  s.exec(`UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL WHERE user_id = '${s.uids.ivy}'`);
  assert.equal(await s.linkBnet('ivy', BNET.ivy), '/#/characters');
  assert.equal((await s.one('SELECT first_linked_at FROM bnet_links WHERE user_id = ?', s.uids.ivy)).first_linked_at, tenDaysAgo, 'a value that is set never moves');
});

check('CI grep: the Battle.net refresh is an UPDATE of the account\'s own row (never an UPSERT), it only fills first_linked_at in, and nothing else writes it', () => {
  const { sqlLiterals, workerFiles } = require('../worker-sql');
  const updates = [];
  const inserts = [];
  for (const file of workerFiles()) {
    for (const { sql } of sqlLiterals(file)) {
      if (/\bUPDATE\s+bnet_links\b/.test(sql)) updates.push([file, sql.replace(/\s+/g, ' ')]);
      if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+bnet_links\b/.test(sql)) inserts.push([file, sql.replace(/\s+/g, ' ')]);
    }
  }
  const refresh = updates.filter(([, sql]) => /\blinked_at\s*=/.test(sql));
  assert.equal(refresh.length, 1, 'one refresh statement');
  assert.equal(refresh[0][0], 'worker/routes/bnet.js');
  assert(/first_linked_at = COALESCE\(first_linked_at, linked_at\)/.test(refresh[0][1]), 'the old link time, before the overwrite');
  assert(/WHERE user_id = \? AND bnet_account_id = \?/.test(refresh[0][1]), 'the row of THIS Battle.net account: it can never insert');
  for (const [file, sql] of updates.filter((entryOf) => !refresh.includes(entryOf))) assert(!/first_linked_at\s*=/.test(sql), `${file}: only the refresh writes first_linked_at`);
  assert.equal(inserts.length, 2, 'sign-up and first link are the only inserts');
  for (const [, sql] of inserts) {
    const branch = /DO UPDATE SET(.*)$/.exec(sql);
    if (branch && /first_linked_at\s*=/.test(branch[1])) assert(/first_linked_at = COALESCE\(bnet_links\.first_linked_at, bnet_links\.linked_at\)/.test(branch[1]), 'a conflict only fills it in');
  }
});

// ---------------------------------------------------------------------------
// F6. Failure rows only for an account with a tie to the guild

check('F6: the tie of an account to a guild: member, seat holder, a person linked to it, a character it proved; a stranger has none', async () => {
  const s = await world();
  const { hasGuildTie } = await load('worker/membership.js');
  await s.member('mem', 'Plainmember');
  await s.outsider('out', 'Outsider');
  await s.outsider('seat', 'Seatonly');
  await s.outsider('lnk', 'Linked');
  await s.outsider('prf', 'Proofonly');
  await s.outsider('blk', 'Blockedstranger');
  const made = await s.person({ name: 'Linkedmain' });
  await s.link(made.pid, 'lnk');
  const other = await s.person({ name: 'Proofchar' });
  s.exec(`UPDATE characters SET proof_user_id = '${s.uids.prf}' WHERE id = '${other.cid}'`);
  s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.seat}' WHERE id = '${s.gid}'`); // (the stored Guild Master row counts for nothing once a seat is set)
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.blk}', '${s.uids.gm}', 1)`);
  const tie = (key, guildId = s.gid) => hasGuildTie(s.w.db, s.uids[key], guildId);
  assert.deepEqual(
    [await tie('gm'), await tie('mem'), await tie('seat'), await tie('lnk'), await tie('prf'), await tie('out'), await tie('blk')],
    [true, true, true, true, true, false, false],
    'member, member (Discord server), seat holder, linked person, proved character; not the stranger, not a blocked stranger',
  );
  assert.equal(await tie('gm', 'g_Nonexistent0000000000'), false, 'no such guild');
});

check('F6: an outsider\'s mismatch on gm_claim writes no audit row and no counter in the victim guild; an account with a tie still counts', async () => {
  const s = await claimWorld();
  await s.bnetSignUp('oth', ACCOUNT.oth);
  // 'oth' starts the claim for a guild it has nothing to do with and comes back from Blizzard as another account.
  const logsBefore = s.w.logs.length;
  const stranger = await claim(s, 'oth', { account: ACCOUNT.igm });
  assert.equal(stranger.location, refused('mismatch'));
  assert.equal(await s.w.count('audit_log', "action = 'fresh.failed'"), 0, 'no row in the victim guild\'s log');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'auditfail:%'"), 0, 'and no counter that the daily job would turn into one');
  assert(s.w.logs.slice(logsBefore).some((line) => /fresh-auth refused: gm_claim mismatch/.test(line)), 'logged only');
  // The same account with a tie to the guild (a person linked to it): counted.
  tieToGuild(s, 'oth');
  const tied = await claim(s, 'oth', { account: ACCOUNT.igm });
  assert.equal(tied.location, refused('mismatch'));
  const rows = await s.rows("SELECT guild_id, actor_user_id, after FROM audit_log WHERE action = 'fresh.failed'");
  assert.deepEqual(rows.map((row) => [row.guild_id, row.actor_user_id]), [[s.gid, s.uids.oth]]);
  assert.equal(JSON.parse(rows[0].after).detail, 'gm_claim:mismatch');
});

check('F6: guild.claim_failed counts only for an account with a tie to the guild: a stranger\'s not_gm writes nothing, the seat holder\'s still counts', async () => {
  const s = await claimWorld();
  await s.bnetSignUp('oth', ACCOUNT.oth);
  s.live.profiles[ACCOUNT.oth.id] = [entry('Memberone', ID.mem)];
  const stranger = await claim(s, 'oth');
  assert.equal(stranger.location, refused('not_gm'));
  assert.equal(await s.w.count('audit_log', "action = 'guild.claim_failed'"), 0, 'a stranger fills nobody\'s log');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'auditfail:%'"), 0);
  // The suspended seat holder (no person linked to them any more, only the seat) is refused as not the Guild Master: counted, because the seat is a tie.
  s.suspendOwner();
  s.exec(`DELETE FROM players WHERE id = '${s.people.gm.pid}'`);
  s.live.profiles[ACCOUNT.igm.id] = [entry('Gmlive', ID.gm)];
  // (The live roster is fine and its rank 0 is the OTHER account's character: not_gm. A roster with no rank 0 is a Battle.net problem now and is not counted at all.)
  const seatHolder = await claim(s, 'gm', { account: { id: s.one ? (await s.one('SELECT bnet_account_id FROM bnet_links WHERE user_id = ?', s.uids.gm)).bnet_account_id : '0', battletag: 'Tagown#1234' } });
  assert.equal(seatHolder.location, refused('not_gm'), seatHolder.location);
  const rows = await s.rows("SELECT actor_user_id FROM audit_log WHERE action = 'guild.claim_failed'");
  assert.deepEqual(rows.map((row) => row.actor_user_id), [s.uids.gm]);
});

// ---------------------------------------------------------------------------
// F8. The fresh-start budget is per session

check('F8: one session at its limit does not stop another session of the same account; the account ceiling holds; a session over its budget is not counted against the account', async () => {
  const s = await world();
  const start = (jar) => s.w.call(jar, 'POST', `/api/guild/${s.gid}/fresh/start`, { purpose: 'guild_delete', provider: 'discord' });
  const jars = [s.jars.gm];
  for (let i = 0; i < 3; i++) jars.push((await signIn(s.w, s.discordOf('gm'), [adminOf(s.serverId)])).jar);
  assert.equal(new Set(jars.map(sessionHashOf)).size, 4, 'four sessions of one account');
  // A thief with the first session's cookie uses its whole budget and keeps going.
  for (let i = 0; i < 10; i++) assert.equal((await start(jars[0])).status, 200, `start ${i + 1}`);
  for (let i = 0; i < 2; i++) {
    const limited = await start(jars[0]);
    assert.deepEqual([limited.status, limited.json.error], [429, 'rate_limited']);
    assert(limited.json.retryAfter >= 1);
  }
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `fresh:${s.uids.gm}`)).count, 10, 'the refused starts of the session did not count against the account');
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `fresh:s:${sessionHashOf(jars[0])}`)).count, 12);
  // The real Owner's own session is not touched.
  for (let i = 0; i < 10; i++) assert.equal((await start(jars[1])).status, 200, `second session, start ${i + 1}`);
  // The account's ceiling (30): a third session uses its ten, and a fourth is refused although it has not started anything.
  for (let i = 0; i < 10; i++) assert.equal((await start(jars[2])).status, 200, `third session, start ${i + 1}`);
  const fourth = await start(jars[3]);
  assert.deepEqual([fourth.status, fourth.json.error], [429, 'rate_limited'], 'the ceiling of the account');
  assert.equal(await s.w.count('rate_limits', "key LIKE 'fresh:s:%'"), 4);
  // The window rolls.
  s.w.advance(11 * MINUTE);
  assert.equal((await start(jars[3])).status, 200, 'a new window');
});

check('F8: Delete my data sweeps the session keys and the account key of the account, and only those', async () => {
  const s = await world();
  await s.bnetSignUp('ivy', BNET.ivy);
  const second = await signInAgainWithBnet(s, BNET.ivy);
  const jars = [s.jars.ivy, second];
  for (const jar of jars) assert.equal((await s.w.call(jar, 'POST', '/api/fresh/start', { purpose: 'identity_change', params: { change: 'link_discord' } })).status, 200);
  assert.equal((await s.call('gm', 'POST', `/api/guild/${s.gid}/fresh/start`, { purpose: 'guild_delete', provider: 'discord' })).status, 200);
  const keys = (await s.rows("SELECT key FROM rate_limits WHERE key LIKE 'fresh:%' ORDER BY key")).map((row) => row.key);
  assert.deepEqual(keys, [...new Set([`fresh:${s.uids.gm}`, `fresh:${s.uids.ivy}`, `fresh:s:${sessionHashOf(s.jars.gm)}`, ...jars.map((jar) => `fresh:s:${sessionHashOf(jar)}`)])].sort());
  // The windows of the read limits (Users list, People list) are keyed by the account too: they go with it, the other account's stay.
  for (const key of ['ivy', 'gm']) s.exec(`INSERT INTO rate_limits (key, window_start, count) VALUES ('users:${s.uids[key]}', 1, 1), ('people:${s.uids[key]}', 1, 1)`);
  const done = await s.w.call(s.jars.ivy, 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual((await s.rows("SELECT key FROM rate_limits WHERE key LIKE 'users:%' OR key LIKE 'people:%' ORDER BY key")).map((row) => row.key), [`people:${s.uids.gm}`, `users:${s.uids.gm}`]);
  const left = (await s.rows("SELECT key FROM rate_limits WHERE key LIKE 'fresh:%' ORDER BY key")).map((row) => row.key);
  assert.deepEqual(left, [`fresh:${s.uids.gm}`, `fresh:s:${sessionHashOf(s.jars.gm)}`].sort(), 'only the other account\'s counters are left');
});

async function signInAgainWithBnet(s, account) {
  s.bnet.state.account = account;
  s.w.advance(2000);
  const jar = {};
  const login = await s.w.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  assert.equal(callback.headers.get('Location'), '/#/');
  return jar;
}

// ---------------------------------------------------------------------------
// F9. A block row on the live Owner is listed and can be restored

check('F9: a block on the Owner while suspended stays when they are live again, is listed with ignoredWhileOwner (People and the Users blocked segment), restores, and a hand-over then leaves them a member', async () => {
  const s = await ingameWorld();
  s.suspend();
  const blocked = await s.call('dof', 'POST', `/people/${s.uids.own}/block`, {});
  assert.equal(blocked.status, 200, blocked.text);
  s.restore();
  assert.equal((await s.call('own', 'GET', '')).status, 200, 'live again: the row is ignored');
  assert.equal(await s.w.count('guild_blocks'), 1, 'but it is kept');

  // The People model: the Owner is a person AND the ignored row is listed apart.
  for (const who of ['own', 'dgm', 'dof']) {
    const people = await s.ok(who, 'GET', '/people');
    assert(people.people.some((person) => person.person.id === s.uids.own), `${who}: the Owner is listed among the people`);
    const row = people.removed.find((entryOf) => entryOf.person.id === s.uids.own);
    assert(row, `${who}: the ignored row is listed among the removed`);
    assert.equal(row.ignoredWhileOwner, true);
    assert.equal(row.removedBy.id, s.uids.dof);
    assert.equal(row.actions.restoreAccess, true, `${who} may restore it`);
    assert.equal(row.actions.keepBlock, undefined, 'there is nothing to decide: the row blocks nobody');
    assert.equal(row.pendingReview, undefined);
  }
  // The plain blocked list is unchanged for everyone else.
  assert(!(await s.ok('own', 'GET', '/people')).removed.some((entryOf) => entryOf.person.id === s.uids.mem));
  // Keep is for a block that blocks: the Owner's ignored row answers 404 (B7b).
  assert.equal((await s.call('dgm', 'POST', `/people/${s.uids.own}/block/keep`, {})).status, 404);

  // The Users list (B7b): the blocked segment lists the Owner with the same flag; they are still a member there.
  const list = await s.ok('dgm', 'GET', '/users?segment=blocked');
  assert.deepEqual(list.rows.map((row) => [row.key, row.flags]), [[s.uids.own, { owner: true, ignoredWhileOwner: true }]]);
  assert.equal(list.counts.blocked, 1);
  const members = await s.ok('dgm', 'GET', '/users?segment=members&limit=100');
  const asMember = members.rows.find((row) => row.key === s.uids.own);
  assert.deepEqual(asMember && asMember.flags, { owner: true, ignoredWhileOwner: true });
  assert.equal(members.counts.blocked, 1);
  const page = await s.ok('dgm', 'GET', `/users/${s.uids.own}`);
  assert.deepEqual([page.segment, page.flags.ignoredWhileOwner, page.block.blocked], ['members', true, false]);

  // Restore works on such a row: the Owner restores themselves (there is no rank to outrank).
  const restored = await s.call('own', 'DELETE', `/people/${s.uids.own}/block`, {});
  assert.equal(restored.status, 200, restored.text);
  assert.equal(await s.w.count('guild_blocks'), 0);
  assert.equal(restored.json.removed.length, 0);
  assert.equal((await s.audit('access.restore')).length, 1);
  assert.equal((await s.ok('dgm', 'GET', '/users?segment=blocked')).counts.blocked, 0);
  assert.equal((await s.ok('dgm', 'GET', `/users/${s.uids.own}`)).flags.ignoredWhileOwner, undefined);

  // The hand-over afterwards leaves the previous Owner a member of the guild (before, the row re-armed and removed them).
  await s.grant('own', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.dgm } });
  const handed = await s.call('own', 'POST', `/people/${s.uids.dgm}/guild-master`, {});
  assert.equal(handed.status, 200, handed.text);
  assert.deepEqual(handed.json, { handedOver: true }, 'a plain Raider now: no People list goes back to them (audit L2)');
  assert.equal((await s.call('own', 'GET', '')).status, 200, 'the previous Owner is still a member');
});

check('F9: an ignored row is restorable by an Officer too, not by a plain member; a real block still needs seniority; a suspended Owner\'s block is a real block again', async () => {
  const s = await ingameWorld();
  s.suspend();
  assert.equal((await s.call('dof', 'POST', `/people/${s.uids.own}/block`, {})).status, 200);
  s.restore();
  const plain = await s.call('mem', 'DELETE', `/people/${s.uids.own}/block`, {});
  assert.equal(plain.status, 403, 'guild.access is needed');
  assert.equal(await s.w.count('guild_blocks'), 1);
  // The ignored row of a live Owner is restorable by an Officer (guild.access); the same Officer cannot restore a SENIOR person's real block (unchanged).
  s.suspend();
  const asOfficer = await s.ok('dof', 'GET', '/people');
  const row = asOfficer.removed.find((entryOf) => entryOf.person.id === s.uids.own);
  assert.equal(row.ignoredWhileOwner, undefined, 'suspended again: it is a real block, not an ignored one');
  s.restore();
  const restored = await s.call('dof', 'DELETE', `/people/${s.uids.own}/block`, {});
  assert.equal(restored.status, 200, restored.text);
  assert.equal(await s.w.count('guild_blocks'), 0);
  // The Owner turning suspended between the read and the batch: the guard is the Owner test, so a restore that raced it does not lift a real block.
  s.suspend();
  assert.equal((await s.call('dof', 'POST', `/people/${s.uids.own}/block`, {})).status, 200);
  s.restore();
  const undo = beforeBatch(s, /DELETE FROM guild_blocks WHERE guild_id/, () => s.suspend());
  const raced = await s.call('dof', 'DELETE', `/people/${s.uids.own}/block`, {});
  undo();
  assert.equal(raced.status, 409, raced.text);
  assert.equal(await s.w.count('guild_blocks'), 1, 'the real block stays');
});

// ---------------------------------------------------------------------------
// G1 (tasks/open/audit-b6b2b-b7b-security.md): the succession is no way round the hand-over's fresh sign-in

// An extra member of the in-game guild: a person linked to the account with a character proved by Battle.net on the stored roster (live), at in-game rank 5 (no role of its own).
async function addLiveMember(s, key, name) {
  await s.member(key, name);
  s.people[key] = await s.person({ name }, 'own');
  await s.link(s.people[key].pid, key, 'own');
  s.proven[key] = makeProven(s, key, s.people[key], { rank: 5, proof: 'bnet', link: true });
}

check('G1: a live Owner (only the cookie) appoints an accomplice Officer, unlinks themselves from their own person, then deletes the account: 403 fresh_required and the seat does not move; with the grant the plan\'s chain runs unchanged', async () => {
  const s = await ingameWorld();
  // No live in-game Guild Master (the first rule of the succession would pick them): the derived Guild Master's proof is gone.
  s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.dgm.cid}'`);
  await addLiveMember(s, 'acc', 'Accomplice');
  const seat = async () => (await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id;
  // 1. The Owner appoints the accomplice Officer (an Owner act that asks for no fresh sign-in).
  assert.equal((await s.setRoles('acc', { officer: true, teamLeadTeamIds: [] })).status, 200);
  // 2. Controls: the hand-over asks for a fresh sign-in, the delete of a LIVE Owner is a 409.
  const handOver = await s.call('own', 'POST', `/people/${s.uids.acc}/guild-master`, {});
  assert.deepEqual([handOver.status, handOver.json.error], [403, 'fresh_required']);
  const live = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.deepEqual([live.status, live.json.error], [409, 'hand_over_guild_master']);
  // 3. The Owner unlinks themselves from their own person (an Owner act on a proven person): they are suspended, the seat stays theirs.
  const unlink = await s.call('own', 'PUT', `/roster/${s.people.own.pid}/account`, { userId: null });
  assert.equal(unlink.status, 200, unlink.text);
  const impact = (await s.ok('own', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual([impact.handOverFirst, impact.succession.map((entryOf) => entryOf.rule)], [[], ['manual_officer']], 'a suspended seat holder skips the 409: the succession would run');
  // 4. The delete: refused, nothing moves, nothing is audited.
  const refusedDelete = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.deepEqual([refusedDelete.status, refusedDelete.json.error, refusedDelete.json.purpose], [403, 'fresh_required', 'account_delete'], refusedDelete.text);
  assert.equal(await seat(), s.uids.own, 'the seat did not move');
  assert.equal(await s.w.count('users', 'id = ?', s.uids.own), 1);
  assert.equal((await s.audit('guild.succession')).length, 0);
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  // The real owner of the account signs in again with Discord (the grant), and the chain (the earliest live manual Officer) runs as the plan says.
  const flow = await s.fresh('own', { purpose: 'account_delete', provider: 'discord' });
  assert.equal(flow.location, '/#/fresh?done=account_delete');
  const done = await s.call('own', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.equal(done.status, 200, done.text);
  assert.equal(await seat(), s.uids.acc);
  assert.deepEqual((await s.audit('guild.succession')).map((row) => JSON.parse(row.after).rule), ['manual_officer']);
});

// ---------------------------------------------------------------------------
// G3. The People list has a limit of its own

check('G3: GET /people is limited per user (own key, fixed window, fail open); the answers of the writes are not counted; another user and the next window are not affected', async () => {
  const s = await world();
  await s.officer('off', 'Officerone');
  const { PEOPLE_LIMIT, PEOPLE_WINDOW_MS, USERS_LIMIT } = await load('worker/ratelimit.js');
  assert(PEOPLE_LIMIT >= 30 && PEOPLE_WINDOW_MS === 60_000 && USERS_LIMIT === 30);
  const get = (key) => s.w.call(s.jars[key], 'GET', `${s.base}/people`);
  let served = 0;
  let last;
  for (; served < PEOPLE_LIMIT + 5; served++) {
    last = await get('gm');
    if (last.status === 429) break;
    assert.equal(last.status, 200, last.text);
  }
  assert.equal(served, PEOPLE_LIMIT, 'refused after exactly the limit');
  assert.deepEqual([last.status, last.json.error], [429, 'rate_limited']);
  assert(Number(last.headers.get('Retry-After')) >= 1);
  assert(await s.w.count('rate_limits', 'key = ?', `people:${s.uids.gm}`) === 1);
  assert.equal((await get('off')).status, 200, 'another user has a window of their own');
  // The writes answer with the People payload but do not spend the window.
  const before = (await s.one('SELECT count FROM rate_limits WHERE key = ?', `people:${s.uids.off}`)).count;
  await s.officer('off2', 'Officertwo');
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `people:${s.uids.gm}`)).count, PEOPLE_LIMIT + 1, 'the PUT of s.officer did not count (only the refused read did)');
  assert.equal((await s.one('SELECT count FROM rate_limits WHERE key = ?', `people:${s.uids.off}`)).count, before);
  s.w.advance(PEOPLE_WINDOW_MS + 1000);
  assert.equal((await get('gm')).status, 200, 'the next window');
  // A refusal for lack of permission does not count.
  await s.member('mem', 'Plainmember');
  for (let i = 0; i < PEOPLE_LIMIT + 3; i++) assert.equal((await get('mem')).status, 403);
  assert.equal(await s.w.count('rate_limits', 'key = ?', `people:${s.uids.mem}`), 0);
});

// ---------------------------------------------------------------------------
// G5. Who takes the seat is told to a member only

check('G5: deleteImpact.succession names the successor only to an account that is still a member of the guild; otherwise { userId: null, name: null } and the rule; vacant stays null', async () => {
  const s = await ingameWorld();
  s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.dgm.cid}'`); // no live in-game Guild Master
  await addLiveMember(s, 'acc', 'Accomplice');
  assert.equal((await s.setRoles('acc', { officer: true, teamLeadTeamIds: [] })).status, 200);
  // Suspended but still a member (their person is on the roster): told who.
  s.suspend();
  const asMember = (await s.ok('own', 'GET', '/auth/me')).deleteImpact.succession;
  assert.deepEqual(asMember.map((entryOf) => [entryOf.rule, entryOf.to && entryOf.to.userId, entryOf.to && entryOf.to.name]), [['manual_officer', s.uids.acc, 'Accomplice']]);
  // No longer a member (unlinked from their person): the rule, not the name.
  s.exec(`UPDATE players SET user_id = NULL WHERE id = '${s.people.own.pid}'`); // (a suspended Owner has no right to edit the roster: the fixture does it)
  const notMember = (await s.ok('own', 'GET', '/auth/me')).deleteImpact.succession;
  assert.deepEqual(notMember.map((entryOf) => [entryOf.guild.id, entryOf.rule, entryOf.to]), [[s.gid, 'manual_officer', { userId: null, name: null }]]);
  assert(!JSON.stringify(notMember).includes('Accomplice') && !JSON.stringify(notMember).includes(s.uids.acc), 'neither the name nor the id');
  // Nobody qualifies: vacant, and `to` stays null.
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'officer'`);
  const vacant = (await s.ok('own', 'GET', '/auth/me')).deleteImpact.succession;
  assert.deepEqual(vacant.map((entryOf) => [entryOf.rule, entryOf.to]), [['vacant', null]]);
});

runChecks(checks);
