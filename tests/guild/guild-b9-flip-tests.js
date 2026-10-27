/**
 * Raidsmith guild tracker - lane B9 of the user-hierarchy build: the FLIP (POST /api/guild/:gid/flip; worker/flip.js, worker/flip-binding.js, worker/routes/flip.js)
 * Run: node tests/guild/guild-b9-flip-tests.js
 *
 *   - the dry run grows two sections (the id-less characters the flip binds by name, the rank changes) and a `blockers` list; the approval covers both;
 *   - every refusal, each leaving the database exactly as it was (a refusal before the batch keeps the fresh grant and the approval too);
 *   - the happy path: the whole end state (rank source, seat, stored Guild Master row, Discord roles, identity keys, core ranks, Trial dates, audit, markers, the spent grant and token);
 *   - the compare-and-set chain: two flips racing leave exactly one applied with the seat intact, a sync (or any other change the token covers) landing between the check and the batch
 *     makes the flip refuse and spends nothing;
 *   - the batch has the same number of statements for a small and for a 506-member roster.
 * The unflip and the acceptance snapshot are tests/guild/guild-b9-unflip-tests.js.
 */
const assert = require('node:assert/strict');
const { load, runChecks } = require('../guild-b3-world');
const { makeProven } = require('../guild-ingame');
const {
  SWITCH, flipWorld, dryRun, grant, flipBody, flipWith, stateOf, beforeBatch, isFlipBatch, rosterRow,
} = require('../guild-flip');

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

const nameOf = (list) => list.map((entry) => entry.name).sort();
const hashOf = async (text) => (await load('worker/session.js')).hashToken(text);

// A refused POST /flip: the status and code, and the database as it was (the token and the grant included).
async function refused(s, what, status, code, { who = 'gm', grant: withGrant = true, grantExtra, body: bodyOverride } = {}) {
  if (withGrant) await grant(s, who, grantExtra || {});
  const before = await stateOf(s);
  // what: a dry run's answer (every candidate ticked), a bare token (nothing ticked), or undefined (an empty body); bodyOverride: the exact body.
  const body = bodyOverride !== undefined ? bodyOverride : (what === undefined ? {} : (typeof what === 'object' ? flipBody(what) : { token: what, confirmedCharacterIds: [] }));
  const res = await s.call(who, 'POST', '/flip', body);
  assert.equal(res.status, status, `${code}: ${res.text}`);
  assert.equal(res.json.error, code, res.text);
  assert.deepEqual(await stateOf(s), before, `${code}: the refusal changed something`);
  return res.json;
}

// ---------------------------------------------------------------------------
// The dry run

check('the dry run lists the characters the flip binds by name (with owner and proof), the class mismatches apart, the rank changes counted as if the binding had happened, and no blockers', async () => {
  const s = await flipWorld();
  const res = await dryRun(s);
  assert.equal(res.status, 200, res.text);
  const { boundByName, ranks, blockers } = res.json;
  assert.deepEqual(blockers, []);
  // Bound: officer proof and cleared proof. Not bound: wrong class (counted), hand-added, left, the roster row's key held by another character, no roster row.
  assert.deepEqual(nameOf(boundByName.samples), ['Namebound', 'Namenoproof', 'Nbperson', 'Trialone']);
  assert.equal(boundByName.count, 4);
  assert.deepEqual(boundByName.byProof, { officer: 2, none: 2 }, 'the proof of a linked person was cleared when the account was linked');
  assert.equal(boundByName.classMismatch, 1);
  assert.deepEqual(boundByName.samples.find((entry) => entry.name === 'Namebound'), {
    characterId: s.people.bound.cid, name: 'Namebound', class: 'MAGE', personId: s.people.bound.pid, userId: null, proof: 'officer', rosterRank: 3,
  });
  assert.deepEqual(boundByName.ids, [s.people.bound.cid, s.people.none.cid, s.people.trial.cid, s.people.nb.cid].sort(), 'every candidate id, by id: the Owner ticks from it');
  // Rank changes: Memberone sits on rank 5 (Social), the characters that are not on the roster (or not keyed) become Social, Trialone becomes Trial: all as if bound.
  assert.deepEqual(nameOf(ranks.samples), ['Dcperson', 'Memberone', 'Nameclass', 'Namehand', 'Nameleft', 'Namemissing', 'Nametaken', 'Offroster', 'Trialone']);
  assert.deepEqual([ranks.changed, ranks.becomesTrial, ranks.becomesSocial], [9, 1, 8]);
  assert.deepEqual(ranks.transitions, [{ from: 'raider', to: 'social', count: 8 }, { from: 'raider', to: 'trial', count: 1 }]);
  assert.deepEqual(ranks.unmapped, []);
  assert.deepEqual(ranks.samples.find((entry) => entry.name === 'Trialone'), { name: 'Trialone', class: 'MAGE', from: 'raider', to: 'trial' }, 'a rank sample names the character and its class');
  // Not on the roster even after the binding: Nameleft (it left: Former) and six characters that are Social; the list says which is which.
  const { notOnRoster } = res.json;
  assert.deepEqual([notOnRoster.count, notOnRoster.former, notOnRoster.social], [7, 1, 6]);
  assert.deepEqual(notOnRoster.samples.map((entry) => [entry.character, entry.after]), [
    ['Nameleft', 'former'], ['Dcperson', 'social'], ['Nameclass', 'social'], ['Namehand', 'social'], ['Namemissing', 'social'], ['Nametaken', 'social'], ['Offroster', 'social'],
  ]);
  assert.deepEqual(notOnRoster.samples[0], { character: 'Nameleft', class: 'MAGE', person: 'Nameleft', after: 'former' });
  assert(!/battletag/i.test(res.text));
  assert(res.json.access.loses.samples.every((entry) => entry.class === undefined) && res.json.access.gains.samples.every((entry) => entry.class === undefined), 'account samples carry no class');
});

