/**
 * Raidsmith guild tracker - lane B4b of the user-hierarchy build: the in-game rank map, its dry-run token and applyRankMap (worker/rank-map.js, worker/dry-run.js,
 * worker/routes/rank-map.js)
 * Run: node tests/guild/guild-b4b-rankmap-tests.js
 *
 *   - the map: ten ranks at most, each a name, a core rank and a permission role; ONLY rank 0 may map to Guild Master (400 rank_zero_only; the table's CHECK is the backstop);
 *   - the change goes through a dry run: the token is bound to the approver, the proposed map, the characters it would move, the stored roster and 10 minutes, is single
 *     use, and is consumed inside the apply batch (a token of another account, for another map, after the state moved, expired, replayed, or for another purpose is refused);
 *   - the apply is ONE atomic batch (token, marker, map, applyRankMap, audit with the approver);
 *   - applyRankMap: a rank with no map row = Social until mapped; a character off the stored roster = Social; entering or leaving Trial clears the trial dates; the changed
 *     characters' raids are marked stale; while the guild's rank source is not 'ingame' the map is stored and no character changes;
 *   - the every-rank-mapped gate (assertRankMapComplete, for lane B9's flip) and the Owner's unmapped-rank attention item;
 *   - the officer rank edit is refused in an 'ingame' guild and still works in the others.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const NS = 'profile-classicann-us';
const TOKEN_TTL = 10 * 60 * 1000;
const VINDICATED = [
  { rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' },
  { rank: 1, label: 'Raid Leader', coreRank: 'raider', roleId: 'officer' },
  { rank: 2, label: 'Raid Assistant', coreRank: 'raider', roleId: 'team_lead' },
  { rank: 3, label: 'Core Raider', coreRank: 'raider', roleId: null },
  { rank: 4, label: 'Raider', coreRank: 'raider', roleId: null },
  { rank: 5, label: 'Member', coreRank: 'social', roleId: null },
];

async function M() { return load('worker/rank-map.js'); }

// A guild whose Owner is the Guild Master (legacy rule), with a second account 'own' for the seat moves.
async function world({ ingame = true } = {}) {
  const s = await scenario();
  await s.member('own', 'Ownerseat');
  await s.officer('off', 'Officerone');
  if (ingame) s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  s.nextId = 9000;
  // The stored in-game roster: rows { name, rank, id? } -> guild_roster.
  s.setRoster = (rows) => {
    s.exec(`DELETE FROM guild_roster WHERE guild_id = '${s.gid}'`);
    for (const row of rows) {
      s.exec(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
              VALUES ('${s.gid}', '${NS}', 4001, ${row.id}, '${row.name}', '${row.name.toLowerCase()}', 'nightslayer', 'MAGE', 70, ${row.rank})`);
    }
  };
  // A person with a Main on team 0 whose character carries the identity key `id` (null = a hand-added character with none).
  s.bound = async (name, id, body = {}) => {
    const made = await s.person({ name, ...body });
    if (id !== null) s.exec(`UPDATE characters SET namespace = '${NS}', blizzard_realm_id = 4001, blizzard_char_id = ${id} WHERE id = '${made.cid}'`);
    return made;
  };
  s.rankOf = async (name) => (await s.one('SELECT core_rank, left_on, trial_start, trial_end, updated_at FROM characters WHERE name = ?', name));
  s.dry = (ranks, who = 'gm') => s.ok(who, 'POST', '/rank-map/dry-run', { ranks }, 200);
  s.put = (ranks, token, who = 'gm', status = 200) => s.call(who, 'PUT', '/rank-map', { ranks, token }).then((res) => {
    assert.equal(res.status, status, `PUT /rank-map answered ${res.status}: ${res.text}`);
    return res.json;
  });
  s.apply = async (ranks, who = 'gm') => {
    const dry = await s.dry(ranks, who);
    return { dry, applied: await s.put(ranks, dry.token, who) };
  };
  s.mapRows = () => s.rows('SELECT source_key, label, core_rank, role_id FROM source_rank_maps WHERE guild_id = ? ORDER BY CAST(source_key AS INTEGER)', s.gid);
  return s;
}

// ---------------------------------------------------------------------------
// The map

const ONE_RANK = [{ rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }];

check('gate: the rank map (read, dry run, change) is the Owner\'s - a derived Guild Master and an Officer are refused on all three; the Owner is allowed on all three', async () => {
  const s = await world();
  await s.setOwner('own');
  for (const who of ['gm', 'off']) {
    await s.fail(who, 'GET', '/rank-map', undefined, 403, 'forbidden');
    await s.fail(who, 'POST', '/rank-map/dry-run', { ranks: ONE_RANK }, 403, 'forbidden');
    await s.fail(who, 'PUT', '/rank-map', { ranks: ONE_RANK, token: 'x'.repeat(43) }, 403, 'forbidden');
  }
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 0, 'a refused dry run leaves no token');
  assert.equal((await s.rows('SELECT source_key FROM source_rank_maps')).length, 0);
  // The Owner: allowed (the account holding the seat is a plain member by role, so the seat alone decides).
  const map = await s.ok('own', 'GET', '/rank-map', undefined, 200);
  assert.equal(map.ranks.length, 10);
  const dry = await s.ok('own', 'POST', '/rank-map/dry-run', { ranks: ONE_RANK }, 200);
  assert(typeof dry.token === 'string' && dry.token.length >= 40);
  await s.ok('own', 'PUT', '/rank-map', { ranks: ONE_RANK, token: dry.token }, 200);
  assert.equal((await s.rows('SELECT source_key FROM source_rank_maps')).length, 1);
});


check('normalizeRankMap: ten ranks at most, each with a name, a core rank and a role; only rank 0 may be Guild Master; custom roles only when the guild has them', async () => {
  const { normalizeRankMap } = await M();
  const ok = [{ rank: 4, label: '  Raider   one ', coreRank: 'raider', roleId: null }, { rank: 0, label: 'GM', coreRank: 'raider', roleId: 'guild_master' }, { rank: 9, label: 'Alt', coreRank: 'social' }];
  assert.deepEqual(normalizeRankMap(ok), [
    { rank: 0, label: 'GM', coreRank: 'raider', roleId: 'guild_master' }, { rank: 4, label: 'Raider one', coreRank: 'raider', roleId: null }, { rank: 9, label: 'Alt', coreRank: 'social', roleId: null },
  ], 'sorted by rank, names tidied, a missing role is none');
  assert.deepEqual(normalizeRankMap([]), []);
  const problem = (entries, custom) => { try { normalizeRankMap(entries, custom); } catch (error) { return [error.status, error.code, error.extra.field]; } return null; };
  const entry = (over) => ({ rank: 1, label: 'One', coreRank: 'raider', roleId: null, ...over });
  assert.deepEqual(problem('x'), [400, 'bad_request', 'ranks']);
  assert.deepEqual(problem(Array.from({ length: 11 }, (_, rank) => entry({ rank }))), [400, 'bad_request', 'ranks']);
  assert.deepEqual(problem([entry({ rank: 10 })]), [400, 'bad_request', 'ranks[0].rank']);
  assert.deepEqual(problem([entry({ rank: -1 })]), [400, 'bad_request', 'ranks[0].rank']);
  assert.deepEqual(problem([entry({ rank: '1' })]), [400, 'bad_request', 'ranks[0].rank']);
  assert.deepEqual(problem([entry(), entry()]), [400, 'bad_request', 'ranks[1].rank']);
  assert.deepEqual(problem([entry({ label: '' })]), [400, 'bad_request', 'ranks[0].label']);
  assert.deepEqual(problem([entry({ label: 'x'.repeat(65) })]), [400, 'bad_request', 'ranks[0].label']);
  assert.deepEqual(problem([entry({ label: 5 })]), [400, 'bad_request', 'ranks[0].label']);
  assert.deepEqual(problem([entry({ coreRank: 'gold' })]), [400, 'bad_request', 'ranks[0].coreRank']);
  assert.deepEqual(problem([entry({ roleId: 'member' })]), [400, 'bad_request', 'ranks[0].roleId']);
  assert.deepEqual(problem([entry({ roleId: 'guest' })]), [400, 'bad_request', 'ranks[0].roleId']);
  assert.deepEqual(problem([entry({ roleId: 'cr_other' })], ['cr_mine']), [400, 'bad_request', 'ranks[0].roleId']);
  assert.equal(problem([entry({ roleId: 'cr_mine' })], ['cr_mine']), null);
  assert.equal(problem([entry({ roleId: 'officer' })]), null);
  assert.equal(problem([entry({ roleId: 'team_lead' })]), null);
  // Only rank 0: every other rank refuses Guild Master with its own code.
  for (let rank = 1; rank <= 9; rank++) assert.deepEqual(problem([entry({ rank, roleId: 'guild_master' })]), [400, 'rank_zero_only', 'ranks[0].roleId'], `rank ${rank}`);
  assert.equal(problem([entry({ rank: 0, roleId: 'guild_master' })]), null);
});

check('only in-game rank 0 may map to Guild Master: the dry run and the change both answer 400 rank_zero_only for any other rank; the table CHECK refuses it too (the backstop)', async () => {
  const s = await world();
  for (const rank of [1, 3, 9]) {
    const bad = [{ rank, label: 'Sneaky', coreRank: 'raider', roleId: 'guild_master' }];
    const dry = await s.fail('gm', 'POST', '/rank-map/dry-run', { ranks: bad }, 400, 'rank_zero_only');
    assert.equal(dry.field, 'ranks[0].roleId');
    await s.fail('gm', 'PUT', '/rank-map', { ranks: bad, token: 'x'.repeat(43) }, 400, 'rank_zero_only');
  }
  assert.equal((await s.rows('SELECT token_hash FROM dry_run_approvals')).length, 0, 'a refused map mints no token');
  assert.throws(() => s.exec(`INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('${s.gid}', 'ingame', '3', 'Sneaky', 'raider', 'guild_master')`), /CHECK/);
  s.exec(`INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('${s.gid}', 'ingame', '0', 'Guild Master', 'raider', 'guild_master')`);
});

check('GET /rank-map: ten rows (stored or suggested from the Battle.net labels), the members on the stored roster per rank, the ranks without a row, the choices', async () => {
  const s = await world();
  s.exec(`UPDATE guilds SET bnet_rank_labels = '["Boss","Right hand"]' WHERE id = '${s.gid}'`);
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }, { name: 'Btwo', rank: 3, id: 9001 }, { name: 'Cthree', rank: 3, id: 9002 }, { name: 'Dfour', rank: 7, id: 9003 }]);
  await s.apply([{ rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }, { rank: 3, label: 'Core', coreRank: 'raider', roleId: 'officer' }]);
  const map = await s.ok('gm', 'GET', '/rank-map', undefined, 200);
  assert.equal(map.ranks.length, 10);
  assert.deepEqual(map.ranks.slice(0, 4).map((r) => [r.rank, r.mapped, r.label, r.coreRank, r.roleId, r.members]), [
    [0, true, 'Guild Master', 'raider', 'guild_master', 1], [1, false, 'Right hand', null, null, 0], [2, false, 'Rank 2', null, null, 0], [3, true, 'Core', 'raider', 'officer', 2],
  ]);
  assert.deepEqual(map.unmapped, [{ rank: 7, members: 1 }]);
  assert.equal(map.complete, false);
  assert.deepEqual([map.source, map.rankSource, map.applies], ['ingame', 'ingame', true]);
  assert.deepEqual(map.coreRanks.map((c) => c.id), ['raider', 'trial', 'reserve', 'social']);
  assert.deepEqual(map.roles.map((r) => [r.id, r.rankZeroOnly || false]), [['officer', false], ['team_lead', false], ['guild_master', true]]);
  assert.equal(map.rosterSyncId, null, 'no good sync has stored this roster');
});

// ---------------------------------------------------------------------------
// The dry run and its token

check('dry run: a diff of the map and of the characters it would move, one token, stored only as a hash and bound to the approver for ten minutes; nothing else is written', async () => {
  const s = await world();
  await s.bound('Aone', 9000);
  await s.bound('Btwo', 9001);
  await s.bound('Cthree', null);
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }, { name: 'Btwo', rank: 4, id: 9001 }]);
  const before = { characters: await s.rows('SELECT id, core_rank, updated_at FROM characters ORDER BY id'), audit: (await s.rows('SELECT id FROM audit_log')).length };
  const dry = await s.dry(VINDICATED);
  assert(/^[A-Za-z0-9_-]{43}$/.test(dry.token));
  assert.equal(dry.expiresAt, s.w.clock.now + TOKEN_TTL);
  assert.deepEqual(dry.changes.map.map((c) => [c.rank, c.change]), VINDICATED.map((v) => [v.rank, 'added']));
  // Aone and Btwo are Raiders on the roster (stay Raiders); Cthree is on no roster: Social.
  assert.deepEqual(dry.changes.characters.transitions, [{ from: 'raider', to: 'social', count: 1 }]);
  assert.deepEqual([dry.changes.characters.changed, dry.changes.characters.becomesTrial, dry.changes.characters.becomesSocial], [1, 0, 1]);
  assert.deepEqual(dry.changes.characters.samples, [{ name: 'Cthree', from: 'raider', to: 'social' }]);
  assert.deepEqual(dry.unmapped, []);
  assert.equal(dry.applies, true);
  const rows = await s.rows('SELECT * FROM dry_run_approvals');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].guild_id, rows[0].approver_user_id, rows[0].used_at, rows[0].created_at, rows[0].expires_at, rows[0].roster_sync_id], [s.gid, s.uids.gm, null, s.w.clock.now, s.w.clock.now + TOKEN_TTL, '']);
  assert(rows[0].map_hash.startsWith('rankmap:'));
  assert(!JSON.stringify(rows).includes(dry.token), 'the token itself is never stored');
  assert.equal((await s.one('SELECT COUNT(*) AS n FROM source_rank_maps')).n, 0, 'the dry run changed no map');
  assert.deepEqual({ characters: await s.rows('SELECT id, core_rank, updated_at FROM characters ORDER BY id'), audit: (await s.rows('SELECT id FROM audit_log')).length }, before, 'nor any character, nor the log');
});

check('apply: the token is consumed inside the batch, the map is replaced, the audit row names the approver; a replay of the same token is refused and changes nothing', async () => {
  const s = await world();
  await s.bound('Aone', 9000);
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }]);
  const missing = await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED }, 400, 'approval_required');
  assert.equal(missing.field, 'token');
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: 'not-a-token' }, 409, 'approval_invalid');
  assert.deepEqual(await s.mapRows(), []);
  const dry = await s.dry(VINDICATED);
  const applied = await s.put(VINDICATED, dry.token);
  assert.deepEqual(applied.applied, { mapRows: 6, characters: 0 });
  assert.deepEqual((await s.mapRows()).map((r) => [r.source_key, r.label, r.core_rank, r.role_id]), VINDICATED.map((v) => [String(v.rank), v.label, v.coreRank, v.roleId]));
  assert.equal(applied.ranks[0].mapped, true);
  assert.equal(applied.complete, true);
  const used = await s.one('SELECT used_at FROM dry_run_approvals');
  assert.equal(used.used_at, s.w.clock.now);
  const audit = await s.rows("SELECT actor_user_id, entity_id, before, after FROM audit_log WHERE action = 'rank_map.update'");
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor_user_id, audit[0].entity_id, JSON.parse(audit[0].before), JSON.parse(audit[0].after).approverUserId], [s.uids.gm, s.gid, { ranks: 0 }, s.uids.gm]);
  // A replay: refused, the map and the log stay as they are; a different map with the used token is refused as well.
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token }, 409, 'approval_invalid');
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED.slice(0, 2), token: dry.token }, 409, 'approval_invalid');
  assert.equal((await s.mapRows()).length, 6);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'rank_map.update'")).length, 1);
});

check('the token is bound to the approver: another account\'s token is refused, and the refusal does not burn it', async () => {
  const s = await world();
  const dry = await s.dry(VINDICATED);
  // The seat moves to 'own'; their request carries the Guild Master's token.
  await s.setOwner('own');
  await s.fail('own', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token }, 409, 'approval_invalid');
  assert.deepEqual(await s.mapRows(), []);
  assert.equal((await s.one('SELECT used_at FROM dry_run_approvals')).used_at, null, 'still unused');
  // The approver is not the Owner any more: refused at the gate. Back on the seat, the same token works.
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token }, 403, 'forbidden');
  await s.setOwner('gm');
  await s.put(VINDICATED, dry.token);
  assert.equal((await s.mapRows()).length, 6);
  // The check also sits INSIDE the batch: an approval row whose approver is another account never consumes.
  const { approvalProblem } = await load('worker/dry-run.js');
  const row = { guild_id: 'g', approver_user_id: 'u_a', map_hash: 'h', roster_sync_id: '', expires_at: 10, used_at: null };
  const ask = (over) => approvalProblem(row, { guildId: 'g', approverUserId: 'u_a', stateHash: 'h', rosterSyncId: '', now: 5, ...over });
  assert.equal(ask({}), null);
  assert.equal(ask({ approverUserId: 'u_b' }), 'invalid');
  assert.equal(ask({ guildId: 'g2' }), 'invalid');
  assert.equal(ask({ now: 10 }), 'invalid');
  assert.equal(ask({ stateHash: 'other' }), 'stale');
  assert.equal(ask({ rosterSyncId: 'rs_1' }), 'stale');
  assert.equal(approvalProblem(null, { guildId: 'g', approverUserId: 'u_a', stateHash: 'h', rosterSyncId: '', now: 5 }), 'invalid');
  assert.equal(approvalProblem({ ...row, used_at: 3 }, { guildId: 'g', approverUserId: 'u_a', stateHash: 'h', rosterSyncId: '', now: 5 }), 'invalid');
});

check('the token is bound to the state it approved: another map, a moved stored map, moved characters, a new roster sync, another purpose and ten minutes each make it stale or invalid', async () => {
  const s = await world();
  await s.bound('Aone', 9000);
  await s.bound('Btwo', 9001);
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }, { name: 'Btwo', rank: 4, id: 9001 }]);
  const other = VINDICATED.slice(0, 3);
  const unused = async () => (await s.one('SELECT COUNT(*) AS n FROM dry_run_approvals WHERE used_at IS NULL')).n;

  // Another proposed map.
  let dry = await s.dry(VINDICATED);
  await s.fail('gm', 'PUT', '/rank-map', { ranks: other, token: dry.token }, 409, 'approval_stale');
  assert.equal(await unused(), 1, 'a stale refusal leaves the token alone');
  assert.deepEqual(await s.mapRows(), []);
  // The stored map moved under it.
  s.exec(`INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id) VALUES ('${s.gid}', 'ingame', '9', 'Alts', 'social', NULL)`);
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token }, 409, 'approval_stale');
  s.exec(`DELETE FROM source_rank_maps WHERE guild_id = '${s.gid}'`);
  await s.put(VINDICATED, dry.token); // the same token works again once the state is the approved one
  s.exec(`DELETE FROM source_rank_maps WHERE guild_id = '${s.gid}'`);

  // The characters moved (the diff changed).
  dry = await s.dry(VINDICATED);
  s.exec(`UPDATE characters SET core_rank = 'reserve' WHERE name = 'Btwo'`);
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token }, 409, 'approval_stale');
  s.exec(`UPDATE characters SET core_rank = 'raider' WHERE name = 'Btwo'`);

  // A new good sync stored another roster.
  dry = await s.dry(VINDICATED);
  s.exec(`UPDATE guilds SET last_good_sync_id = 'rs_other' WHERE id = '${s.gid}'`);
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token }, 409, 'approval_stale');
  s.exec(`UPDATE guilds SET last_good_sync_id = NULL WHERE id = '${s.gid}'`);

  // Another purpose: an approval minted for the flip (a "flip:" state hash) is no rank-map approval.
  const { insertApprovalStatement, newApprovalToken } = await load('worker/dry-run.js');
  const flip = await newApprovalToken(s.w.randomBytes);
  await insertApprovalStatement(s.w.db, { tokenHash: flip.tokenHash, guildId: s.gid, approverUserId: s.uids.gm, stateHash: 'flip:abc', rosterSyncId: '', now: s.w.clock.now }).run();
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: flip.token }, 409, 'approval_stale');

  // Ten minutes.
  dry = await s.dry(VINDICATED);
  s.w.advance(TOKEN_TTL - 3000);
  const fresh = await s.call('gm', 'GET', '/rank-map');
  assert.equal(fresh.status, 200);
  await s.fail('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token }, 409, 'approval_invalid');
  assert.deepEqual(await s.mapRows(), []);
});

check('the apply is one atomic batch: a failure anywhere leaves the token unused, the map and the characters as they were', async () => {
  const s = await world();
  await s.bound('Aone', 9000);
  await s.bound('Cthree', null);
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }]);
  const dry = await s.dry(VINDICATED);
  const snapshot = async () => ({
    characters: await s.rows('SELECT id, core_rank, updated_at FROM characters ORDER BY id'), maps: await s.mapRows(), used: (await s.one('SELECT used_at FROM dry_run_approvals')).used_at,
    audit: (await s.rows('SELECT id FROM audit_log')).length,
  });
  const before = await snapshot();
  const real = s.w.db.batch.bind(s.w.db);
  const isApply = (statements) => statements.some((statement) => /UPDATE dry_run_approvals SET used_at/.test(statement.sql));
  s.w.db.batch = (statements) => real(isApply(statements) ? [...statements, s.w.db.prepare('INSERT INTO no_such_table VALUES (1)')] : statements);
  const failed = await s.call('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token });
  s.w.db.batch = real;
  assert.equal(failed.status, 500);
  assert.deepEqual(await snapshot(), before);
  // And the Owner seat is checked inside the batch: a seat that moves between the read and the write consumes nothing.
  const racing = (statements) => { if (isApply(statements)) s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.own}' WHERE id = '${s.gid}'`); return real(statements); };
  s.w.db.batch = racing;
  const raced = await s.call('gm', 'PUT', '/rank-map', { ranks: VINDICATED, token: dry.token });
  s.w.db.batch = real;
  assert.deepEqual([raced.status, raced.json.error], [409, 'approval_invalid']);
  assert.deepEqual(await snapshot(), before, 'the token was not consumed and nothing was applied');
  await s.setOwner(null);
  await s.put(VINDICATED, dry.token);
  assert.equal((await s.rows('SELECT source_key FROM source_rank_maps')).length, 6);
});

// ---------------------------------------------------------------------------
// applyRankMap

check('applyRankMap: a character takes the core rank of its in-game rank; a rank with no row, a character off the stored roster and one with no identity key are Social', async () => {
  const s = await world();
  await s.bound('Cmain', 9000);
  await s.bound('Draider', 9001);
  await s.bound('Etrial', 9002);
  await s.bound('Freserve', 9003);
  await s.bound('Gnorow', 9004); // rank 8: on the roster, no map row
  await s.bound('Hgone', 9005); // not on the stored roster
  await s.bound('Ihand', null); // a hand-added character: no identity key
  s.setRoster([
    { name: 'Cmain', rank: 0, id: 9000 }, { name: 'Draider', rank: 4, id: 9001 }, { name: 'Etrial', rank: 5, id: 9002 }, { name: 'Freserve', rank: 6, id: 9003 }, { name: 'Gnorow', rank: 8, id: 9004 },
  ]);
  const map = [
    { rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }, { rank: 4, label: 'Raider', coreRank: 'raider', roleId: null },
    { rank: 5, label: 'Initiate', coreRank: 'trial', roleId: null }, { rank: 6, label: 'Bench', coreRank: 'reserve', roleId: null },
  ];
  const dry = await s.dry(map);
  assert.deepEqual(dry.unmapped, [{ rank: 8, members: 1 }]);
  assert.deepEqual(dry.changes.characters.transitions.map((t) => [t.from, t.to, t.count]), [['raider', 'reserve', 1], ['raider', 'social', 3], ['raider', 'trial', 1]]);
  const applied = await s.put(map, dry.token);
  assert.equal(applied.applied.characters, 5);
  const ranks = Object.fromEntries((await s.rows('SELECT name, core_rank FROM characters')).map((r) => [r.name, r.core_rank]));
  assert.deepEqual(ranks, { Cmain: 'raider', Draider: 'raider', Etrial: 'trial', Freserve: 'reserve', Gnorow: 'social', Hgone: 'social', Ihand: 'social' });
  // Nobody was made Former by this (that is the sync's step): no left date anywhere.
  assert.equal((await s.rows('SELECT name FROM characters WHERE left_on IS NOT NULL')).length, 0);
  // The dry run told the truth.
  assert.equal(applied.unmapped.length, 1);
  assert.equal(applied.complete, false);
  // An edit that maps rank 8 brings the character up in the same apply (every change applies at once).
  const next = [...map, { rank: 8, label: 'Newrank', coreRank: 'raider', roleId: null }];
  const second = await s.apply(next);
  assert.equal(second.applied.applied.characters, 1);
  assert.equal((await s.rankOf('Gnorow')).core_rank, 'raider');
  assert.equal(second.applied.complete, true);
});

check('applyRankMap: a rank change sets updated_at, clears the trial dates (entering Trial restarts the clock, leaving it ends it) and leaves an unchanged character alone', async () => {
  const s = await world();
  await s.bound('Aleader', 9000);
  const trial = await s.bound('Btrial', 9001, { status: 'trial', trialEnd: '2027-02-10' });
  const raider = await s.bound('Craider', 9002);
  s.setRoster([{ name: 'Aleader', rank: 0, id: 9000 }, { name: 'Btrial', rank: 5, id: 9001 }, { name: 'Craider', rank: 4, id: 9002 }]);
  assert.notEqual((await s.rankOf('Btrial')).trial_start, null, 'a Trial with dates to start with');
  const base = await s.rankOf('Craider');
  const mapA = [{ rank: 0, label: 'GM', coreRank: 'raider' }, { rank: 4, label: 'Raider', coreRank: 'raider' }, { rank: 5, label: 'Initiate', coreRank: 'trial' }];
  // Unchanged ranks: Btrial stays Trial, its dates stay; Craider is untouched (same updated_at).
  const first = await s.apply(mapA);
  assert.equal(first.applied.applied.characters, 0);
  assert.deepEqual([(await s.rankOf('Btrial')).core_rank, (await s.rankOf('Btrial')).trial_end], ['trial', '2027-02-10']);
  assert.equal((await s.rankOf('Craider')).updated_at, base.updated_at);
  // Btrial is promoted (rank 5 -> Raider): the dates end. Craider is demoted into Trial: it starts with none.
  s.w.advance(60_000);
  const mapB = [{ rank: 0, label: 'GM', coreRank: 'raider' }, { rank: 4, label: 'Raider', coreRank: 'trial' }, { rank: 5, label: 'Initiate', coreRank: 'raider' }];
  await s.apply(mapB);
  const promoted = await s.rankOf('Btrial');
  assert.deepEqual([promoted.core_rank, promoted.trial_start, promoted.trial_end, promoted.updated_at], ['raider', null, null, s.w.clock.now]);
  const entered = await s.rankOf('Craider');
  assert.deepEqual([entered.core_rank, entered.trial_start, entered.trial_end, entered.updated_at], ['trial', null, null, s.w.clock.now], 'entering Trial: both dates empty, the clock starts at the next logged raid');
  assert.ok(trial && raider);
});

check('applyRankMap marks the raids of a changed character stale (its log, its team\'s evidence) and nobody else\'s', async () => {
  const s = await world();
  const a = await s.bound('Aone', 9000);
  await s.bound('Btwo', 9001);
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }, { name: 'Btwo', rank: 4, id: 9001 }]);
  const [alpha, bravo] = s.tids;
  const raid = (id, team, mode, on) => s.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, manual_reason, policy_fp, version, created_at, updated_at)
    VALUES ('${id}', '${s.gid}', '${team}', '${on}', 1, '${mode}', ${mode === 'manual' ? "'no log'" : 'NULL'}, 'fp', 5, 1, 1)`);
  raid('ra_alpha_manual', alpha, 'manual', '2027-01-01'); // team evidence of the changed character's team
  raid('ra_bravo_manual', bravo, 'manual', '2027-01-01'); // another team's evidence
  raid('ra_named', bravo, 'log', '2027-01-02'); // a log that names the changed character
  raid('ra_other', bravo, 'log', '2027-01-03'); // a log that names nobody who changes
  s.exec(`INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES ('ra_named', '${s.gid}', 'ABCDEFGHIJKLMNOP', 'fresh', 1, 1)`);
  s.exec("INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (1, 'ra_named', 'ABCDEFGHIJKLMNOP', 1, 100, 'Boss', 1, 1, 2)");
  s.exec(`INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm_key) VALUES (1, 'ra_named', '${s.gid}', 'Aone', 'aone', 'nightslayer')`);
  const marked = async () => (await s.rows("SELECT id FROM raids WHERE policy_fp = '' ORDER BY id")).map((r) => r.id);
  // A map that changes nobody marks nothing.
  const same = [{ rank: 0, label: 'GM', coreRank: 'raider' }, { rank: 4, label: 'Raider', coreRank: 'raider' }];
  await s.apply(same);
  assert.deepEqual(await marked(), []);
  // Aone (rank 0) becomes Social: its log (ra_named) and its team's evidence (ra_alpha_manual) are marked; Bravo's evidence and an unrelated log are not.
  await s.apply([{ rank: 0, label: 'GM', coreRank: 'social' }, { rank: 4, label: 'Raider', coreRank: 'raider' }]);
  assert.deepEqual(await marked(), ['ra_alpha_manual', 'ra_named']);
  assert.equal((await s.one("SELECT version FROM raids WHERE id = 'ra_named'")).version, 6, 'the version bump makes a running recompute discard its write');
  assert.ok(a);
});

check('while the guild\'s rank source is not in-game the map is stored and no character changes; the flip (lane B9) applies it', async () => {
  const s = await world({ ingame: false });
  await s.bound('Aone', 9000);
  await s.bound('Zgone', 9005);
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }]);
  const dry = await s.dry(VINDICATED);
  assert.equal(dry.applies, false);
  assert.equal(dry.changes.characters.changed, 1, 'the dry run still shows what the flip would do');
  const applied = await s.put(VINDICATED, dry.token);
  assert.deepEqual([applied.applied.characters, applied.applies, applied.rankSource], [0, false, null]);
  assert.equal((await s.mapRows()).length, 6, 'the map is stored');
  assert.deepEqual((await s.rows('SELECT name, core_rank FROM characters ORDER BY name')).map((r) => r.core_rank), ['raider', 'raider'], 'no character changed');
  // The statements themselves carry the guard: running them by hand in a legacy guild changes nothing.
  const { rankMapApplyStatements, ingameGuard } = await M();
  const results = await s.w.db.batch(rankMapApplyStatements(s.w.db, { guildId: s.gid, now: s.w.clock.now, timeZone: 'America/New_York' }, [ingameGuard(s.gid)]));
  assert.deepEqual(results.map((r) => r.meta.changes), [0, 0, 0]);
  assert.throws(() => rankMapApplyStatements(s.w.db, { guildId: s.gid, now: 1, timeZone: 'UTC' }, []), /in-game guard/);
});

// ---------------------------------------------------------------------------
// The gate and the Owner's attention item

check('every-rank-mapped gate: assertRankMapComplete refuses while a rank on the stored roster has no row, and names the ranks; rankMapGaps counts their members', async () => {
  const { assertRankMapComplete, rankMapGaps } = await M();
  const s = await world();
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }, { name: 'Btwo', rank: 3, id: 9001 }, { name: 'Cthree', rank: 3, id: 9002 }, { name: 'Dfour', rank: 9, id: 9003 }]);
  assert.deepEqual(await rankMapGaps(s.w.db, s.gid), [{ rank: 0, members: 1 }, { rank: 3, members: 2 }, { rank: 9, members: 1 }]);
  await assert.rejects(assertRankMapComplete(s.w.db, s.gid), (error) => error.status === 409 && error.code === 'rank_map_incomplete' && /rank 0, rank 3, rank 9/.test(error.message)
    && JSON.stringify(error.extra.ranks) === JSON.stringify([{ rank: 0, members: 1 }, { rank: 3, members: 2 }, { rank: 9, members: 1 }]));
  await s.apply([{ rank: 0, label: 'GM', coreRank: 'raider' }, { rank: 3, label: 'Core', coreRank: 'raider' }]);
  assert.deepEqual(await rankMapGaps(s.w.db, s.gid), [{ rank: 9, members: 1 }]);
  await s.apply([{ rank: 0, label: 'GM', coreRank: 'raider' }, { rank: 3, label: 'Core', coreRank: 'raider' }, { rank: 9, label: 'Alts', coreRank: 'social' }]);
  await assertRankMapComplete(s.w.db, s.gid);
  // A map row for a rank nobody holds is fine; the guild with no roster at all has nothing to map.
  s.setRoster([]);
  await assertRankMapComplete(s.w.db, s.gid);
});

check('the unmapped-rank attention item: the Owner of an in-game guild sees it with the ranks and the characters held back; a Guild Master who is not the Owner, an Officer and another guild do not; it clears when mapped', async () => {
  const s = await world();
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }, { name: 'Btwo', rank: 3, id: 9001 }, { name: 'Cthree', rank: 3, id: 9002 }, { name: 'Dfour', rank: 9, id: 9003 }]);
  const items = async (who) => (await s.ok(who, 'GET', '/attention', undefined, 200)).items.filter((i) => i.kind === 'unmapped_ranks');
  const ownerItems = await items('gm');
  assert.equal(ownerItems.length, 1);
  const item = ownerItems[0];
  assert.deepEqual([item.id, item.count, item.ranks, item.characters, item.teamId, item.severity], ['unmapped_ranks', 3, [0, 3, 9], 4, null, 'action']);
  assert.deepEqual(item.link, { name: 'settings', tab: 'battlenet' });
  assert.equal((await items('off')).length, 0, 'an Officer');
  // The seat on another account: the Guild Master by role is a derived Guild Master and no longer sees it.
  await s.setOwner('own');
  assert.equal((await items('gm')).length, 0);
  await s.setOwner(null);
  // Not an in-game guild yet: nothing is held back, so no item.
  s.exec(`UPDATE guilds SET rank_source = NULL WHERE id = '${s.gid}'`);
  assert.equal((await items('gm')).length, 0);
  s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  assert.equal((await items('gm')).length, 1);
  // Mapping the ranks clears it; the item cannot be dismissed (it clears when handled).
  const dismiss = await s.call('gm', 'POST', '/attention/dismissals', { itemId: 'unmapped_ranks' });
  assert.equal(dismiss.status, 400);
  assert.equal(dismiss.json.error, 'not_dismissable');
  await s.apply([{ rank: 0, label: 'GM', coreRank: 'raider' }, { rank: 3, label: 'Core', coreRank: 'raider' }, { rank: 9, label: 'Alts', coreRank: 'social' }]);
  assert.equal((await items('gm')).length, 0);
  // A rank the GM adds in game later comes back as an item for that rank alone.
  s.setRoster([{ name: 'Aone', rank: 0, id: 9000 }, { name: 'Eone', rank: 6, id: 9004 }]);
  assert.deepEqual((await items('gm')).map((i) => [i.ranks, i.characters]), [[[6], 1]]);
});

// ---------------------------------------------------------------------------
// The officer rank edit

check('the officer rank edit (PATCH status, left date, reason) is refused in an in-game guild - its ranks are the roster\'s - and works in a manual or legacy one; Trial dates stay editable', async () => {
  const s = await world({ ingame: false });
  const p = await s.person({ name: 'Edited', status: 'trial', trialEnd: '2027-02-10' });
  let version = p.res.person.version;
  const patch = (body) => s.call('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: version, ...body });
  const ok = await patch({ status: 'reserve' });
  assert.equal(ok.status, 200, ok.text);
  version = ok.json.person.version;
  s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  for (const body of [{ status: 'raider' }, { status: 'inactive' }, { status: 'inactive', leftReason: 'kicked', leftOn: '2027-01-02' }]) {
    const refused = await patch(body);
    assert.deepEqual([refused.status, refused.json.error], [409, 'rank_from_source'], JSON.stringify(body));
  }
  assert.equal((await s.one('SELECT core_rank FROM characters WHERE id = ?', p.cid)).core_rank, 'reserve', 'nothing changed');
  // Something that is not a rank still saves, in either guild.
  const joined = await patch({ joinedOn: '2026-12-01' });
  assert.equal(joined.status, 200, joined.text);
  s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  version = joined.json.person.version;
  assert.equal((await patch({ status: 'raider' })).status, 200);
});

runChecks(checks);
