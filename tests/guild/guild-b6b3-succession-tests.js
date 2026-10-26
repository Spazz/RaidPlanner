/**
 * Raidsmith guild tracker - lane B6b part 2b of the user-hierarchy build: succession of the Owner seat when its holder's account is deleted
 * (worker/succession.js, worker/routes/auth.js deleteImpact / deleteMe, worker/owner.js moveSeatStatement)
 * Run: node tests/guild/guild-b6b3-succession-tests.js [name filter]
 *
 *   - an UNSUSPENDED Owner with other members still has to hand over first (409 hand_over_guild_master); a SUSPENDED seat holder cannot hand over, so the seat passes on inside the
 *     delete's own batch: the live in-game Guild Master, else the earliest LIVE stored manual Officer (an earlier one with no character proved by Battle.net is skipped, a derived
 *     Officer never counts), else the seat is left vacant (NULL) and the GM claims it (part A, worker/gm-claim.js);
 *   - a manual guild: the earliest stored Officer, no liveness asked; a guild with no other member is deleted (a Discord-server-only account and a blocked one are no members of an
 *     in-game guild, a person with a character on the roster is);
 *   - every seat write carries `AND owner_user_id IS <the deleted account>`: a seat that moved between the read and the batch (a claim, a hand-over) stays where it went and no
 *     succession row is written; the audit row guild.succession says from, to (or vacant) and the rule that chose;
 *   - deleteImpact tells the page what will happen (succession: [{ guild, to: { userId, name } | null, rule }]), the query plans of its new reads walk no table.
 * Drives worker/index.js over the node:sqlite D1 stand-in with the fixtures of tests/guild-claim.js.
 */
const assert = require('node:assert/strict');
const { load, runChecks } = require('../guild-b3-world');
const { makeProven, rolesOf } = require('../guild-ingame');
const { scansSince } = require('../guild-plans');
const { ID, claim, claimWorld, addBulkMembers, auditRows, DONE, jsonOf, seatOf } = require('../guild-claim');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({
    name,
    fn: async () => {
      globalThis.__claimWorlds = [];
      try { await fn(); } finally { await Promise.all(globalThis.__claimWorlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 150)); } // (the sockets of the last world finish closing before process.exit)
    },
  });
}

// A member with a person on the roster: proof 'bnet' = live (a character proved by Battle.net), 'officer' = bound by an officer's proof only (a member, not live).
async function addMember(s, key, name, id, { rank = 5, proof = 'bnet' } = {}) {
  await s.member(key, name);
  s.people[key] = await s.person({ name });
  await s.link(s.people[key].pid, key);
  makeProven(s, key, s.people[key], { rank, id, proof, link: proof === 'bnet' });
  s.exec(`UPDATE guild_roster SET name = '${name}', name_key = '${name.toLowerCase()}' WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${id}`);
  s.live.roster.push({ name, id, rank });
}
const makeOfficer = async (s, key) => {
  const done = await s.call('gm', 'PUT', `/people/${s.uids[key]}/roles`, { officer: true, teamLeadTeamIds: [] });
  assert.equal(done.status, 200, done.text);
};
const dropProof = (s, key) => s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people[key].cid}'`);

// The in-game guild whose Owner 'gm' is SUSPENDED (their character is not proved by Battle.net): a derived Guild Master 'dgm' (rank 0, live), a derived Officer 'dof' (rank 1,
// live), three stored manual Officers made in this order: 'off0' (a member, NOT live), 'off1' and 'off2' (live). 'mem' is a plain member. The Guild Master 'igm' of the fake
// Blizzard is not a member (part A: the claim).
async function successionWorld({ gm = true, officers = true, manual = false } = {}) {
  // The people are made while the Owner is live (the roster routes are theirs); then the Owner is suspended.
  const s = await claimWorld({ stored: false });
  s.exec(`DELETE FROM guild_roster WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${ID.gm}`);
  if (gm) await addMember(s, 'dgm', 'Derivedgm', 9400, { rank: 0 });
  await addMember(s, 'dof', 'Derivedoff', 9401, { rank: 1 });
  if (officers) {
    await addMember(s, 'off0', 'Officerzero', 9410, { proof: 'officer' });
    await addMember(s, 'off1', 'Officerone', 9411);
    await addMember(s, 'off2', 'Officertwo', 9412);
    for (const key of ['off0', 'off1', 'off2']) await makeOfficer(s, key);
  }
  if (manual) s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  s.suspendOwner();
  s.impact = async (key = 'gm') => (await s.ok(key, 'GET', '/auth/me')).deleteImpact;
  s.deleteAccount = (key = 'gm', deleteGuildIds = []) => s.call(key, 'DELETE', '/auth/me', { deleteGuildIds });
  return s;
}
// A hook on db.batch: `action` runs just before the delete's batch (the one that deletes the account row).
function beforeDelete(s, action) {
  const real = s.w.db.batch.bind(s.w.db);
  let fired = false;
  s.w.db.batch = async (statements) => {
    if (!fired && statements.some((statement) => /DELETE FROM users WHERE id/.test(statement.sql))) { fired = true; action(); }
    return real(statements);
  };
  return () => { s.w.db.batch = real; };
}
const successions = (s) => auditRows(s, 'guild.succession').then((rows) => rows.map((row) => ({ ...row, before: jsonOf(row.before), after: jsonOf(row.after) })));