check('every list the Owner sees is in the approval in full: a 25-sample cut hides nothing (the lists of 30 characters hash and bind whole)', async () => {
  const s = await flipWorld({ bulk: 30 });
  const dry = (await dryRun(s)).json;
  assert.equal(dry.boundByName.count, 34);
  assert.equal(dry.boundByName.samples.length, 25);
  assert.equal(dry.boundByName.ids.length, 34);
  assert(dry.ranks.samples.length <= 25 && dry.notOnRoster.samples.length <= 25);
  // The 26th..34th candidate is not in the samples, but changing it (its class stops matching the roster row's) changes the token's state.
  const hidden = dry.boundByName.ids.find((id) => !dry.boundByName.samples.some((entry) => entry.characterId === id));
  assert(hidden);
  s.exec(`UPDATE characters SET class = 'WARRIOR' WHERE id = '${hidden}'`);
  await grant(s);
  const stale = await s.call('gm', 'POST', '/flip', flipBody(dry));
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'approval_stale');
});

check('the dry run names what blocks the flip, in the order of the refusals, with the texts the flip answers', async () => {
  const s = await flipWorld({ ownerLive: false, mapped: false });
  s.exec(`UPDATE guilds SET pinned_guild_slug = NULL, last_good_sync_id = NULL WHERE id = '${s.gid}'`);
  const res = await dryRun(s);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.blockers.map((entry) => entry.code), ['not_pinned', 'no_good_sync', 'owner_would_be_suspended', 'rank_map_incomplete']);
  assert.deepEqual(res.json.blockers[3].ranks, [{ rank: 9, members: 1 }]);
  assert(res.json.blockers.every((entry) => entry.message.length > 20));
});

check('the approval covers the new lists: a character that stops matching, or a rank that changes, after the dry run makes the token stale', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  await grant(s);
  // A new roster row gives the id-less Namemissing a place on the roster: the binding list the Owner approved is no longer the list.
  rosterRow(s, { name: 'Namemissing', id: 9530, rank: 3 });
  const stale = await s.call('gm', 'POST', '/flip', flipBody(dry));
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'approval_stale');
  const again = (await dryRun(s)).json;
  assert.equal(again.boundByName.count, 5);
  const ok = await s.call('gm', 'POST', '/flip', flipBody(again));
  assert.equal(ok.status, 200, ok.text);
});

// ---------------------------------------------------------------------------
// Refusals

check('Owner only: an Officer, a plain member and an outsider are refused, and nothing is written', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  for (const who of ['off', 'mem']) {
    const body = await refused(s, dry, 403, 'forbidden', { who });
    assert(/Owner/.test(body.message));
  }
  const res = await s.call('out', 'POST', '/flip', flipBody(dry));
  assert([403, 404].includes(res.status), res.text);
  assert.notEqual(res.json.error, undefined);
});

check('a token is required: no body, an empty or a non-text token is 400 approval_required', async () => {
  const s = await flipWorld();
  await refused(s, undefined, 400, 'approval_required');
  await refused(s, '', 400, 'approval_required');
  await refused(s, 12345, 400, 'approval_required');
  await refused(s, 'x'.repeat(201), 400, 'approval_required');
});

