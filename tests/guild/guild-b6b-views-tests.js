/**
 * Raidsmith guild tracker - lane B6b of the user-hierarchy build, part 1: the EFFECTIVE ROLES view (migration 0035) and the one Owner definition behind it
 * Run: node tests/guild/guild-b6b-views-tests.js
 *
 * Checked here (plan "Model" > EFFECTIVE ROLES, "Proof", "Owner"):
 *   - the migration is views only; one view per source (stored, ingame, owner) and a top view that UNION ALLs them (at most 5 terms); the role_assignments shape;
 *   - the STORED rows pass through; a stored guild_master row counts only while the guild has neither an Owner seat nor a rank source (review finding B4b/B5 F1);
 *   - the DERIVED roles of an in-game guild: the rank map decides, only rank 0 gives Guild Master, the highest-ranked valid character wins, a Team Lead is held for the team
 *     the character is placed on and for nothing when it has none;
 *   - the validity of a proof: an officer's or a hand proof, a proof of another account, a key off the roster, a Battle.net link that was removed or replaced, a person with no
 *     account: each grants nothing; the link back restores it;
 *   - stored roles survive a rank change; derived roles come and go with the rank;
 *   - the Owner: ONE definition, the owner row of the view; isOwner (SQL, through the helper), the view and the pure mirror ownerOf agree on a matrix of seat holder /
 *     suspended Owner / derived Guild Master / stored Guild Master before and after the flip.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { DEFAULT_MAP, flip, makeProven, rolesOf, setMap } = require('../guild-ingame');

const ROOT = path.join(__dirname, '..', '..');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  return s;
}
// An account with a person linked to it (a member by the legacy rule while the guild is legacy).
async function account(s, key, name, extra = {}) {
  await s.member(key, name);
  const made = await s.person({ name, ...extra });
  await s.link(made.pid, key);
  return made;
}
const sql = (s) => s.w.db.sqlite;
const rows = (s, text, ...values) => sql(s).prepare(text).all(...values).map((row) => ({ ...row }));

// ---------------------------------------------------------------------------
// 1. The views

check('migration 0035 is views only; the views are one per source plus a top view of at most 5 terms, with the role_assignments shape', async () => {
  const text = fs.readFileSync(path.join(ROOT, 'migrations', '0035_effective_roles.sql'), 'utf8').split(/\r?\n/).filter((line) => !/^\s*--/.test(line)).join('\n');
  const statements = text.split(';').map((statement) => statement.trim()).filter(Boolean);
  assert(statements.length > 5);
  for (const statement of statements) assert(/^(DROP VIEW IF EXISTS|CREATE VIEW)\b/.test(statement), `views only: ${statement.slice(0, 60)}`);
  const s = await world();
  const views = rows(s, "SELECT name, sql FROM sqlite_master WHERE type = 'view' AND (name LIKE 'effective_roles%' OR name = 'ingame_proven_characters') ORDER BY name");
  assert.deepEqual(views.map((view) => view.name), ['effective_roles', 'effective_roles_ingame', 'effective_roles_owner', 'effective_roles_stored', 'ingame_proven_characters']);
  const top = views.find((view) => view.name === 'effective_roles');
  assert.equal((top.sql.match(/UNION ALL/g) || []).length + 1, 3, 'one term per source view');
  assert((top.sql.match(/UNION ALL/g) || []).length + 1 <= 5, 'D1 allows 5 terms in a compound SELECT');
  for (const view of views) assert((view.sql.match(/\bUNION\b/gi) || []).length + 1 <= 5, `${view.name}: at most 5 terms`);
  assert.deepEqual(rows(s, 'PRAGMA table_info(effective_roles)').map((column) => column.name), ['guild_id', 'user_id', 'role_id', 'team_id', 'source']);
  assert.deepEqual(rows(s, 'PRAGMA table_info(effective_roles_stored)').map((column) => column.name), ['guild_id', 'user_id', 'role_id', 'team_id', 'source', 'id', 'assigned_at']);
});

check('a stored row passes through with its source; a stored guild_master row counts only while the guild has neither a seat nor a rank source', async () => {
  const s = await world();
  await s.officer('off', 'Officerone');
  await s.member('mem', 'Plainmember');
  // The Discord sync's row keeps its source.
  sql(s).prepare("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('ra_disc', ?, ?, 'officer', NULL, 'discord', 1)").run(s.gid, s.uids.mem);
  // Before the flip: the stored Guild Master IS the Owner, so it shows twice (the stored row and the Owner's row).
  assert.deepEqual(rolesOf(s, 'gm'), [['guild_master', null, 'manual'], ['guild_master', null, 'owner']]);
  assert.deepEqual(rolesOf(s, 'off'), [['officer', null, 'manual']]);
  assert.deepEqual(rolesOf(s, 'mem'), [['officer', null, 'discord']]);
  // The seat set (a hand-over, a guild created without Discord): the stored row stops counting, the seat holder is the Owner.
  await s.setOwner('mem');
  assert.deepEqual(rolesOf(s, 'gm'), []);
  assert.deepEqual(rolesOf(s, 'mem'), [['guild_master', null, 'owner'], ['officer', null, 'discord']]);
  // A rank source with no seat: nobody holds a stored Guild Master row any more.
  await s.setOwner(null);
  for (const source of ['manual', 'ingame', 'someday']) {
    sql(s).prepare('UPDATE guilds SET rank_source = ? WHERE id = ?').run(source, s.gid);
    assert.deepEqual(rolesOf(s, 'gm'), [], `rank_source ${source}: the stored Guild Master row counts for nothing`);
    assert.equal(rows(s, "SELECT 1 FROM effective_roles WHERE guild_id = ? AND role_id = 'guild_master'", s.gid).length, 0, `${source}: no Guild Master at all`);
  }
  sql(s).prepare('UPDATE guilds SET rank_source = NULL WHERE id = ?').run(s.gid);
  assert.deepEqual(rolesOf(s, 'gm'), [['guild_master', null, 'manual'], ['guild_master', null, 'owner']], 'back to a legacy guild');
  // Another guild never leaks in.
  assert.equal(rows(s, 'SELECT 1 FROM effective_roles WHERE guild_id = ?', 'g_other').length, 0);
});

// ---------------------------------------------------------------------------
// 2. The derived roles

check('derived roles: the rank map gives Officer, Team Lead (for the placed team), a guild\'s own role and, at rank 0 only, Guild Master; a rank with no row or no role gives nothing', async () => {
  const s = await world();
  const made = {
    a0: await account(s, 'a0', 'Rankzero'),
    a1: await account(s, 'a1', 'Rankone'),
    a2t: await account(s, 'a2t', 'Ranktwoteam'),
    a2n: await account(s, 'a2n', 'Ranktwonone', { teamId: null }),
    a3: await account(s, 'a3', 'Rankthree'),
    a9: await account(s, 'a9', 'Ranknine'),
    a4c: await account(s, 'a4c', 'Rankcustom'),
  };
  await s.ok('gm', 'POST', '/roles', { name: 'Loot council', permissions: { 'loot.edit': 'guild' } }, 201);
  const customId = (await s.one('SELECT id FROM roles WHERE guild_id = ? AND name = ?', s.gid, 'Loot council')).id;
  const ranks = { a0: 0, a1: 1, a2t: 2, a2n: 2, a3: 3, a9: 9, a4c: 4 };
  for (const [key, rank] of Object.entries(ranks)) makeProven(s, key, made[key], { rank });
  const map = [
    { rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }, { rank: 1, label: 'Officer', coreRank: 'raider', roleId: 'officer' },
    { rank: 2, label: 'Raid Assistant', coreRank: 'raider', roleId: 'team_lead' }, { rank: 3, label: 'Core', coreRank: 'raider', roleId: null },
    { rank: 4, label: 'Council', coreRank: 'raider', roleId: customId },
  ]; // rank 9 has no row
  flip(s, { owner: null, map });
  assert.deepEqual(rolesOf(s, 'a0'), [['guild_master', null, 'ingame']], 'rank 0 -> Guild Master, derived: not the Owner');
  assert.deepEqual(rolesOf(s, 'a1'), [['officer', null, 'ingame']]);
  assert.deepEqual(rolesOf(s, 'a2t'), [['team_lead', s.alpha, 'ingame']], 'Team Lead of the team the character is placed on');
  assert.deepEqual(rolesOf(s, 'a2n'), [], 'a Team Lead character with no team gives no team role');
  assert.deepEqual(rolesOf(s, 'a3'), [], 'a map row with no role');
  assert.deepEqual(rolesOf(s, 'a9'), [], 'a rank with no map row');
  assert.deepEqual(rolesOf(s, 'a4c'), [[customId, null, 'ingame']], 'a role of the guild\'s own');
  // Nobody is the Owner by derivation, whatever the rank.
  assert.equal(rows(s, "SELECT 1 FROM effective_roles WHERE guild_id = ? AND source = 'owner'", s.gid).length, 0);
  // A team-scoped role follows the character: moving it to another team moves the role.
  sql(s).prepare('UPDATE characters SET team_id = ? WHERE id = ?').run(s.bravo, made.a2t.cid);
  assert.deepEqual(rolesOf(s, 'a2t'), [['team_lead', s.bravo, 'ingame']]);
  sql(s).prepare('UPDATE characters SET team_id = NULL WHERE id = ?').run(made.a2t.cid);
  assert.deepEqual(rolesOf(s, 'a2t'), []);
  // The table's own CHECK refuses a Guild Master map row for any rank but 0, and the view repeats the rule for a row that got past it.
  assert.throws(() => sql(s).prepare("INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES (?, 'ingame', '5', 'Sneaky', 'raider', 'guild_master')").run(s.gid), /CHECK/);
  sql(s).exec('PRAGMA ignore_check_constraints = ON');
  sql(s).prepare("INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES (?, 'ingame', '5', 'Sneaky', 'raider', 'guild_master')").run(s.gid);
  sql(s).exec('PRAGMA ignore_check_constraints = OFF');
  makeProven(s, 'a3', made.a3, { rank: 5 });
  assert.deepEqual(rolesOf(s, 'a3'), [], 'rank 5 -> guild_master never reaches the view');
  // Only an in-game guild derives anything.
  sql(s).prepare("UPDATE guilds SET rank_source = 'manual' WHERE id = ?").run(s.gid);
  assert.deepEqual(rolesOf(s, 'a1'), []);
  sql(s).prepare("UPDATE guilds SET rank_source = NULL WHERE id = ?").run(s.gid);
  assert.deepEqual(rolesOf(s, 'a1'), []);
});

check('the highest-ranked valid character wins; characters tied at the best rank all count; a lower-ranked character never adds a role', async () => {
  const s = await world();
  const x = await account(s, 'x', 'Officermain', { teamId: null });     // rank 1 main, rank 2 alt on Alpha: Officer only
  const y = await account(s, 'y', 'Plainmain');                          // rank 3 main on Alpha, rank 2 alt on Bravo: Team Lead of Bravo
  const z = await account(s, 'z', 'Leadalpha');                          // rank 2 main on Alpha, rank 2 alt on Bravo: Team Lead of both
  const w = await account(s, 'w', 'Twoofficers', { teamId: null });      // two rank 1 characters: ONE Officer row
  const v = await account(s, 'v', 'Leaderless', { teamId: null });   // rank 2 main with no team, rank 3 alt: nothing (the best character has no team)
  const alt = async (made, name, team) => {
    const id = await s.alt(made.pid, name);
    if (team) s.setTeam(id, team);
    return { cid: id };
  };
  makeProven(s, 'x', x, { rank: 1 });
  makeProven(s, 'x', await alt(x, 'Officeralt', s.alpha), { rank: 2 });
  makeProven(s, 'y', y, { rank: 3 });
  makeProven(s, 'y', await alt(y, 'Plainalt', s.bravo), { rank: 2 });
  makeProven(s, 'z', z, { rank: 2 });
  makeProven(s, 'z', await alt(z, 'Leadbravo', s.bravo), { rank: 2 });
  makeProven(s, 'w', w, { rank: 1 });
  makeProven(s, 'w', await alt(w, 'Twoofficersb'), { rank: 1 });
  makeProven(s, 'v', v, { rank: 2 });
  makeProven(s, 'v', await alt(v, 'Teamlessalt'), { rank: 3 });
  flip(s, { owner: null });
  assert.deepEqual(rolesOf(s, 'x'), [['officer', null, 'ingame']]);
  assert.deepEqual(rolesOf(s, 'y'), [['team_lead', s.bravo, 'ingame']]);
  assert.deepEqual(rolesOf(s, 'z'), [['team_lead', s.alpha, 'ingame'], ['team_lead', s.bravo, 'ingame']].sort());
  assert.deepEqual(rolesOf(s, 'w'), [['officer', null, 'ingame']], 'a view row per role and team, not per character');
  assert.deepEqual(rolesOf(s, 'v'), []);
});

// ---------------------------------------------------------------------------
// 3. Validity of a proof

check('only a VALID Battle.net proof derives anything: officer and hand proofs, another account\'s proof, a key off the roster, a removed or replaced link, a person with no account grant nothing', async () => {
  const s = await world();
  const made = await account(s, 'sub', 'Subjectone');
  makeProven(s, 'sub', made, { rank: 1, id: 9101, bnetId: 770001 });
  flip(s, { owner: null });
  const holds = () => rolesOf(s, 'sub').length === 1;
  const mutate = (label, change, undo) => {
    assert.equal(holds(), true, `${label}: holds before`);
    sql(s).exec(change);
    assert.equal(holds(), false, `${label}: grants nothing`);
    sql(s).exec(undo);
    assert.equal(holds(), true, `${label}: and holds again once restored`);
  };
  const cid = made.cid;
  mutate('an officer proof', `UPDATE characters SET owner_proof = 'officer' WHERE id = '${cid}'`, `UPDATE characters SET owner_proof = 'bnet' WHERE id = '${cid}'`);
  mutate('a hand proof', `UPDATE characters SET owner_proof = 'hand' WHERE id = '${cid}'`, `UPDATE characters SET owner_proof = 'bnet' WHERE id = '${cid}'`);
  mutate('no proof at all', `UPDATE characters SET owner_proof = NULL WHERE id = '${cid}'`, `UPDATE characters SET owner_proof = 'bnet' WHERE id = '${cid}'`);
  mutate('(a) a proof of another account', `UPDATE characters SET proof_user_id = '${s.uids.gm}' WHERE id = '${cid}'`, `UPDATE characters SET proof_user_id = '${s.uids.sub}' WHERE id = '${cid}'`);
  mutate('(a) a proof with no account', `UPDATE characters SET proof_user_id = NULL WHERE id = '${cid}'`, `UPDATE characters SET proof_user_id = '${s.uids.sub}' WHERE id = '${cid}'`);
  mutate('(b) a key that left the roster', `DELETE FROM guild_roster WHERE guild_id = '${s.gid}' AND blizzard_char_id = 9101`,
    `INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES ('${s.gid}', 'profile-classicann-us', 4001, 9101, 'Back', 'back', 'r', 'MAGE', 70, 1)`);
  mutate('(b) a key of another namespace', `UPDATE characters SET namespace = 'profile-classic-eu' WHERE id = '${cid}'`, `UPDATE characters SET namespace = 'profile-classicann-us' WHERE id = '${cid}'`);
  mutate('(d) a removed Battle.net link', `DELETE FROM bnet_links WHERE user_id = '${s.uids.sub}'`,
    `INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('${s.uids.sub}', '770001', 'Sub#1', 1, '{}', 1)`);
  mutate('(d) a replaced Battle.net link', `UPDATE bnet_links SET bnet_account_id = '770099' WHERE user_id = '${s.uids.sub}'`, `UPDATE bnet_links SET bnet_account_id = '770001' WHERE user_id = '${s.uids.sub}'`);
  mutate('(d) a proof with no Battle.net id', `UPDATE characters SET proof_bnet_account_id = NULL WHERE id = '${cid}'`, `UPDATE characters SET proof_bnet_account_id = '770001' WHERE id = '${cid}'`);
  // The Battle.net account of another user does not do (the link must be the person's account's own).
  sql(s).exec(`UPDATE bnet_links SET user_id = '${s.uids.gm}' WHERE user_id = '${s.uids.sub}'`);
  assert.equal(holds(), false, 'the link belongs to another account');
  sql(s).exec(`UPDATE bnet_links SET user_id = '${s.uids.sub}' WHERE user_id = '${s.uids.gm}'`);
  assert.equal(holds(), true);
  // An unowned person: the trigger clears the proof with the link (the unlink writer does the same); even with the proof columns left behind nothing is derived.
  sql(s).exec('DROP TRIGGER players_user_change_clears_proof');
  sql(s).exec(`UPDATE players SET user_id = NULL WHERE id = '${made.pid}'`);
  assert.equal(rows(s, 'SELECT * FROM effective_roles WHERE guild_id = ? AND user_id = ?', s.gid, s.uids.sub).length, 0, 'an unowned person');
  assert.equal(rows(s, "SELECT * FROM effective_roles WHERE guild_id = ? AND source = 'ingame'", s.gid).length, 0, 'and no row for an account that is NULL');
  // A deleted account: its rows go and nothing is left behind (no error).
  sql(s).exec(`UPDATE players SET user_id = '${s.uids.sub}' WHERE id = '${made.pid}'`);
  assert.equal(holds(), true);
  sql(s).exec(`DELETE FROM users WHERE id = '${s.uids.sub}'`);
  assert.equal(rows(s, "SELECT * FROM effective_roles WHERE guild_id = ? AND source = 'ingame'", s.gid).length, 0, 'a deleted account');
});

check('an officer-proven or hand-proven character that is bound to the roster gives membership and its rank, never a derived role', async () => {
  const s = await world();
  const officer = await account(s, 'ofp', 'Officerproof');
  const hand = await account(s, 'hap', 'Handproof');
  makeProven(s, 'ofp', officer, { rank: 1, proof: 'officer' });
  makeProven(s, 'hap', hand, { rank: 0, proof: 'hand' });
  flip(s, { owner: null });
  assert.deepEqual(rolesOf(s, 'ofp'), []);
  assert.deepEqual(rolesOf(s, 'hap'), []);
  // They are members all the same (the roster rule), with the plain Member rank.
  assert.equal((await s.call('ofp', 'GET', '')).status, 200);
  const hap = await s.ok('hap', 'GET', '');
  assert.deepEqual(hap.me.roles, []);
  // The rank map's Guild Master at rank 0 does not make a hand-proven account a Guild Master.
  assert.equal(rows(s, "SELECT 1 FROM effective_roles WHERE guild_id = ? AND role_id = 'guild_master'", s.gid).length, 0);
});

check('a stored Officer survives a rank change; a derived role comes and goes with the rank; the chip says where a role comes from', async () => {
  const s = await world();
  const made = await account(s, 'surv', 'Survivor');
  await s.member('boss', 'Bossman');
  makeProven(s, 'surv', made, { rank: 5, id: 9201 });
  sql(s).prepare("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('ra_surv', ?, ?, 'officer', NULL, 'manual', 1)").run(s.gid, s.uids.surv);
  flip(s, { owner: null });
  const setRank = (rank) => sql(s).prepare('UPDATE guild_roster SET rank = ? WHERE guild_id = ? AND blizzard_char_id = 9201').run(rank, s.gid);
  assert.deepEqual(rolesOf(s, 'surv'), [['officer', null, 'manual']], 'rank 5 gives no role: the stored Officer stays');
  setRank(1);
  assert.deepEqual(rolesOf(s, 'surv'), [['officer', null, 'ingame'], ['officer', null, 'manual']], 'promoted: both');
  assert.deepEqual((await s.ok('surv', 'GET', '')).me.roles, [{ role: 'officer' }], 'one chip, as theirs (the hand wins over the rank)');
  setRank(5);
  assert.deepEqual(rolesOf(s, 'surv'), [['officer', null, 'manual']], 'demoted: the derived row goes, the stored one is untouched');
  sql(s).prepare('DELETE FROM role_assignments WHERE id = ?').run('ra_surv');
  setRank(1);
  assert.deepEqual(rolesOf(s, 'surv'), [['officer', null, 'ingame']]);
  assert.deepEqual((await s.ok('surv', 'GET', '')).me.roles, [{ role: 'officer', fromRank: true }], 'derived only: the chip says it comes from the rank');
  setRank(5);
  assert.deepEqual(rolesOf(s, 'surv'), []);
});

// ---------------------------------------------------------------------------
// 4. The Owner: one definition, three readers

// What the database says about the proof of the seat holder, computed straight from the rows (not through the views): a VALID Battle.net-proven character on the stored roster.
function hasValidProvenCharacter(s, userId) {
  if (!userId) return false;
  const found = rows(s,
    `SELECT c.owner_proof, c.proof_user_id, c.proof_bnet_account_id, c.namespace, c.blizzard_realm_id, c.blizzard_char_id, p.user_id AS owner_id
       FROM characters c JOIN players p ON p.id = c.player_id WHERE p.guild_id = ?`, s.gid);
  return found.some((row) => {
    if (row.owner_proof !== 'bnet' || !row.proof_user_id || row.proof_user_id !== row.owner_id || row.owner_id !== userId) return false;
    const onRoster = rows(s, 'SELECT 1 FROM guild_roster WHERE guild_id = ? AND namespace = ? AND blizzard_realm_id = ? AND blizzard_char_id = ?',
      s.gid, row.namespace, row.blizzard_realm_id, row.blizzard_char_id).length === 1;
    const link = rows(s, 'SELECT bnet_account_id FROM bnet_links WHERE user_id = ?', userId)[0];
    return onRoster && !!link && link.bnet_account_id === row.proof_bnet_account_id;
  });
}

check('PARITY: isOwner (SQL, through the helper), ownerSql, the owner row of the view and the pure mirror ownerOf agree on every account of a matrix of seat holder / suspended Owner / derived Guild Master / stored Guild Master, before and after the flip', async () => {
  const { isOwner, ownerGuard, ownerOf, ownerSql, ownerCandidatesSql, ownedGuildsSql, hasOwnerSql } = await load('worker/owner.js');
  const s = await world();
  const people = {};
  for (const [key, name] of [['a', 'Seatholder'], ['b', 'Otheraccount'], ['c', 'Thirdaccount']]) people[key] = await account(s, key, name);
  sql(s).exec('DELETE FROM source_rank_maps');
  setMap(s, DEFAULT_MAP);
  const keys = ['gm', 'a', 'b', 'c'];
  const state = (over) => sql(s).prepare('UPDATE guilds SET rank_source = ?, owner_user_id = ? WHERE id = ?').run(over.source === undefined ? null : over.source, over.seat ? s.uids[over.seat] : null, s.gid);
  const storedGm = (holder) => {
    sql(s).prepare("DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'").run(s.gid);
    if (holder) sql(s).prepare("INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('ra_gmx', ?, ?, 'guild_master', NULL, 'manual', 1)").run(s.gid, s.uids[holder]);
  };
  const cases = [];
  const scene = (name, setup) => cases.push({ name, setup });
  scene('legacy guild, stored Guild Master gm', () => { storedGm('gm'); state({}); });
  scene('legacy guild, seat on a, stored Guild Master still gm', () => { storedGm('gm'); state({ seat: 'a' }); });
  scene('legacy guild, seat on a, no stored row', () => { storedGm(null); state({ seat: 'a' }); });
  scene('legacy guild, no seat and no stored row', () => { storedGm(null); state({}); });
  scene('manual guild, seat on a (no suspension there)', () => { storedGm(null); state({ source: 'manual', seat: 'a' }); });
  scene('manual guild, stored Guild Master and no seat', () => { storedGm('gm'); state({ source: 'manual' }); });
  scene('unknown rank source, seat on a', () => { storedGm(null); state({ source: 'someday', seat: 'a' }); });
  scene('in-game guild, seat on a, NO proven character: suspended', () => { storedGm(null); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, seat on a, a valid proven character: live', () => { makeProven(s, 'a', people.a, { rank: 4, id: 9301 }); storedGm(null); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, the stored Guild Master row left behind and no seat', () => { storedGm('gm'); state({ source: 'ingame' }); });
  scene('in-game guild, seat on a (live), derived Guild Master b', () => { makeProven(s, 'b', people.b, { rank: 0, id: 9302 }); storedGm('gm'); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, seat on a (live), stored Guild Master row on gm', () => { storedGm('gm'); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, seat on b (derived Guild Master rank 0 and live)', () => { storedGm(null); state({ source: 'ingame', seat: 'b' }); });
  scene('in-game guild, seat on a, the proof is an officer\'s', () => { sql(s).prepare("UPDATE characters SET owner_proof = 'officer' WHERE player_id = ?").run(people.a.pid); storedGm(null); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, seat on a, proof restored', () => { sql(s).prepare("UPDATE characters SET owner_proof = 'bnet' WHERE player_id = ?").run(people.a.pid); storedGm(null); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, seat on a, the Battle.net link removed', () => { sql(s).prepare('DELETE FROM bnet_links WHERE user_id = ?').run(s.uids.a); storedGm(null); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, seat on a, the link back', () => { sql(s).prepare("INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, 'A#1', 1, '{}', 1)").run(s.uids.a, rows(s, 'SELECT proof_bnet_account_id AS id FROM characters WHERE player_id = ?', people.a.pid)[0].id); storedGm(null); state({ source: 'ingame', seat: 'a' }); });
  scene('in-game guild, seat on a, the key left the roster', () => { sql(s).prepare('DELETE FROM guild_roster WHERE guild_id = ? AND blizzard_char_id = 9301').run(s.gid); storedGm(null); state({ source: 'ingame', seat: 'a' }); });
  scene('legacy again (the guild never flipped), seat on c', () => { storedGm(null); state({ seat: 'c' }); });
  let anyOwner = 0;
  let anySuspended = 0;
  for (const { name, setup } of cases) {
    setup();
    const guild = rows(s, 'SELECT owner_user_id, rank_source FROM guilds WHERE id = ?', s.gid)[0];
    const stored = rows(s, "SELECT user_id FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.gid)[0];
    const owners = [];
    for (const key of keys) {
      const userId = s.uids[key];
      const facts = {
        userId, ownerUserId: guild.owner_user_id, rankSource: guild.rank_source, storedMasterUserId: stored ? stored.user_id : null,
        hasValidProvenCharacter: hasValidProvenCharacter(s, guild.owner_user_id),
      };
      const mirror = ownerOf(facts);
      const viaHelper = await isOwner(s.w.db, s.gid, userId);
      const guard = ownerGuard(s.gid, userId);
      const viaGuard = (await s.w.db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first()).ok === 1;
      const viaFragment = (await s.w.db.prepare(`SELECT ${ownerSql('?1', '?2')} AS ok`).bind(s.gid, userId).first()).ok === 1;
      const viaView = rows(s, "SELECT 1 FROM effective_roles_owner WHERE guild_id = ? AND user_id = ?", s.gid, userId).length > 0;
      const viaTop = rows(s, "SELECT 1 FROM effective_roles WHERE guild_id = ? AND user_id = ? AND source = 'owner'", s.gid, userId).length > 0;
      assert.deepEqual([viaHelper, viaGuard, viaFragment, viaView, viaTop], [mirror, mirror, mirror, mirror, mirror], `${name}: ${key} (JS mirror ${mirror})`);
      if (mirror) owners.push(key);
    }
    assert(owners.length <= 1, `${name}: at most one Owner (${owners.join(', ')})`);
    if (owners.length) anyOwner++;
    if (guild.rank_source === 'ingame' && guild.owner_user_id && !owners.length) anySuspended++;
    // The candidate sets are supersets that contain the Owner, and the guild has an Owner exactly when someone passes.
    const candidates = rows(s, `SELECT user_id FROM (${ownerCandidatesSql('?1')})`, s.gid).map((row) => row.user_id);
    for (const key of owners) assert(candidates.includes(s.uids[key]), `${name}: the Owner is among the candidates`);
    for (const key of owners) assert(rows(s, `SELECT guild_id FROM (${ownedGuildsSql('?1')})`, s.uids[key]).some((row) => row.guild_id === s.gid), `${name}: the guild is among the Owner's guilds`);
    assert.equal((await s.w.db.prepare(`SELECT ${hasOwnerSql('?1')} AS ok`).bind(s.gid).first()).ok === 1, owners.length > 0 || guild.owner_user_id !== null, `${name}: hasOwnerSql`);
  }
  assert(anyOwner >= 8 && anySuspended >= 4, `the matrix covers Owners (${anyOwner}) and suspended Owners (${anySuspended})`);
});

check('a suspended Owner keeps the seat and nothing else: not an Owner, not a Guild Master, no powers; restored the moment a valid proven character is on the roster; never a member through the seat alone', async () => {
  const s = await world();
  const made = await account(s, 'seat', 'Seatholder');
  makeProven(s, 'seat', made, { rank: 4, id: 9401 });
  flip(s, { owner: 'seat' });
  // Live: the Owner row, Guild Master powers, a member.
  assert.deepEqual(rolesOf(s, 'seat'), [['guild_master', null, 'owner']]);
  const live = await s.ok('seat', 'GET', '');
  assert.deepEqual(live.me.roles, [{ role: 'guild_master' }]);
  assert(live.me.can['guild.roles'] === 'guild');
  // The character leaves the roster: suspended. The account is linked to a person whose character is no longer on the roster, so it is not even a member.
  sql(s).prepare('DELETE FROM guild_roster WHERE guild_id = ? AND blizzard_char_id = 9401').run(s.gid);
  assert.deepEqual(rolesOf(s, 'seat'), []);
  const out = await s.fail('seat', 'GET', '', undefined, 403, 'not_member');
  assert(/roster/.test(out.message));
  assert.equal((await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id, s.uids.seat, 'the seat itself is untouched');
  // Linked to a person with an (officer-proven) character on the roster: a member again, with a Member's powers.
  sql(s).prepare("UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = ?").run(made.cid);
  sql(s).prepare(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES (?, 'profile-classicann-us', 4001, 9401, 'Back', 'back', 'r', 'MAGE', 70, 4)`).run(s.gid);
  const member = await s.ok('seat', 'GET', '');
  assert.deepEqual(member.me.roles, []);
  assert.equal(member.me.can['guild.roles'], undefined);
  // The proof comes back: restored.
  sql(s).prepare("UPDATE characters SET owner_proof = 'bnet', proof_user_id = ?, proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = ?) WHERE id = ?").run(s.uids.seat, s.uids.seat, made.cid);
  assert.deepEqual(rolesOf(s, 'seat'), [['guild_master', null, 'owner']]);
  assert((await s.ok('seat', 'GET', '')).me.can['guild.roles'] === 'guild');
});

runChecks(checks);