check('an UNSUSPENDED Owner with other members still hands over first (409 hand_over_guild_master); nothing changes, and the page is told there is no succession', async () => {
  const s = await successionWorld();
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.gm}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${s.uids.gm}') WHERE id = '${s.people.gm.cid}'`);
  const impact = await s.impact();
  assert.deepEqual([impact.handOverFirst.map((entry) => entry.id), impact.succession, impact.autoPromote], [[s.gid], [], []]);
  const refused = await s.deleteAccount();
  assert.deepEqual([refused.status, refused.json.error], [409, 'hand_over_guild_master']);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.gm), 1);
  assert.equal(await seatOf(s), s.uids.gm);
  assert.equal((await successions(s)).length, 0);
});

check('a SUSPENDED Owner deletes their account (200): the live in-game Guild Master gets the seat, audited with from, to and the rule', async () => {
  const s = await successionWorld();
  const impact = await s.impact();
  assert.deepEqual(impact.handOverFirst, [], 'a suspended Owner cannot hand over: no 409 any more');
  assert.deepEqual(impact.succession.map((entry) => [entry.guild.id, entry.to, entry.rule]), [[s.gid, { userId: s.uids.dgm, name: 'Derivedgm' }, 'ingame_gm']]);
  assert.equal(impact.guildsDeleted.length, 0);
  const done = await s.deleteAccount();
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.w.count('users', 'id = ?', s.uids.gm), 0, 'the account is gone');
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1, 'the guild stays');
  assert.equal(await seatOf(s), s.uids.dgm);
  assert.deepEqual(rolesOf(s, 'dgm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']], 'the new Owner is live');
  const rows = await successions(s);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].before, rows[0].after, rows[0].actor_role, rows[0].entity_id], [{ guildMasterUserId: s.uids.gm }, { guildMasterUserId: s.uids.dgm, rule: 'ingame_gm' }, 'owner', s.gid]);
  assert.equal(rows[0].actor_user_id, null, 'the deleted account is a name nobody holds any more (the foreign key cleared the actor)');
  assert.equal(await s.w.count('audit_log', "action = 'guild.delete'"), 0);
});

check('no live Guild Master: the earliest LIVE stored manual Officer (an earlier Officer with no character proved by Battle.net is skipped, a derived Officer never counts)', async () => {
  const s = await successionWorld();
  dropProof(s, 'dgm');
  const impact = await s.impact();
  assert.deepEqual(impact.succession.map((entry) => [entry.to && entry.to.userId, entry.rule]), [[s.uids.off1, 'manual_officer']], 'off0 is earlier but not live, dof is derived');
  const done = await s.deleteAccount();
  assert.equal(done.status, 200, done.text);
  assert.equal(await seatOf(s), s.uids.off1);
  assert.deepEqual(rolesOf(s, 'off1').map((entry) => entry[2]).sort(), ['manual', 'owner']);
  const rows = await successions(s);
  assert.deepEqual([rows[0].after.guildMasterUserId, rows[0].after.rule], [s.uids.off1, 'manual_officer']);
  // The next one in line when the first is gone too: the Owner's account is deleted in turn (a live Owner must hand over, so suspend them first).
  dropProof(s, 'off1');
  const second = await s.deleteAccount('off1');
  assert.equal(second.status, 200, second.text);
  assert.equal(await seatOf(s), s.uids.off2, 'off0 is still not live: off2 follows');
});