check('the fresh sign-in is required: none, one for other params, one past its 15 minutes, or one of another purpose is 403 fresh_required, and the approval stays usable', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  const none = await refused(s, dry, 403, 'fresh_required', { grant: false });
  assert.equal(none.purpose, 'source_switch');
  assert.deepEqual(none.params, SWITCH);
  await refused(s, dry, 403, 'fresh_required', { grantExtra: { params: { from: 'manual', to: 'ingame' } } });
  await refused(s, dry, 403, 'fresh_required', { grantExtra: { at: s.w.clock.now - 16 * 60 * 1000 } });
  await refused(s, dry, 403, 'fresh_required', { grantExtra: { purpose: 'pin', params: { guildName: 'Writers B3', realmSlug: 'nightslayer' } } });
  const ok = await flipWith(s, dry);
  assert.equal(ok.status, 200, ok.text);
});

check('a guild that is already in-game answers 409 already_ingame; one with hand-set ranks answers 409 source_not_legacy', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  s.exec(`UPDATE guilds SET rank_source = 'manual', owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  await refused(s, dry, 409, 'source_not_legacy');
  s.exec(`UPDATE guilds SET rank_source = 'ingame', owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  await refused(s, dry, 409, 'already_ingame');
});

check('no pin and no good sync: 409 not_pinned, 409 no_good_sync (the fresh grant is kept)', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  s.exec(`UPDATE guilds SET blizzard_guild_id = NULL WHERE id = '${s.gid}'`);
  const body = await refused(s, dry, 409, 'not_pinned');
  assert(/Link the guild/.test(body.message));
  s.exec(`UPDATE guilds SET blizzard_guild_id = 3000, last_good_sync_id = NULL WHERE id = '${s.gid}'`);
  await refused(s, dry, 409, 'no_good_sync');
});

check('the Owner would be suspended (no Battle.net-proven character on the stored roster): 409 owner_would_be_suspended, and it says to sign in with Battle.net first', async () => {
  const s = await flipWorld({ ownerLive: false });
  const dry = (await dryRun(s)).json;
  assert.equal(dry.owner.live, false);
  const body = await refused(s, dry, 409, 'owner_would_be_suspended');
  assert(/Battle\.net/.test(body.message));
});

check('the effective-roles views are absent: 503 effective_roles_missing, before anything else is read', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  await grant(s);
  s.exec('DROP VIEW effective_roles');
  const res = await s.call('gm', 'POST', '/flip', flipBody(dry));
  assert.equal(res.status, 503, res.text);
  assert.equal(res.json.error, 'effective_roles_missing');
  assert.deepEqual(res.json.views, ['effective_roles']);
  assert.equal((await s.one('SELECT rank_source FROM guilds WHERE id = ?', s.gid)).rank_source, null);
});

check('a rank on the roster without a map row: 409 rank_map_incomplete names the ranks', async () => {
  const s = await flipWorld({ mapped: false });
  const dry = (await dryRun(s)).json;
  const body = await refused(s, dry, 409, 'rank_map_incomplete');
  assert.deepEqual(body.ranks, [{ rank: 9, members: 1 }]);
  assert(/rank 9/.test(body.message));
});

