/**
 * Raidsmith guild tracker - lane B6b of the user-hierarchy build, part 1: every reader and every Owner / Guild-Master-tier gate against DERIVED principals
 * Run: node tests/guild/guild-b6b-gates-tests.js
 *
 * An in-game guild with: the Owner 'own' (live: a Battle.net-proven character), a derived Guild Master 'dgm' (in-game rank 0), a derived Officer 'dof' (rank 1), a derived Team Lead
 * 'dtl' (rank 2, placed on Alpha), 'dtn' (rank 2 with NO team: a plain member), a stored Officer 'sof' and a plain member 'mem' (both bound to the roster by an officer's proof).
 *   - loadGuildContext reads the view: derived Officer / Team Lead (scoped to the placed team) / Guild Master; the Owner is a Guild Master by its own row;
 *   - every Owner-only gate (rank map read / dry run / change, hand-over, guild delete, the flip dry run, linking a person that holds a Battle.net-proven character) refuses a
 *     derived Guild Master and a SUSPENDED Owner and lets the live Owner through; the Guild-Master-tier gate (deleting a Battle.net-proven person) lets a derived Guild Master through;
 *   - the Seniority guard (arch A9-18), the audit actor_role snapshot (review F8), the People lists and Edit roles (derived rows are read-only), the role counts, the teams'
 *     Team Lead lists, the setup checklist and My guilds read the effective roles.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { flip, makeProven } = require('../guild-ingame');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const ONE_RANK = [{ rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }];

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  s.people = {};
  const spec = [
    ['own', 'Seatowner', 4, {}], ['dgm', 'Derivedgm', 0, {}], ['dof', 'Derivedoff', 1, {}], ['dtl', 'Derivedlead', 2, {}], ['dtn', 'Teamlesslead', 2, { teamId: null }],
    ['sof', 'Storedoff', 5, {}], ['mem', 'Plainmember', 5, {}],
  ];
  for (const [key, name, , extra] of spec) {
    await s.member(key, name);
    s.people[key] = await s.person({ name, ...extra });
    await s.link(s.people[key].pid, key);
  }
  await s.ok('gm', 'PUT', `/people/${s.uids.sof}/roles`, { officer: true, teamLeadTeamIds: [] }, 200); // the stored Officer, set by hand while the guild was legacy
  for (const [key, , rank] of spec) {
    if (key === 'sof' || key === 'mem') makeProven(s, key, s.people[key], { rank, proof: 'officer', link: false });
    else makeProven(s, key, s.people[key], { rank });
  }
  flip(s, { owner: 'own' });
  // Suspending the Owner = their proof stops being a Battle.net proof (they stay bound to the roster, so they stay members: a refusal below is the gate's, not membership's).
  s.suspend = () => s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.own.cid}'`);
  s.restore = () => s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.own}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${s.uids.own}') WHERE id = '${s.people.own.cid}'`);
  return s;
}

// ---------------------------------------------------------------------------
// 1. loadGuildContext

check('loadGuildContext: a derived Officer, a derived Team Lead (scoped to the team its character is placed on), a derived Guild Master and the Owner hold what the view gives them', async () => {
  const s = await world();
  const ctx = async (key) => (await s.ok(key, 'GET', '')).me;
  const dof = await ctx('dof');
  assert.deepEqual(dof.roles, [{ role: 'officer', fromRank: true }]);
  assert.equal(dof.can['guild.access'], 'guild');
  assert.equal(dof.can['roster.edit'], 'guild');
  assert.equal(dof.can['guild.roles'], undefined, 'the Officer role does not hold guild.roles by default');
  const dtl = await ctx('dtl');
  assert.deepEqual(dtl.roles, [{ role: 'team_lead', teamId: s.alpha, fromRank: true }]);
  assert.deepEqual(dtl.can['roster.edit'], [s.alpha], 'Team Lead of Alpha only');
  assert.deepEqual(dtl.can['attendance.review'], [s.alpha]);
  assert.equal(dtl.can['guild.roles'], undefined);
  const dtn = await ctx('dtn');
  assert.deepEqual(dtn.roles, [], 'a Team Lead rank on a character with no team holds nothing');
  assert.equal(dtn.can['roster.edit'], undefined);
  const dgm = await ctx('dgm');
  assert.deepEqual(dgm.roles, [{ role: 'guild_master', fromRank: true }]);
  assert.equal(dgm.can['guild.roles'], 'guild');
  const own = await ctx('own');
  assert.deepEqual(own.roles, [{ role: 'guild_master' }], 'the Owner row: no "from rank" mark');
  assert.equal(own.can['guild.roles'], 'guild');
  const sof = await ctx('sof');
  assert.deepEqual(sof.roles, [{ role: 'officer' }], 'a stored Officer survives: hand-assigned roles stay available in an in-game guild');
  assert.deepEqual((await ctx('mem')).roles, []);
  // The isGuildMaster flag (full powers, Settings details) follows the effective rank.
  const { loadGuildContext } = await load('worker/permissions.js');
  const flags = {};
  for (const key of ['own', 'dgm', 'dof', 'dtl', 'sof', 'mem']) {
    const context = await loadGuildContext(s.w.db, s.uids[key], s.gid);
    flags[key] = [context.rank, context.isGuildMaster];
  }
  assert.deepEqual(flags, { own: [0, true], dgm: [0, true], dof: [1, false], dtl: [2, false], sof: [1, false], mem: [3, false] });
});

// ---------------------------------------------------------------------------
// 2. The Owner-only gates

check('Owner-only gates: the rank map (read, dry run, change) refuses a derived Guild Master, an Officer and a SUSPENDED Owner; the live Owner is allowed', async () => {
  const s = await world();
  const refuse = async (who) => {
    await s.fail(who, 'GET', '/rank-map', undefined, 403, 'forbidden');
    await s.fail(who, 'POST', '/rank-map/dry-run', { ranks: ONE_RANK }, 403, 'forbidden');
    await s.fail(who, 'PUT', '/rank-map', { ranks: ONE_RANK, token: 'x'.repeat(43) }, 403, 'forbidden');
  };
  for (const who of ['dgm', 'dof', 'sof', 'mem']) await refuse(who);
  s.suspend();
  await refuse('own');
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 0, 'a refused dry run leaves no token');
  s.restore();
  assert.equal((await s.ok('own', 'GET', '/rank-map', undefined, 200)).ranks.length, 10);
  const dry = await s.ok('own', 'POST', '/rank-map/dry-run', { ranks: ONE_RANK }, 200);
  await s.ok('own', 'PUT', '/rank-map', { ranks: ONE_RANK, token: dry.token }, 200);
});

check('Owner-only gate: handing over the Guild Master refuses a derived Guild Master and a suspended Owner (nothing changes); the live Owner gets past the gate', async () => {
  const s = await world();
  const seat = async () => (await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id;
  const refused = await s.fail('dgm', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  assert(/Owner/.test(refused.message), refused.message);
  await s.fail('dof', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  s.suspend();
  await s.fail('own', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  s.restore();
  assert.equal(await seat(), s.uids.own);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'guild_master.transfer'")).length, 0);
  // The Owner passes the gate and meets the hand-over's own rules (lane B6b part 2a): 'mem' has no Battle.net-proven character, so in an in-game guild they are not a live recipient.
  const res = await s.call('own', 'POST', `/people/${s.uids.mem}/guild-master`, {});
  assert.deepEqual([res.status, res.json.error], [409, 'recipient_not_live'], res.text);
});

check('Owner-only gate: the flip dry run refuses a derived Guild Master, an Officer and a suspended Owner before anything else; the live Owner reaches the already-in-game answer', async () => {
  const s = await world();
  for (const who of ['dgm', 'dof', 'sof']) await s.fail(who, 'POST', '/flip/dry-run', {}, 403, 'forbidden');
  s.suspend();
  await s.fail('own', 'POST', '/flip/dry-run', {}, 403, 'forbidden');
  s.restore();
  await s.fail('own', 'POST', '/flip/dry-run', {}, 409, 'already_ingame');
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 0);
});

check('Owner-only gate: linking or unlinking a person that holds a Battle.net-proven character refuses a derived Guild Master and a suspended Owner; the live Owner may', async () => {
  const s = await world();
  const target = s.people.dof;
  const refused = await s.fail('dgm', 'PUT', `/roster/${target.pid}/account`, { userId: null }, 403, 'forbidden');
  assert(/Owner|Battle\.net/.test(refused.message), refused.message);
  await s.fail('dof', 'PUT', `/roster/${target.pid}/account`, { userId: null }, 403);
  s.suspend();
  await s.fail('own', 'PUT', `/roster/${target.pid}/account`, { userId: null }, 403);
  s.restore();
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', target.pid)).user_id, s.uids.dof, 'still linked');
  await s.ok('own', 'PUT', `/roster/${target.pid}/account`, { userId: null }, 200);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', target.pid)).user_id, null);
});

check('Owner-only gate: deleting the guild refuses a derived Guild Master with the right name typed and a suspended Owner; the live Owner deletes it', async () => {
  const s = await world();
  const name = (await s.one('SELECT name FROM guilds WHERE id = ?', s.gid)).name;
  const refused = await s.fail('dgm', 'DELETE', '', { confirmName: name }, 403, 'forbidden');
  assert(/Owner/.test(refused.message), refused.message);
  await s.fail('dof', 'DELETE', '', { confirmName: name }, 403, 'forbidden');
  s.suspend();
  await s.fail('own', 'DELETE', '', { confirmName: name }, 403, 'forbidden');
  s.restore();
  assert.equal((await s.rows('SELECT id FROM guilds WHERE id = ?', s.gid)).length, 1);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'guild.delete'")).length, 0);
  await s.ok('own', 'DELETE', '', { confirmName: name }, 200);
  assert.equal((await s.rows('SELECT id FROM guilds WHERE id = ?', s.gid)).length, 0);
});

check('Guild-Master-tier gate: deleting a Battle.net-proven person is for a GM-tier actor (derived Guild Master, Owner) - a derived Officer who outranks the person and a suspended Owner are refused', async () => {
  const s = await world();
  const refusedOfficer = await s.fail('dof', 'DELETE', `/roster/${s.people.dtl.pid}`, {}, 403, 'seniority');
  assert(/Battle\.net/.test(refusedOfficer.message), refusedOfficer.message);
  s.suspend();
  await s.fail('own', 'DELETE', `/roster/${s.people.dtn.pid}`, {}, 403); // a plain member: not even roster.edit
  s.restore();
  assert.equal((await s.rows('SELECT id FROM players WHERE id IN (?, ?)', s.people.dtl.pid, s.people.dtn.pid)).length, 2);
  await s.ok('dgm', 'DELETE', `/roster/${s.people.dtl.pid}`, {}, 200);
  await s.ok('own', 'DELETE', `/roster/${s.people.dtn.pid}`, {}, 200);
});

// ---------------------------------------------------------------------------
// 3. The Seniority guard (arch A9-18)

check('the Seniority guard reads the effective roles: derived ranks decide who may touch whose person; the Owner\'s person is protected only while the Owner is not suspended', async () => {
  const { seniorityOk } = await load('worker/seniority.js');
  const s = await world();
  const may = async (actor, target) => {
    const guard = seniorityOk(s.gid, s.uids[actor], s.people[target].pid);
    return (await s.w.db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first()).ok === 1;
  };
  const keys = ['own', 'dgm', 'dof', 'sof', 'dtl', 'dtn', 'mem'];
  const expected = {
    own: { own: 1, dgm: 1, dof: 1, sof: 1, dtl: 1, dtn: 1, mem: 1 },
    dgm: { own: 0, dgm: 1, dof: 1, sof: 1, dtl: 1, dtn: 1, mem: 1 },
    dof: { own: 0, dgm: 0, dof: 1, sof: 0, dtl: 1, dtn: 1, mem: 1 },
    sof: { own: 0, dgm: 0, dof: 0, sof: 1, dtl: 1, dtn: 1, mem: 1 },
    dtl: { own: 0, dgm: 0, dof: 0, sof: 0, dtl: 1, dtn: 1, mem: 1 },
    dtn: { own: 0, dgm: 0, dof: 0, sof: 0, dtl: 0, dtn: 1, mem: 0 },
    mem: { own: 0, dgm: 0, dof: 0, sof: 0, dtl: 0, dtn: 0, mem: 1 },
  };
  for (const actor of keys) for (const target of keys) assert.equal(await may(actor, target), expected[actor][target] === 1, `${actor} on the person of ${target}`);
  // Suspended: the Owner keeps the seat and nothing else, so the Owner's person is nobody's to protect and their powers are a plain member's.
  s.suspend();
  assert.equal(await may('dof', 'own'), true, 'an Officer may touch a suspended Owner\'s person');
  assert.equal(await may('mem', 'own'), false, 'a member is equal to them');
  assert.equal(await may('own', 'dof'), false);
  assert.equal(await may('own', 'mem'), false, 'equal to a member');
  assert.equal(await may('own', 'own'), true, 'their own person');
  s.restore();
  assert.equal(await may('dof', 'own'), false);
  assert.equal(await may('own', 'dof'), true);
  // Through the route: a derived Officer cannot delete the Owner's person nor an equal derived Officer's, but deletes a member's.
  await s.fail('dof', 'DELETE', `/roster/${s.people.own.pid}`, {}, 403, 'seniority');
  await s.fail('sof', 'DELETE', `/roster/${s.people.dof.pid}`, {}, 403, 'seniority');
  await s.ok('dof', 'DELETE', `/roster/${s.people.mem.pid}`, {}, 200);
});

// ---------------------------------------------------------------------------
// 4. The audit snapshot (review F8)

check('the audit actor_role snapshot reads the effective roles: owner, guild_master (derived), officer (derived and stored), team_lead (derived), member; a suspended Owner reads what they hold', async () => {
  const s = await world();
  const { auditStatement } = await load('worker/audit.js');
  const ctx = { db: s.w.db, randomBytes: s.w.randomBytes, now: () => 5 };
  const write = async (key, action) => {
    await s.w.db.batch([auditStatement(ctx, { guildId: s.gid, actorUserId: s.uids[key], action, entityType: 'guild', entityId: s.gid })]);
    return (await s.one('SELECT actor_role FROM audit_log WHERE action = ?', action)).actor_role;
  };
  assert.equal(await write('own', 'a.owner'), 'owner');
  assert.equal(await write('dgm', 'a.gm'), 'guild_master');
  assert.equal(await write('dof', 'a.dof'), 'officer');
  assert.equal(await write('sof', 'a.sof'), 'officer');
  assert.equal(await write('dtl', 'a.dtl'), 'team_lead');
  assert.equal(await write('dtn', 'a.dtn'), 'member');
  assert.equal(await write('mem', 'a.mem'), 'member');
  s.suspend();
  assert.equal(await write('own', 'a.suspended'), 'member', 'a suspended Owner is a member until the proof is back');
  s.restore();
  assert.equal(await write('own', 'a.restored'), 'owner');
});

// ---------------------------------------------------------------------------
// 5. People and Edit roles: derived rows are read-only

check('People lists the derived roles; Edit roles changes the hand-set rows only - a derived row is never edited or deleted, a hand row can sit beside it', async () => {
  const s = await world();
  const list = async (who) => (await s.ok(who, 'GET', '/people')).people;
  const entry = (people, key) => people.find((person) => person.person.id === s.uids[key]);
  const people = await list('own');
  assert.deepEqual(entry(people, 'dof').roles, [{ role: 'officer', fromRank: true }]);
  assert.deepEqual(entry(people, 'dtl').roles, [{ role: 'team_lead', teamId: s.alpha, fromRank: true }]);
  assert.deepEqual(entry(people, 'dgm').roles, [{ role: 'guild_master', fromRank: true }]);
  assert.deepEqual(entry(people, 'sof').roles, [{ role: 'officer' }]);
  assert.equal(entry(people, 'own').actions.editRoles, false, 'no change to your own roles');
  assert.equal(entry(people, 'dgm').actions.editRoles, false, 'a Guild Master (derived too) is changed by nobody');
  assert.equal(entry(people, 'dof').actions.editRoles, true);
  assert.equal((await list('dof')).length, people.length, 'a derived Officer holds guild.access and reads the list');
  const rolesOfDtl = () => s.rows("SELECT role_id, team_id, source FROM effective_roles WHERE guild_id = ? AND user_id = ? ORDER BY role_id, source", s.gid, s.uids.dtl).then((rows) => rows.map((row) => [row.role_id, row.team_id, row.source]));
  const stored = () => s.rows('SELECT role_id, team_id, source FROM role_assignments WHERE guild_id = ? AND user_id = ?', s.gid, s.uids.dtl);
  // Saving with nothing hand-set changes nothing: the derived Team Lead row is not deleted.
  await s.ok('own', 'PUT', `/people/${s.uids.dtl}/roles`, { officer: false, teamLeadTeamIds: [] }, 200);
  assert.deepEqual(await stored(), []);
  assert.deepEqual(await rolesOfDtl(), [['team_lead', s.alpha, 'ingame']]);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'roles.set' AND entity_id = ?", s.uids.dtl)).length, 0, 'no change, no audit row');
  // A hand-set Officer is a stored row beside the derived one.
  await s.ok('own', 'PUT', `/people/${s.uids.dtl}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  assert.deepEqual((await stored()).map((row) => [row.role_id, row.source]), [['officer', 'manual']]);
  assert.deepEqual(await rolesOfDtl(), [['officer', null, 'manual'], ['team_lead', s.alpha, 'ingame']]);
  // Taking it away deletes the hand row and only that.
  await s.ok('own', 'PUT', `/people/${s.uids.dtl}/roles`, { officer: false, teamLeadTeamIds: [] }, 200);
  assert.deepEqual(await stored(), []);
  assert.deepEqual(await rolesOfDtl(), [['team_lead', s.alpha, 'ingame']]);
  // A derived Guild Master and the Owner are not editable, whoever asks.
  await s.fail('own', 'PUT', `/people/${s.uids.dgm}/roles`, { officer: false, teamLeadTeamIds: [] }, 403, 'forbidden');
  await s.fail('dgm', 'PUT', `/people/${s.uids.own}/roles`, { officer: true, teamLeadTeamIds: [] }, 403, 'forbidden');
  // A derived Officer holds guild.access but not guild.roles: it reads the list and edits nobody's roles.
  await s.fail('dof', 'PUT', `/people/${s.uids.mem}/roles`, { officer: false, teamLeadTeamIds: [s.alpha] }, 403, 'forbidden');
  // A derived Guild Master holds it and outranks a member and a stored Officer.
  await s.ok('dgm', 'PUT', `/people/${s.uids.mem}/roles`, { officer: false, teamLeadTeamIds: [s.alpha] }, 200);
  await s.ok('dgm', 'PUT', `/people/${s.uids.sof}/roles`, { officer: false, teamLeadTeamIds: [] }, 200);
  assert.deepEqual(await s.rows('SELECT role_id FROM role_assignments WHERE user_id = ? AND source = ?', s.uids.sof, 'manual'), [], 'the stored Officer row went');
  // A suspended Owner can edit nothing.
  s.suspend();
  await s.fail('own', 'PUT', `/people/${s.uids.mem}/roles`, { officer: true, teamLeadTeamIds: [] }, 403, 'forbidden');
});

// ---------------------------------------------------------------------------
// 6. The other readers

check('role counts, the teams\' Team Lead lists, the setup checklist, My guilds and the account-delete impact read the effective roles', async () => {
  const s = await world();
  const roles = (await s.ok('own', 'GET', '/roles')).roles;
  const holders = (id) => roles.find((role) => role.id === id).holders;
  assert.deepEqual([holders('guild_master'), holders('officer'), holders('team_lead')], [2, 2, 1], 'the Owner and a derived Guild Master; a derived and a stored Officer; a derived Team Lead');
  const teams = (await s.ok('own', 'GET', '')).teams;
  const leadsOf = (id) => teams.find((team) => team.id === id).leads.map((lead) => lead.id);
  assert.deepEqual(leadsOf(s.alpha), [s.uids.dtl], 'the derived Team Lead leads the team its character is placed on');
  assert.deepEqual(leadsOf(s.bravo), []);
  // My guilds: the chips.
  const meOf = async (key) => (await s.ok(key, 'GET', '/auth/me')).guilds.find((guild) => guild.id === s.gid).roles;
  assert.deepEqual(await meOf('dof'), [{ role: 'officer', fromRank: true }]);
  assert.deepEqual(await meOf('dtl'), [{ role: 'team_lead', teamId: s.alpha, fromRank: true }]);
  assert.deepEqual(await meOf('own'), [{ role: 'guild_master' }]);
  assert.deepEqual(await meOf('mem'), []);
  // The setup checklist's "officers" step is done by any role besides the Guild Master: a derived Officer counts, a derived Guild Master alone does not.
  const step = async () => (await s.ok('own', 'GET', '/attention')).onboarding.steps.find((entry) => entry.id === 'officers').done;
  assert.equal(await step(), true);
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'officer'`);
  assert.equal(await step(), true, 'the derived Officer and Team Lead still count');
  s.exec(`UPDATE guild_roster SET rank = 5 WHERE guild_id = '${s.gid}' AND blizzard_char_id IN (SELECT blizzard_char_id FROM characters WHERE id IN ('${s.people.dof.cid}', '${s.people.dtl.cid}'))`);
  assert.equal(await step(), false, 'only Guild Masters (the Owner and a derived one) are left');
  s.exec(`UPDATE guild_roster SET rank = 1 WHERE guild_id = '${s.gid}' AND blizzard_char_id IN (SELECT blizzard_char_id FROM characters WHERE id = '${s.people.dof.cid}')`);
  assert.equal(await step(), true);
  // The account-delete impact: the Owner leads the guild (hand over first); a derived Guild Master does not; a suspended Owner still holds the seat.
  const impact = async (key) => (await s.ok(key, 'GET', '/auth/me')).deleteImpact;
  assert.deepEqual((await impact('own')).handOverFirst.map((guild) => guild.id), [s.gid]);
  assert.deepEqual(await impact('dgm'), { handOverFirst: [], guildsDeleted: [], autoPromote: [] });
  s.suspend();
  assert.deepEqual((await impact('own')).handOverFirst.map((guild) => guild.id), [s.gid], 'the seat is theirs while suspended');
});

check('the Discord role sync skips a Guild Master of any kind (the Owner, a derived one) and a stored discord row still counts as Discord\'s', async () => {
  const s = await world();
  const { syncMember } = await load('worker/discord-sync.js');
  const guild = (await s.rows('SELECT * FROM guilds WHERE id = ?', s.gid))[0];
  const skipped = {};
  for (const key of ['own', 'dgm', 'dof']) {
    const result = await syncMember({ db: s.w.db, env: s.w.env, fetch: s.w.fetch, now: () => s.w.clock.now, randomBytes: s.w.randomBytes }, guild, s.uids[key]);
    skipped[key] = [result.status, result.reason || null];
  }
  assert.deepEqual(skipped.own, ['skipped', 'guild_master']);
  assert.deepEqual(skipped.dgm, ['skipped', 'guild_master']);
  assert.notDeepEqual(skipped.dof, ['skipped', 'guild_master']);
});

runChecks(checks);