check('nobody qualifies: the seat is left VACANT (NULL, audited), the guild stays, and the in-game Guild Master claims it (part A)', async () => {
  const s = await successionWorld({ gm: false, officers: false });
  const impact = await s.impact();
  assert.deepEqual(impact.succession.map((entry) => [entry.to, entry.rule]), [[null, 'vacant']], 'a derived Officer and a plain member do not take the seat');
  const done = await s.deleteAccount();
  assert.equal(done.status, 200, done.text);
  assert.equal(await seatOf(s), null);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 1);
  const rows = await successions(s);
  assert.deepEqual([rows[0].before, rows[0].after], [{ guildMasterUserId: s.uids.gm }, { guildMasterUserId: null, rule: 'vacant' }]);
  // The in-game Guild Master claims the vacant seat inside the Battle.net callback.
  assert.equal((await claim(s, 'igm')).location, DONE);
  assert.equal(await seatOf(s), s.uids.igm);
  assert.deepEqual(rolesOf(s, 'igm'), [['guild_master', null, 'ingame'], ['guild_master', null, 'owner']]);
  assert.deepEqual(jsonOf((await auditRows(s, 'guild.claim'))[0].before), { guildMasterUserId: null, suspended: false });
});

check('any other path: a member joins between the read and the batch (the guild was "alone", so the guild is not deleted but the seat must not be orphaned): a manual guild passes it to the earliest stored Officer, an in-game guild by its rules, else vacant', async () => {
  // A MANUAL guild: its Owner is never suspended, so with members they must hand over (409); alone at the read, the batch finds a member and the earliest stored Officer takes the seat.
  const manual = await successionWorld({ manual: true });
  assert.deepEqual(await manual.impact(), { handOverFirst: [{ id: manual.gid, name: 'Writers B3' }], guildsDeleted: [], autoPromote: [], succession: [] }, "with members a manual guild's Owner hands over first");
  const peopleOf = (s) => ['mem', 'dgm', 'dof', 'off0', 'off1', 'off2'].map((key) => s.people[key].pid);
  const linkAll = (s) => peopleOf(s).forEach((pid, index) => s.exec(`UPDATE players SET user_id = '${s.uids[['mem', 'dgm', 'dof', 'off0', 'off1', 'off2'][index]]}' WHERE id = '${pid}'`));
  const unlinkAll = (s) => s.exec(`UPDATE players SET user_id = NULL WHERE id IN (${peopleOf(s).map((pid) => `'${pid}'`).join(', ')})`);
  unlinkAll(manual);
  assert.deepEqual((await manual.impact()).guildsDeleted.map((entry) => entry.id), [manual.gid], 'alone: the guild goes with the account');
  const restore = beforeDelete(manual, () => linkAll(manual));
  const done = await manual.deleteAccount('gm', [manual.gid]);
  restore();
  assert.equal(done.status, 200, done.text);
  assert.equal(await manual.w.count('guilds', 'id = ?', manual.gid), 1, 'a guild that has a member is not deleted');
  assert.equal(await seatOf(manual), manual.uids.off0, 'the earliest stored Officer: no liveness is asked of a manual guild');
  assert.deepEqual((await successions(manual))[0].after, { guildMasterUserId: manual.uids.off0, rule: 'officer' });

  // The same in an in-game guild (everybody else is blocked at the read, so the guild is alone; unblocked when the batch runs): the live Guild Master first, then the earliest live
  // manual Officer, then vacant. (A block, not an unlink: unlinking a person clears the proofs of its characters.)
  const blocking = (s, keys) => ({
    block: () => keys.forEach((key) => s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids[key]}', '${s.uids.gm}', 1)`)),
    unblock: () => s.exec(`DELETE FROM guild_blocks WHERE guild_id = '${s.gid}'`),
  });
  const ingame = await successionWorld();
  const others = blocking(ingame, ['mem', 'dgm', 'dof', 'off0', 'off1', 'off2']);
  others.block();
  assert.deepEqual((await ingame.impact()).guildsDeleted.map((entry) => entry.id), [ingame.gid]);
  const again = beforeDelete(ingame, others.unblock);
  assert.equal((await ingame.deleteAccount('gm', [ingame.gid])).status, 200);
  again();
  assert.equal(await seatOf(ingame), ingame.uids.dgm, 'the live Guild Master');
  const officers = await successionWorld();
  dropProof(officers, 'dgm');
  const officerBlocks = blocking(officers, ['mem', 'dgm', 'dof', 'off0', 'off1', 'off2']);
  officerBlocks.block();
  const next = beforeDelete(officers, officerBlocks.unblock);
  assert.equal((await officers.deleteAccount('gm', [officers.gid])).status, 200);
  next();
  assert.equal(await seatOf(officers), officers.uids.off1, 'no live Guild Master: the earliest live manual Officer');
  const bare = await successionWorld({ gm: false, officers: false });
  const bareBlocks = blocking(bare, ['mem', 'dof']);
  bareBlocks.block();
  const last = beforeDelete(bare, bareBlocks.unblock);
  assert.equal((await bare.deleteAccount('gm', [bare.gid])).status, 200);
  last();
  assert.equal(await seatOf(bare), null, 'nobody qualifies: vacant');
  assert.equal(await bare.w.count('guilds', 'id = ?', bare.gid), 1);
});