check('the approval: unknown, another account\'s, used, expired, a rank-map token, or for a state that moved is refused (409 approval_invalid / approval_stale) and nothing changes', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  await refused(s, 'no-such-token', 409, 'approval_invalid');
  // Another account's token: the Officer's row for the same state.
  const row = await s.one('SELECT map_hash, roster_sync_id FROM dry_run_approvals WHERE guild_id = ?', s.gid);
  const insert = async (token, fields = {}) => {
    const values = {
      approver: s.uids.gm, hash: row.map_hash, sync: row.roster_sync_id, created: s.w.clock.now, expires: s.w.clock.now + 600000, used: null, ...fields,
    };
    s.w.db.sqlite.prepare('INSERT INTO dry_run_approvals (token_hash, guild_id, approver_user_id, map_hash, roster_sync_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(await hashOf(token), s.gid, values.approver, values.hash, values.sync, values.created, values.expires, values.used);
    return token;
  };
  await refused(s, await insert('theirs', { approver: s.uids.off }), 409, 'approval_invalid');
  await refused(s, await insert('spent', { used: 5 }), 409, 'approval_invalid');
  await refused(s, await insert('expired', { expires: s.w.clock.now - 1 }), 409, 'approval_invalid');
  await refused(s, await insert('rankmap', { hash: 'rankmap:abc' }), 409, 'approval_stale');
  await refused(s, await insert('othersync', { sync: 'rs_older' }), 409, 'approval_stale');
  // The state moved after the dry run (a Discord-given role was added: the previewed lists differ).
  s.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at, source) VALUES ('ra_moved', '${s.gid}', '${s.uids.off}', 'team_lead', '${s.tids[1]}', NULL, 1, 'discord')`);
  await refused(s, dry, 409, 'approval_stale');
});

// ---------------------------------------------------------------------------
// The happy path

check('the flip: one atomic batch leaves the whole end state, links nobody, spends the grant and the token', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  const before = await stateOf(s);
  assert.equal(before.roles.filter((row) => row.role_id === 'guild_master' && row.user_id === s.uids.gm).length, 1, 'the Owner is the holder of the stored Guild Master row');
  assert.deepEqual(before.guild, { rank_source: null, owner_user_id: null, last_good_sync_id: 'rs_good' });

  const res = await flipWith(s, dry);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    ok: true,
    rankSource: 'ingame',
    ownerUserId: s.uids.gm,
    applied: {
      membersBefore: dry.access.members.today,
      membersAfter: dry.access.members.afterFlip,
      stay: dry.access.members.today - dry.access.loses.count,
      gains: dry.access.gains.count,
      loses: dry.access.loses.count,
      rankChanges: 9,
      becameTrial: 1,
      becameSocial: 8,
      discordRolesMadeManual: 1,
      discordRolesDropped: 1,
      newPermissions: dry.permissions.gains.count,
      lostPermissions: dry.permissions.loses.count,
      needsClaim: dry.needsClaim.count,
      boundByName: 4,
      owner: { userId: s.uids.gm, live: true },
    },
  });
  assert.deepEqual([res.json.applied.stay, res.json.applied.gains, res.json.applied.loses, res.json.applied.membersAfter], [4, 0, 1, 4], 'stay + gains = members after');
  const after = await stateOf(s);
  // The guild: the rank source and the seat (the seat from the stored Guild Master row's holder); the stored row is gone.
  assert.deepEqual(after.guild, { rank_source: 'ingame', owner_user_id: s.uids.gm, last_good_sync_id: 'rs_good' });
  assert.equal(after.roles.filter((row) => row.role_id === 'guild_master').length, 0);
  // The Discord-given rows are hand-set; the twin the account already held by hand is gone.
  assert.equal(after.roles.filter((row) => row.source === 'discord').length, 0);
  assert.deepEqual(after.roles.map((row) => [row.user_id, row.role_id, row.team_id, row.source]).sort(), [
    [s.uids.mem, 'officer', null, 'manual'], [s.uids.dis, 'team_lead', s.tids[0], 'manual'], [s.uids.off, 'officer', null, 'manual'],
  ].sort());
  // The name binding: identity keys for the approved characters only, from their roster rows; names and proofs are untouched.
  const chars = Object.fromEntries((await s.rows('SELECT name, namespace, blizzard_realm_id, blizzard_char_id, core_rank, trial_start, trial_end, owner_proof FROM characters WHERE guild_id = ?', s.gid)).map((row) => [row.name, row]));
  assert.deepEqual([chars.Namebound.blizzard_char_id, chars.Namenoproof.blizzard_char_id, chars.Trialone.blizzard_char_id, chars.Nbperson.blizzard_char_id], [9501, 9502, 9510, 9540]);
  assert.equal(chars.Namebound.namespace, 'profile-classicann-us');
  assert.equal(chars.Namenoproof.owner_proof, null);
  for (const unbound of ['Nameclass', 'Namehand', 'Nameleft', 'Nametaken', 'Namemissing']) assert.equal(chars[unbound].blizzard_char_id, null, `${unbound} stays unkeyed`);
  assert.equal(chars.Nametaken.core_rank, 'social');
  // The first applyRankMap: ranks from the map, Social off the roster; the Trial clock started (the trial backfill).
  assert.deepEqual([chars.Namebound.core_rank, chars.Gmmain.core_rank, chars.Memberone.core_rank, chars.Offroster.core_rank, chars.Namemissing.core_rank], ['raider', 'raider', 'social', 'social', 'social']);
  assert.equal(chars.Trialone.core_rank, 'trial');
  assert(chars.Trialone.trial_start && chars.Trialone.trial_end > chars.Trialone.trial_start, `${chars.Trialone.trial_start} .. ${chars.Trialone.trial_end}`);
  // The flip links nobody: the person that only records dis's Discord ID is still nobody's.
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', s.people.dc.pid)).user_id, null);
  assert.deepEqual(after.persons, before.persons);
  // Spent: the approval, the fresh grant; the markers of the act are there.
  assert((await s.one('SELECT used_at FROM dry_run_approvals WHERE guild_id = ?', s.gid)).used_at > 0);
  assert.equal((await s.one('SELECT fresh_purpose FROM sessions WHERE user_id = ? AND fresh_purpose IS NOT NULL', s.uids.gm)), undefined);
  assert.deepEqual(after.markers.map((row) => row.purpose).sort(), ['flip', 'flip_check', 'source_switch']);
  // Audit: the flip's row, and one row per bound character.
  const audit = await s.rows("SELECT actor_user_id, actor_role, entity_id, before, after FROM audit_log WHERE guild_id = ? AND action = 'guild.source_switch'", s.gid);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_user_id, s.uids.gm);
  assert.equal(audit[0].actor_role, 'owner');
  assert.deepEqual(JSON.parse(audit[0].before), { rankSource: null });
  const { owner: appliedOwner, ...appliedCounts } = res.json.applied;
  assert.deepEqual(JSON.parse(audit[0].after), { rankSource: 'ingame', unpinned: false, flip: true, ownerUserId: s.uids.gm, ...appliedCounts });
  const matched = await s.rows("SELECT entity_id, after FROM audit_log WHERE guild_id = ? AND action = 'character.match_roster' ORDER BY entity_id", s.gid);
  assert.deepEqual(matched.map((row) => row.entity_id), [s.people.bound.cid, s.people.none.cid, s.people.trial.cid, s.people.nb.cid].sort());
  assert.deepEqual(JSON.parse(matched[0].after), { via: 'flip' });
  // The dry run said who is a member afterwards, and the in-game rule agrees.
  const seen = [];
  for (const key of ['gm', 'mem', 'off', 'dis', 'nb', 'out']) {
    const me = await s.call(key, 'GET', '/auth/me');
    if (me.json.guilds && me.json.guilds.some((guild) => guild.id === s.gid)) seen.push(key);
  }
  assert.deepEqual(seen.sort(), ['gm', 'mem', 'nb', 'off']);
  assert.equal(dry.access.members.afterFlip, seen.length, 'the dry run counted the account whose only character the binding gives a place on the roster');
  assert(!dry.access.loses.samples.some((entry) => entry.name === 'Nbperson'), 'and did not list it as losing access');
  // A second flip is refused.
  const second = await flipWith(s, dry);
  assert.equal(second.status, 409);
  assert.equal(second.json.error, 'already_ingame');
});

// ---------------------------------------------------------------------------
// The Owner ticks the characters to match

check('POST /flip needs the ticked list: no list, a list that is no list, an entry that is no id, an id that is not on the dry run\'s list (a class mismatch, a hand-added character, a keyed one, a stranger) is 400 and changes nothing', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  const body = (confirmedCharacterIds) => ({ token: dry.token, ...(confirmedCharacterIds === undefined ? {} : { confirmedCharacterIds }) });
  const missing = await refused(s, dry, 400, 'confirmation_required', { body: body(undefined) });
  assert.equal(missing.field, 'confirmedCharacterIds');
  await refused(s, dry, 400, 'confirmation_required', { body: body('all') });
  await refused(s, dry, 400, 'confirmation_required', { body: body({ 0: s.people.bound.cid }) });
  await refused(s, dry, 400, 'bad_confirmation', { body: body([s.people.bound.cid, 7]) });
  await refused(s, dry, 400, 'bad_confirmation', { body: body([null]) });
  await refused(s, dry, 400, 'bad_confirmation', { body: body(['']) });
  await refused(s, dry, 400, 'bad_confirmation', { body: body(Array.from({ length: 2001 }, (_, i) => `c_${i}`)) });
  const foreign = [s.people.klass.cid, s.people.hand.cid, s.people.left.cid, s.people.taken.cid, s.people.missing.cid, s.people.gm.cid, 'c_NoSuchCharacter0000000000'];
  const refusal = await refused(s, dry, 400, 'bad_confirmation', { body: body([s.people.bound.cid, ...foreign]) });
  assert.deepEqual(refusal.ids, foreign);
  assert.equal(refusal.field, 'confirmedCharacterIds');
  assert(/dry run/.test(refusal.message));
  // The token is judged first: a list that would be refused does not make a bad token look fine.
  await refused(s, 'no-such-token', 409, 'approval_invalid', { body: { token: 'no-such-token', confirmedCharacterIds: foreign } });
  // The same ticked list with the right ids goes through.
  const ok = await s.call('gm', 'POST', '/flip', body([s.people.bound.cid]));
  assert.equal(ok.status, 200, ok.text);
});

check('the Owner ticks a subset: the unticked characters stay unbound (and Social), the ranks, the access lines and the banner counts are those of the ticked binding, the batch has the same size', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  // Tick Namebound and Namenoproof; leave Trialone (would become Trial) and Nbperson (their account's only character) unticked.
  const ticked = [s.people.bound.cid, s.people.none.cid];
  const left = [s.people.trial.cid, s.people.nb.cid];
  let size = null;
  beforeBatch(s, isFlipBatch, async (statements) => { size = statements.length; });
  const res = await flipWith(s, dry, 'gm', { confirmed: ticked });
  assert.equal(res.status, 200, res.text);
  assert.equal(size, 16);
  const chars = Object.fromEntries((await s.rows('SELECT id, name, blizzard_char_id, core_rank, trial_start, trial_end FROM characters WHERE guild_id = ?', s.gid)).map((row) => [row.id, row]));
  for (const id of ticked) assert(chars[id].blizzard_char_id > 0, `${chars[id].name} is bound`);
  for (const id of left) {
    assert.equal(chars[id].blizzard_char_id, null, `${chars[id].name} stays unbound`);
    assert.equal(chars[id].core_rank, 'social', `${chars[id].name} is Social: not on the roster`);
    assert.equal(chars[id].trial_end, null);
  }
  // Only the ticked characters have an audit row.
  assert.deepEqual((await s.rows("SELECT entity_id FROM audit_log WHERE guild_id = ? AND action = 'character.match_roster' ORDER BY entity_id", s.gid)).map((row) => row.entity_id), [...ticked].sort());
  // The banner: the ticked binding's lines. Nbperson's account loses its access (its only character is unbound); the full list would have kept it.
  const applied = res.json.applied;
  assert.equal(applied.boundByName, 2);
  assert.equal(applied.loses, dry.access.loses.count + 1);
  assert.equal(applied.membersAfter, dry.access.members.afterFlip - 1);
  assert.equal(applied.stay, applied.membersBefore - applied.loses);
  assert.equal(applied.membersAfter, applied.stay + applied.gains);
  assert.equal(applied.becameTrial, 0);
  assert.equal(applied.rankChanges, dry.ranks.changed + 1, 'Trialone becomes Social instead of Trial (still a change), Nbperson becomes Social instead of staying');
  assert.equal(applied.becameSocial, dry.ranks.becomesSocial + 2);
  const seen = [];
  for (const key of ['gm', 'mem', 'off', 'dis', 'nb', 'out']) {
    const me = await s.call(key, 'GET', '/auth/me');
    if ((me.json.guilds || []).some((guild) => guild.id === s.gid)) seen.push(key);
  }
  assert.deepEqual(seen.sort(), ['gm', 'mem', 'off']);
  assert.equal(applied.membersAfter, seen.length, 'the banner counts the members the in-game rule really lets in');
  assert.equal(JSON.parse((await s.one("SELECT after FROM audit_log WHERE guild_id = ? AND action = 'guild.source_switch'", s.gid)).after).boundByName, 2);
});

check('ticking nothing binds nothing: [] is a valid list, the flip applies and every candidate stays unbound; duplicates in the list collapse', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  const res = await flipWith(s, dry, 'gm', { confirmed: [] });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.applied.boundByName, 0);
  assert.equal(await s.w.count('characters', 'guild_id = ? AND blizzard_char_id IS NOT NULL AND id IN (?, ?, ?, ?)', s.gid, s.people.bound.cid, s.people.none.cid, s.people.trial.cid, s.people.nb.cid), 0);
  assert.equal(await s.w.count('audit_log', "guild_id = ? AND action = 'character.match_roster'", s.gid), 0);
  const t = await flipWorld();
  const dryT = (await dryRun(t)).json;
  const twice = await flipWith(t, dryT, 'gm', { confirmed: [t.people.bound.cid, t.people.bound.cid] });
  assert.equal(twice.status, 200, twice.text);
  assert.equal(twice.json.applied.boundByName, 1);
});

check('the banner counts the new permissions (derived from the in-game rank) and the Owner: a proven rank-2 member gets Team Lead on their team', async () => {
  const s = await flipWorld();
  await s.member('lead', 'Leadaccount');
  const made = await s.person({ name: 'Leadmain' });
  await s.link(made.pid, 'lead');
  makeProven(s, 'lead', made, { rank: 2, id: 9600 });
  const dry = (await dryRun(s)).json;
  assert.equal(dry.permissions.gains.count, 1);
  const res = await flipWith(s, dry);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.applied.newPermissions, 1);
  assert.equal(res.json.applied.lostPermissions, 0);
  assert.deepEqual(res.json.applied.owner, { userId: s.uids.gm, live: true });
  assert.equal(res.json.applied.needsClaim, dry.needsClaim.count);
});

// ---------------------------------------------------------------------------
// The compare-and-set chain

check('the flip links NOBODY: a person that only records the Discord ID of an account keeps user_id NULL, and that account loses access with the reason needs_claim until its player claims the person', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  // The dry run says so before the flip: dis has no person of the guild, Dcperson records dis's Discord ID and nobody owns it.
  const lost = dry.access.loses.samples.find((entry) => entry.userId === undefined && entry.personId === s.people.dc.pid);
  assert(lost, JSON.stringify(dry.access.loses));
  assert.equal(lost.reason, 'needs_claim');
  assert(dry.needsClaim.samples.some((entry) => entry.personId === s.people.dc.pid));
  assert.equal(dry.discordOwned, undefined, 'the section that listed the persons the flip would link is gone');
  const discordId = (await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.dis)).discord_id;
  assert.equal((await s.one('SELECT discord_user_id, user_id FROM players WHERE id = ?', s.people.dc.pid)).discord_user_id, discordId);
  const linkedBefore = await s.rows('SELECT id FROM players WHERE guild_id = ? AND user_id IS NOT NULL ORDER BY id', s.gid);

  const res = await flipWith(s, dry);
  assert.equal(res.status, 200, res.text);

  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', s.people.dc.pid)).user_id, null, 'the person is still unowned');
  assert.deepEqual(await s.rows('SELECT id FROM players WHERE guild_id = ? AND user_id IS NOT NULL ORDER BY id', s.gid), linkedBefore, 'no person got an owner');
  const me = await s.call('dis', 'GET', '/auth/me');
  assert(!(me.json.guilds || []).some((guild) => guild.id === s.gid), 'the account has no access in the in-game guild');
  const view = await s.call('dis', 'GET', '');
  assert.equal(view.status, 403, view.text);
  assert.equal(view.json.error, 'not_member');
});

check('two flip POSTs in parallel leave exactly one applied, the seat intact, one audit row and one spent token', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  await grant(s);
  const [a, b] = await Promise.all([s.call('gm', 'POST', '/flip', flipBody(dry)), s.call('gm', 'POST', '/flip', flipBody(dry))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.text} | ${b.text}`);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.json.error, 'already_ingame');
  assert.deepEqual(await s.one('SELECT rank_source, owner_user_id FROM guilds WHERE id = ?', s.gid), { rank_source: 'ingame', owner_user_id: s.uids.gm });
  assert.equal(await s.w.count('audit_log', "guild_id = ? AND action = 'guild.source_switch'", s.gid), 1);
  assert.equal(await s.w.count('audit_log', "guild_id = ? AND action = 'character.match_roster'", s.gid), 4);
});