check('the live Guild Master of the succession is the guild_master row of effective_roles_ingame: they agree over a rank 0 that is Former, unmapped, unproved, moved, and an account that is blocked', async () => {
  const { liveGmSql } = await load('worker/succession.js');
  const s = await successionWorld();
  const viaSql = async () => {
    const row = await s.w.db.prepare(`SELECT (${liveGmSql('g.id', 'g.discord_server_id', "'u_nobody'")}) AS gm FROM guilds g WHERE g.id = ?`).bind(s.gid).first();
    return row.gm;
  };
  const viaView = async () => (await s.one("SELECT user_id FROM effective_roles WHERE guild_id = ? AND role_id = 'guild_master' AND source = 'ingame'", s.gid) || {}).user_id || null;
  const scene = async (label, expected) => {
    assert.equal(await viaView(), expected, `${label}: the view`);
    assert.equal(await viaSql(), expected, `${label}: the succession`);
  };
  await scene('a live rank-0 character', s.uids.dgm);
  s.exec(`UPDATE characters SET left_on = '2026-01-01' WHERE id = '${s.people.dgm.cid}'`);
  await scene('the rank-0 character is Former', null);
  s.exec(`UPDATE characters SET left_on = NULL WHERE id = '${s.people.dgm.cid}'`);
  s.exec(`UPDATE source_rank_maps SET role_id = NULL WHERE guild_id = '${s.gid}' AND source_key = '0'`);
  await scene('rank 0 maps to no role', null);
  s.exec(`UPDATE source_rank_maps SET role_id = 'guild_master' WHERE guild_id = '${s.gid}' AND source_key = '0'`);
  dropProof(s, 'dgm');
  await scene('the character is not proved by Battle.net', null);
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.dgm}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${s.uids.dgm}') WHERE id = '${s.people.dgm.cid}'`);
  await scene('proved again', s.uids.dgm);
  s.exec(`UPDATE guild_roster SET rank = 1 WHERE guild_id = '${s.gid}' AND blizzard_char_id = 9400`);
  await scene('the character moved to rank 1', null);
  s.exec(`UPDATE guild_roster SET rank = 0 WHERE guild_id = '${s.gid}' AND blizzard_char_id = 9400`);
  await scene('and back', s.uids.dgm);
  // A blocked GM is no member: the view still says so, the succession does not choose them.
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.dgm}', '${s.uids.gm}', 1)`);
  assert.equal(await viaSql(), null, 'blocked: not a member, so not a successor');
});

check('the guild is deleted only when NO other member exists: a Discord-server-only account, a blocked person and the seat holder do not count; a person with a character on the roster does', async () => {
  const s = await claimWorld();
  await s.member('srv', 'Serveronly');
  const made = await s.person({ name: 'Blockedone' });
  s.exec(`DELETE FROM players WHERE id = '${s.people.mem.pid}'`);
  s.suspendOwner();
  assert.equal(await s.w.count('user_servers', 'user_id = ?', s.uids.srv), 1, 'a Discord-server member with no person');
  let impact = (await s.ok('gm', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual([impact.guildsDeleted.map((entry) => entry.id), impact.succession, impact.handOverFirst], [[s.gid], [], []], 'in an in-game guild the server grants nothing');
  // A person with a roster character who is BLOCKED is no member either.
  s.exec(`UPDATE players SET user_id = '${s.uids.srv}' WHERE id = '${made.pid}'`);
  makeProven(s, 'srv', made, { rank: 5, id: 9500, proof: 'officer', link: false });
  assert.equal((await s.ok('gm', 'GET', '/auth/me')).deleteImpact.succession.length, 1, 'a person with a character on the roster is a member');
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, created_at) VALUES ('${s.gid}', '${s.uids.srv}', '${s.uids.gm}', 1)`);
  impact = (await s.ok('gm', 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual([impact.guildsDeleted.map((entry) => entry.id), impact.succession], [[s.gid], []], 'blocked: not a member');
  // The impact is echoed: the guild goes with the account.
  const wrong = await s.call('gm', 'DELETE', '/auth/me', { deleteGuildIds: [] });
  assert.deepEqual([wrong.status, wrong.json.error], [409, 'confirm_mismatch']);
  const done = await s.call('gm', 'DELETE', '/auth/me', { deleteGuildIds: [s.gid] });
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.w.count('guilds', 'id = ?', s.gid), 0);
});

check('the seat guard holds: a seat that moved between the read and the batch (a claim, a hand-over) stays where it went, no succession row is written, the account is still deleted; the statement says so', async () => {
  const s = await successionWorld();
  const real = s.w.db.batch.bind(s.w.db);
  let log = [];
  let fired = false;
  s.w.db.batch = async (statements) => {
    if (!fired && statements.some((statement) => /DELETE FROM users WHERE id/.test(statement.sql))) {
      fired = true;
      s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.mem}' WHERE id = '${s.gid}'`);
      log = statements.map((statement) => statement.sql);
    }
    return real(statements);
  };
  const done = await s.deleteAccount();
  s.w.db.batch = real;
  assert(fired);
  assert.equal(done.status, 200, done.text);
  assert.equal(await seatOf(s), s.uids.mem, 'the seat the other request gave stays');
  assert.equal((await successions(s)).length, 0, 'no succession row: the seat was not the departing account\'s when the batch ran');
  assert(log.some((sql) => /UPDATE guilds SET owner_user_id = \(SELECT COALESCE.*WHERE id = \? AND owner_user_id IS \?/s.test(sql)), 'the seat write carries AND owner_user_id IS <the deleted account>');
});

check('the page and the log say what happens: the audit sentences, and the new reads walk no table of a 1,200-member guild', async () => {
  const s = await successionWorld();
  addBulkMembers(s, 1200 - s.live.roster.length);
  const mark = s.w.db.statementLog.length;
  const impact = await s.impact();
  assert.equal(impact.succession.length, 1);
  const run = s.w.db.statementLog.slice(mark).filter((statement) => /AS owner_live|AS gm_id/.test(statement.sql));
  assert.equal(run.length, 2, 'the impact (the Owner and the members) and, for a suspended seat holder only, who would take the seat');
  assert.deepEqual(scansSince({ sqlite: s.w.db.sqlite, statementLog: run }, 0), [], 'no scan of characters, guild_roster, players or role_assignments');
  const live = await successionWorld();
  const unsuspended = live.w.db.statementLog.length;
  live.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${live.uids.gm}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${live.uids.gm}') WHERE id = '${live.people.gm.cid}'`);
  await live.impact();
  assert.equal(live.w.db.statementLog.slice(unsuspended).filter((statement) => /AS gm_id/.test(statement.sql)).length, 0, 'a live Owner costs the page nothing extra');
  const batchMark = s.w.db.statementLog.length;
  assert.equal((await s.deleteAccount()).status, 200);
  const written = s.w.db.statementLog.slice(batchMark).filter((statement) => /guild\.succession|UPDATE guilds SET owner_user_id/.test(statement.sql));
  assert.equal(written.length, 2, 'the seat write and the audit row: two statements per guild');
  assert.deepEqual(scansSince({ sqlite: s.w.db.sqlite, statementLog: written }, 0), []);
  // The Activity sentences.
  const { describeRow, unmappedActions } = await load('worker/audit-view.js');
  assert.deepEqual(unmappedActions(), [], 'every audit action has a group');
  const sentence = (action, before, after, names = {}) => describeRow({ action, entityType: 'guild', entityId: s.gid, before, after, actor: null }, names);
  assert.match(sentence('guild.succession', { guildMasterUserId: s.uids.gm }, { guildMasterUserId: s.uids.dgm, rule: 'ingame_gm' }), /Owner seat passed from .* to .* \(the Guild Master in game\)/);
  assert.match(sentence('guild.succession', { guildMasterUserId: s.uids.gm }, { guildMasterUserId: null, rule: 'vacant' }), /vacant until the Guild Master in game claims it/);
  assert.match(sentence('guild.claim', { guildMasterUserId: s.uids.gm, suspended: true }, { guildMasterUserId: s.uids.igm, via: 'gm_claim' }), /Claimed the Owner seat from .*, who was suspended/);
  assert.match(sentence('guild.claim', { guildMasterUserId: null, suspended: false }, { guildMasterUserId: s.uids.igm, via: 'gm_claim' }), /Claimed the vacant Owner seat/);
  assert.equal(sentence('guild.claim', {}, { guildMasterUserId: s.uids.igm }), 'Claimed the guild as Guild Master', 'the legacy claim keeps its sentence');
});

runChecks(checks);