check('a whole second flip that lands between the first one\'s check and its batch wins; the first changes nothing and is told so', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  await grant(s);
  let inner;
  beforeBatch(s, isFlipBatch, async () => { inner = await s.call('gm', 'POST', '/flip', flipBody(dry)); });
  const outer = await s.call('gm', 'POST', '/flip', flipBody(dry));
  assert.equal(inner.status, 200, inner.text);
  assert.equal(outer.status, 409, outer.text);
  assert.equal(outer.json.error, 'already_ingame');
  assert.deepEqual(await s.one('SELECT rank_source, owner_user_id FROM guilds WHERE id = ?', s.gid), { rank_source: 'ingame', owner_user_id: s.uids.gm });
  assert.equal(await s.w.count('audit_log', "guild_id = ? AND action = 'guild.source_switch'", s.gid), 1);
});

check('a roster sync that lands between the check and the batch makes the flip refuse (409 approval_stale) and spends neither the token nor the grant', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  await grant(s);
  beforeBatch(s, isFlipBatch, async () => {
    s.exec(`INSERT INTO roster_syncs (id, guild_id, started_at, finished_at, good, http_status, reason, counts) VALUES ('rs_new', '${s.gid}', 5, 6, 1, 200, NULL, '{}')`);
    s.exec(`UPDATE guilds SET last_good_sync_id = 'rs_new' WHERE id = '${s.gid}'`);
  });
  const before = await stateOf(s);
  const res = await s.call('gm', 'POST', '/flip', flipBody(dry));
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json.error, 'approval_stale');
  const after = await stateOf(s);
  assert.deepEqual({ ...after, guild: undefined }, { ...before, guild: undefined }, 'only the sync moved');
  assert.equal(after.guild.rank_source, null);
  assert.equal(after.guild.owner_user_id, null);
  assert.equal((await s.one('SELECT used_at FROM dry_run_approvals WHERE guild_id = ?', s.gid)).used_at, null);
  assert.equal((await s.one('SELECT fresh_purpose FROM sessions WHERE user_id = ?', s.uids.gm)).fresh_purpose, 'source_switch');
});

check('anything else the approval covers that changes inside that window refuses too: a character that starts to match, a rank map row, the Owner\'s proof, the stored Guild Master row', async () => {
  const cases = {
    'a new roster row gives a character a place': (s) => rosterRow(s, { name: 'Namemissing', id: 9531, rank: 3 }),
    'a map row changes what a rank is': (s) => s.exec(`UPDATE source_rank_maps SET core_rank = 'trial' WHERE guild_id = '${s.gid}' AND source_key = '3'`),
    'the Owner\'s proof is cleared': (s) => s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL WHERE id = '${s.people.gm.cid}'`),
    'the stored Guild Master row goes to someone else': (s) => s.exec(`UPDATE role_assignments SET user_id = '${s.uids.off}' WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`),
  };
  for (const [name, change] of Object.entries(cases)) {
    const s = await flipWorld();
    const dry = (await dryRun(s)).json;
    await grant(s);
    beforeBatch(s, isFlipBatch, async () => change(s));
    const res = await s.call('gm', 'POST', '/flip', flipBody(dry));
    assert.equal(res.status, 409, `${name}: ${res.text}`);
    assert.equal(res.json.error, 'approval_stale', name);
    assert.deepEqual(await s.one('SELECT rank_source, owner_user_id FROM guilds WHERE id = ?', s.gid), { rank_source: null, owner_user_id: null }, name);
    assert.equal(await s.w.count('audit_log', "guild_id = ? AND action = 'guild.source_switch'", s.gid), 0, name);
    assert.equal((await s.one('SELECT used_at FROM dry_run_approvals WHERE guild_id = ?', s.gid)).used_at, null, name);
    assert.equal((await s.one('SELECT fresh_purpose FROM sessions WHERE user_id = ?', s.uids.gm)).fresh_purpose, 'source_switch', `${name}: the grant is kept`);
  }
});

check('a batch that fails midway leaves the guild exactly as it was (the chain is one transaction)', async () => {
  const s = await flipWorld();
  const dry = (await dryRun(s)).json;
  await grant(s);
  // A character that takes one of the keys the flip is about to write makes the binding UPDATE violate the unique identity index, after the guild and the seat were written.
  beforeBatch(s, isFlipBatch, async () => {
    s.exec(`CREATE TRIGGER trap_bind BEFORE UPDATE OF blizzard_char_id ON characters WHEN NEW.blizzard_char_id = 9501 BEGIN SELECT RAISE(ABORT, 'trap'); END`);
  });
  const before = await stateOf(s);
  const res = await s.call('gm', 'POST', '/flip', flipBody(dry));
  assert.equal(res.status, 500, res.text);
  s.exec('DROP TRIGGER trap_bind');
  assert.deepEqual(await stateOf(s), before);
});

// ---------------------------------------------------------------------------
// The batch size

check('the batch has the same number of statements for a small roster and for a 600-candidate one (a body past the old 16 KB limit)', async () => {
  const { FLIP_BATCH_STATEMENTS } = await load('worker/flip.js');
  const counts = {};
  for (const [name, bulk] of [['small', 0], ['big', 600]]) {
    const s = await flipWorld({ bulk });
    const roster = (await s.one('SELECT COUNT(*) AS n FROM guild_roster WHERE guild_id = ?', s.gid)).n;
    if (name === 'small') assert(roster <= 20, `${roster}`); else assert(roster >= 506, `${roster}`);
    const dry = (await dryRun(s)).json;
    assert.equal(dry.boundByName.count, 4 + bulk);
    assert.deepEqual(dry.blockers, []);
    await grant(s);
    let size = null;
    let widest = 0;
    beforeBatch(s, isFlipBatch, async (statements) => {
      size = statements.length;
      widest = Math.max(...statements.map((statement) => statement.values.length));
    });
    const res = await s.call('gm', 'POST', '/flip', flipBody(dry));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.applied.boundByName, 4 + bulk);
    assert(widest <= 100, 'no statement binds more than 100 values');
    counts[name] = { size, roster };
  }
  assert.equal(counts.small.size, counts.big.size, JSON.stringify(counts));
  assert.equal(counts.small.size, FLIP_BATCH_STATEMENTS);
  assert(counts.big.roster >= 506);
});

runChecks(checks);
