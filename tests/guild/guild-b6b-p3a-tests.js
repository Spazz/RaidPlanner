/**
 * Raidsmith guild tracker - lane B6b part 3a of the user-hierarchy build: the setup pin, the source/pin rules, the Discord role-sync gate and the dry run's permission and Owner
 * lines (worker/routes/bnet-pin.js, worker/guild-pin.js, worker/pin-target.js, worker/pin-proof.js, worker/owner-gate.js, worker/flip-preview.js, worker/discord-sync.js,
 * worker/routes/{bnet,bnet-import,discord,fresh,flip,guild}.js, worker/roster-sync.js settleFetchedRoster)
 * Run: node tests/guild/guild-b6b-p3a-tests.js [name filter]
 *
 *   1. The setup pin (POST /api/guild/:gid/bnet/pin): the operator allowlist SETUP_PIN_GUILDS (unset / empty / a list / '*'), the Owner only (an Officer, a member, a derived Guild Master,
 *      a suspended Owner are refused; an Owner who is no member under the legacy rule is not), a `pin` fresh grant that is required, bound to the target and consumed (marker pattern: a
 *      parallel pin and a swapped order apply nothing), a Battle.net-proven character on the LIVE roster (the account's characters are read by the grant's callback, the roster by the
 *      pin: nothing the guild stored counts), pin_taken, pin_locked and the re-pin to the same Blizzard guild, the first sync in the same flow and the 45-statement budget on a 1,200
 *      member roster, the refusals above the fetch limit and the caps;
 *   2. the source/pin rules (1)-(6): the writers of the pin columns, the fetch target, PUT /bnet and PATCH /guild once pinned, the officer import, the id checks, the source switch helper;
 *   3. the Discord role-sync gate (no permission roles once rank_source is set; the server's non-members of an in-game or manual guild are never synced);
 *   4. the flip dry run's permission and Owner lines (an Owner who will NOT be live on the stored roster) and B5 open point (c).
 * Drives worker/index.js over the node:sqlite D1 stand-in. Battle.net is tools/fake-battlenet.js on a local port with its profile and roster answers overridden.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, runChecks, STEP } = require('../guild-b3-world');
const { scansSince } = require('../guild-plans');
const { derivedGm, flip, makeProven, rolesOf } = require('../guild-ingame');
const {
  TARGET, BLIZZARD_GUILD_ID, ACC, ID, NAMESPACE, REALM_ID, bulk, pinWorld, linkOld, grantPin, pinRaw, pin, pinRow, pinColumns, unpinned, measure, entry,
} = require('../guild-pin');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({
    name,
    fn: async () => {
      globalThis.__pinWorlds = [];
      try { await fn(); } finally { await Promise.all(globalThis.__pinWorlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 100)); }
    },
  });
}
const HOUR = 60 * 60 * 1000;
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const grantOf = (s, key = 'gm') => s.grantOf(key);
const NO_GRANT = { fresh_purpose: null, fresh_hash: null, fresh_at: null };
const refuse = (res, status, error) => assert.deepEqual([res.status, res.json && res.json.error], [status, error], res.text);
const guildFetches = (requests) => requests.filter((request) => request.path.startsWith('/data/wow/guild/'));

// ---------------------------------------------------------------------------
// 1. The setup pin

check('the pin: the Owner, a consumed grant and a character on the live roster pin the guild (all five columns, the realm id too), the first sync runs in the same flow, the grant is spent', async () => {
  const s = await pinWorld();
  assert.deepEqual(await pinColumns(s), unpinned);
  const flow = await grantPin(s);
  assert.equal(flow.location, '/#/fresh?done=pin');
  const link = await s.one('SELECT snapshot FROM bnet_links WHERE user_id = ?', s.uids.gm);
  const entryNow = JSON.parse(link.snapshot)[NAMESPACE];
  assert.equal(entryNow.fetchedAt, (await grantOf(s)).fresh_at, 'the callback read the account\'s characters when it wrote the grant');
  assert.deepEqual(entryNow.characters.map((character) => [character.name, character.characterId, character.realmId, character.namespace]), [['Gmmain', ID.gm, REALM_ID, NAMESPACE]]);
  const run = await measure(s, () => pinRaw(s));
  const res = run.result;
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, {
    pinned: true, mode: 'first', guildName: 'Writers B3', guildSlug: 'writers-b3', realmSlug: 'nightslayer', namespace: NAMESPACE, rankSource: null,
    sync: { status: 'applied', reason: null, members: 2, syncId: res.json.sync.syncId },
  });
  assert.deepEqual(await pinColumns(s), {
    pinned_guild_slug: 'writers-b3', pinned_realm_slug: 'nightslayer', pinned_namespace: NAMESPACE, blizzard_guild_id: BLIZZARD_GUILD_ID, blizzard_realm_id: REALM_ID,
  });
  const row = await pinRow(s);
  assert.equal(row.rank_source, null, 'the pin does not flip the guild');
  assert.equal(row.last_good_sync_id, res.json.sync.syncId);
  assert(row.next_sync_at > s.w.clock.now, 'the lease is one interval ahead: the scheduler has nothing to do');
  assert.equal(await s.w.count('guild_roster', 'guild_id = ?', s.gid), 2);
  assert.equal(await s.w.count('roster_syncs', 'guild_id = ? AND good = 1', s.gid), 1);
  assert.deepEqual(await grantOf(s), NO_GRANT, 'the grant is spent');
  assert.equal(await s.w.count('fresh_act_markers', "purpose = 'pin'"), 1);
  const audit = await s.rows("SELECT actor_user_id, actor_role, entity_id, before, after FROM audit_log WHERE guild_id = ? AND action = 'guild.pin'", s.gid);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].actor_user_id, audit[0].actor_role, audit[0].entity_id], [s.uids.gm, 'owner', s.gid]);
  assert.deepEqual(JSON.parse(audit[0].after), { guildSlug: 'writers-b3', realmSlug: 'nightslayer', namespace: NAMESPACE, rePin: false });
  assert(!/blizzard|3000|4001/i.test(audit[0].before + audit[0].after), 'no Blizzard id in the audit row');
  // The pin made no Blizzard request for the account (that was the callback's); the roster was fetched ONCE (with the client token).
  assert.deepEqual(guildFetches(run.blizzard).length, 1);
  assert.equal(run.blizzard.filter((request) => request.path === '/profile/user/wow').length, 0);
  // Pre-flip, the sync wrote only the roster and the sync columns: no person, no character, no role changed.
  assert.equal(await s.w.count('characters', "owner_proof = 'bnet'"), 0);
  assert.deepEqual(rolesOf(s, 'gm'), [['guild_master', null, 'manual'], ['guild_master', null, 'owner']], 'the Owner is still the stored Guild Master');
  console.log(`      measured: the pin request ran ${run.statements.length} D1 statements and ${run.blizzard.length} Blizzard requests (2-member roster)`);
});

check('the allowlist SETUP_PIN_GUILDS: unset, empty, blank and a list without the guild are closed (403 pin_not_open at the start AND at the pin, before any read or Blizzard call); the guild\'s id in a list and * open it', async () => {
  const { pinOpen } = await load('worker/pin-target.js');
  assert.equal(pinOpen({}, 'g_a'), false);
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: '' }, 'g_a'), false);
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: ' , ' }, 'g_a'), false);
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: 'g_b,g_c' }, 'g_a'), false);
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: 'g_b, g_a ' }, 'g_a'), true);
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: 'g_b,*' }, 'g_a'), true);
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: '*' }, undefined), true);
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: 'g_ab' }, 'g_a'), false, 'a prefix is not the id');
  assert.equal(pinOpen({ SETUP_PIN_GUILDS: 123 }, 'g_a'), false);
  for (const setupOpen of [null, '', 'g_other']) {
    const s = await pinWorld({ setupOpen });
    const start = await s.call('gm', 'POST', '/fresh/start', { purpose: 'pin', params: TARGET, provider: 'bnet' });
    refuse(start, 403, 'pin_not_open');
    const calls = s.bnet.state.requests.length;
    refuse(await pinRaw(s), 403, 'pin_not_open');
    assert.equal(s.bnet.state.requests.length, calls, 'nothing was asked of Blizzard');
    assert.deepEqual(await pinColumns(s), unpinned);
    // The settings read tells the page whether the pin is open.
    assert.equal((await s.call('gm', 'GET', '/bnet')).json.pinOpen, false);
  }
  // Open for exactly this guild: the list names its id.
  const named = await pinWorld({ setupOpen: 'g_other' });
  named.w.env.SETUP_PIN_GUILDS = `g_other, ${named.gid}`;
  assert.equal((await named.call('gm', 'GET', '/bnet')).json.pinOpen, true);
  assert.equal((await pin(named)).status, 200);
  const all = await pinWorld({ setupOpen: '*' });
  assert.equal((await pin(all)).status, 200);
});

check('Owner only: an Officer, a member, a derived Guild Master and a suspended Owner are refused (403, nothing fetched, the grant is not spent); an Owner who is no member under the legacy rule passes', async () => {
  const s = await pinWorld();
  await s.officer('off', 'Officerone');
  await s.member('mem', 'Plainmember');
  linkOld(s, 'off');
  linkOld(s, 'mem');
  // The start step refuses them first (nobody is sent to Battle.net for an act that is refused).
  for (const who of ['off', 'mem']) refuse(await s.call(who, 'POST', '/fresh/start', { purpose: 'pin', params: TARGET, provider: 'bnet' }), 403, 'forbidden');
  // A grant for the same target on the Officer's own session (written straight into the session row) does not make them the Owner.
  for (const who of ['off', 'mem']) {
    await s.grant(who, { purpose: 'pin', guildId: s.gid, params: { guildSlug: 'writers-b3', realmSlug: 'nightslayer' } });
    const calls = s.bnet.state.requests.length;
    refuse(await pinRaw(s, who), 403, 'forbidden');
    assert.equal(s.bnet.state.requests.length, calls, `${who}: nothing was asked of Blizzard`);
    assert.notEqual((await grantOf(s, who)).fresh_purpose, null, `${who}: the grant is not spent`);
  }
  assert.deepEqual(await pinColumns(s), unpinned);
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  // A derived Guild Master and a suspended Owner of an in-game guild.
  const g = await pinWorld();
  const derived = await derivedGm(g, 'dgm', 'Derivedgm');
  const mine = await g.person({ name: 'Ownerchar' });
  await g.link(mine.pid, 'gm');
  makeProven(g, 'gm', mine, { rank: 4, id: 9400 });
  flip(g, { owner: 'gm' });
  assert.deepEqual(rolesOf(g, 'dgm').map((row) => row[0]), ['guild_master'], 'derived Guild Master');
  refuse(await g.call('dgm', 'POST', '/fresh/start', { purpose: 'pin', params: TARGET, provider: 'bnet' }), 403, 'forbidden');
  await g.grant('dgm', { purpose: 'pin', guildId: g.gid, params: { guildSlug: 'writers-b3', realmSlug: 'nightslayer' } });
  refuse(await pinRaw(g, 'dgm'), 403, 'forbidden');
  g.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${mine.cid}'`); // the Owner is suspended
  refuse(await g.call('gm', 'POST', '/fresh/start', { purpose: 'pin', params: TARGET, provider: 'bnet' }), 403, 'forbidden');
  await g.grant('gm', { purpose: 'pin', guildId: g.gid, params: { guildSlug: 'writers-b3', realmSlug: 'nightslayer' } });
  refuse(await pinRaw(g, 'gm'), 403, 'forbidden');
  assert.equal(g.bnet.state.requests.filter((request) => request.path.startsWith('/data/')).length, 0);
  // An Owner who is in no Discord server and linked to no person (the legacy rule does not let them in) is still the Owner: the start step and the pin answer them.
  const o = await pinWorld();
  await o.outsider('seat', 'Seatholder');
  await o.setOwner('seat');
  linkOld(o, 'seat');
  o.live.profiles[ACC.seat.id] = [entry('Gmmain', ID.gm)];
  refuse(await o.call('seat', 'GET', ''), 403, 'not_member');
  const ok = await pin(o, 'seat');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.flow.location, '/#/fresh?done=pin');
});

check('the grant: no grant, a grant for another target, another purpose, an expired one and a spent one are refused (403 fresh_required with the params) before any Blizzard call; success spends it', async () => {
  const s = await pinWorld();
  let calls = s.bnet.state.requests.length;
  const none = await pinRaw(s);
  refuse(none, 403, 'fresh_required');
  assert.deepEqual([none.json.purpose, none.json.params], ['pin', { guildSlug: 'writers-b3', realmSlug: 'nightslayer' }]);
  assert.equal(s.bnet.state.requests.length, calls, 'no grant: no Blizzard call');
  // A grant for another target (another guild name) is no grant for this one, and burns nothing.
  const other = { guildName: 'Another Guild', realmSlug: 'nightslayer' };
  await grantPin(s, 'gm', other);
  const requests = s.bnet.state.requests.length;
  refuse(await pinRaw(s), 403, 'fresh_required');
  assert.equal(s.bnet.state.requests.length, requests);
  assert.notEqual((await grantOf(s)).fresh_purpose, null, 'the grant for the other target is still there');
  // The same target typed differently is the same act (the grant is bound to the slugs).
  await grantPin(s, 'gm', { guildName: '  writers   B3 ', realmSlug: 'Nightslayer' });
  assert.equal((await pinRaw(s, 'gm', TARGET)).status, 200);
  assert.deepEqual(await grantOf(s), NO_GRANT);
  // The grant is single use: the same request again needs a new one.
  refuse(await pinRaw(s), 403, 'fresh_required');
  // Another purpose's grant, and an expired one.
  const t = await pinWorld();
  await t.grant('gm', { purpose: 'guild_delete', guildId: t.gid, params: {} });
  refuse(await pinRaw(t), 403, 'fresh_required');
  await grantPin(t);
  t.w.advance(15 * 60 * 1000 + 1);
  refuse(await pinRaw(t), 403, 'fresh_required');
  assert.deepEqual(await pinColumns(t), unpinned);
  calls = t.bnet.state.requests.length;
  assert.equal((await pin(t)).status, 200);
});

check('bad input and the grant\'s own limits: a name or realm that is no name is 400 bad_request (with the field), the start step takes exactly { guildName, realmSlug }, an unsupported game version has nothing to pin', async () => {
  const s = await pinWorld();
  const bad = async (body, field) => {
    const res = await pinRaw(s, 'gm', body);
    assert.deepEqual([res.status, res.json.error, res.json.field], [400, 'bad_request', field], res.text);
  };
  await bad({}, 'guildName');
  await bad({ guildName: 5, realmSlug: 'nightslayer' }, 'guildName');
  await bad({ guildName: '', realmSlug: 'nightslayer' }, 'guildName');
  await bad({ guildName: 'x'.repeat(33), realmSlug: 'nightslayer' }, 'guildName');
  await bad({ guildName: '!!!', realmSlug: 'nightslayer' }, 'guildName');
  await bad({ guildName: 'Ok', realmSlug: 7 }, 'realmSlug');
  await bad({ guildName: 'Ok', realmSlug: '' }, 'realmSlug');
  await bad({ guildName: 'Ok', realmSlug: '!!!' }, 'realmSlug');
  for (const params of [{}, { guildName: 'Ok' }, { guildName: 'Ok', realmSlug: 'x', extra: 1 }, { guildName: '', realmSlug: 'x' }]) {
    const start = await s.call('gm', 'POST', '/fresh/start', { purpose: 'pin', params, provider: 'bnet' });
    assert.deepEqual([start.status, start.json.field], [400, 'params'], JSON.stringify(params));
  }
  // Names are normalised: the realm may be typed as its name, the guild with any spacing.
  const typed = await pin(s, 'gm', { guildName: ' writers  b3', realmSlug: 'Night Slayer' });
  assert.equal(typed.status, 200, typed.text);
  assert.equal((await pinRow(s)).pinned_realm_slug, 'night-slayer');
  // A game version Battle.net has no data for (WoW Forever) cannot be pinned: said at the start, before the trip to Blizzard.
  const f = await pinWorld();
  f.exec(`UPDATE guilds SET game_version = 'forever' WHERE id = '${f.gid}'`);
  refuse(await f.call('gm', 'POST', '/fresh/start', { purpose: 'pin', params: TARGET, provider: 'bnet' }), 409, 'bnet_unsupported');
  refuse(await pinRaw(f), 409, 'bnet_unsupported');
  const n = await pinWorld({ env: { BNET_CLIENT_SECRET: '' } });
  refuse(await pinRaw(n), 503, 'bnet_not_configured');
});

check('the proof is LIVE Blizzard data: a character on the live roster is required (403 pin_not_on_roster, nothing written, the grant kept); characters the guild stored (a typed name, an officer\'s link, an old proof) count for nothing', async () => {
  const s = await pinWorld();
  // The account\'s characters are not on this roster.
  s.live.profiles[ACC.gm.id] = [entry('Elsewhere', 9999)];
  await grantPin(s);
  const refused = await pinRaw(s);
  refuse(refused, 403, 'pin_not_on_roster');
  assert(/in-game guild/.test(refused.json.message), refused.json.message);
  assert.deepEqual(await pinColumns(s), unpinned);
  assert.equal(await s.w.count('guild_roster'), 0);
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  assert.notEqual((await grantOf(s)).fresh_purpose, null, 'a refusal before the batch does not spend the grant');
  // Everything the guild could have stored about the Owner is a squatter\'s lever: a character with the roster member\'s name linked to the Owner, an old Battle.net proof of the very
  // roster key. None of it decides the pin.
  const mine = await s.person({ name: 'Gmmain' });
  await s.link(mine.pid, 'gm');
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.gm}', proof_bnet_account_id = '${ACC.gm.id}', proof_at = 1, namespace = '${NAMESPACE}', blizzard_realm_id = ${REALM_ID}, blizzard_char_id = ${ID.gm} WHERE id = '${mine.cid}'`);
  refuse(await pinRaw(s), 403, 'pin_not_on_roster');
  assert.deepEqual(await pinColumns(s), unpinned);
  // Live Blizzard data does: the same grant, the account lists the roster character now (a new fresh sign-in reads it afresh).
  s.live.profiles[ACC.gm.id] = [entry('Gmmain', ID.gm)];
  assert.equal((await pin(s)).status, 200);
  // A grant the pin callback did not write (no read of the characters behind it) is no grant for this act.
  const t = await pinWorld();
  await t.grant('gm', { purpose: 'pin', guildId: t.gid, params: { guildSlug: 'writers-b3', realmSlug: 'nightslayer' } });
  refuse(await pinRaw(t), 403, 'fresh_required');
  assert.deepEqual(await pinColumns(t), unpinned);
  // The characters were read before the grant (an older read than the grant): the same.
  const u = await pinWorld();
  await grantPin(u);
  u.exec(`UPDATE sessions SET fresh_at = fresh_at + 1 WHERE user_id = '${u.uids.gm}'`);
  refuse(await pinRaw(u), 403, 'fresh_required');
  // A Blizzard failure while reading the account\'s characters gives no grant at all.
  const v = await pinWorld();
  v.bnet.state.fail.profile = 500;
  const flow = await grantPin(v);
  assert.equal(flow.location, '/#/fresh?error=provider&purpose=pin');
  assert.deepEqual(await grantOf(v), NO_GRANT);
});

check('pin_taken: another Raidsmith guild holds that Blizzard guild (409, nothing written, the grant kept); the unique index decides a race too', async () => {
  const s = await pinWorld();
  // Another guild of the same game version and region is pinned to Blizzard guild 3000 on realm 4001.
  s.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, game_version, discord_server_id, time_zone, created_at, created_by, pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id)
          SELECT 'g_other_taken', 'Other', realm, realm_kind, region, game_version, 'none:g_other_taken', time_zone, created_at, created_by, 'writers-b3', 'nightslayer', '${NAMESPACE}', ${BLIZZARD_GUILD_ID}, ${REALM_ID} FROM guilds WHERE id = '${s.gid}'`);
  await grantPin(s);
  const taken = await pinRaw(s);
  refuse(taken, 409, 'pin_taken');
  assert.deepEqual(await pinColumns(s), unpinned);
  assert.notEqual((await grantOf(s)).fresh_purpose, null, 'the grant is kept');
  // The race: the other guild takes the Blizzard guild between the look-up and the batch. The unique violation rolls the whole batch back and is the same answer.
  s.exec("DELETE FROM guilds WHERE id = 'g_other_taken'");
  const realBatch = s.w.db.batch.bind(s.w.db);
  let armed = true;
  s.w.db.batch = async (statements) => {
    if (armed && statements.some((statement) => /UPDATE guilds SET pinned_guild_slug/.test(statement.sql))) {
      armed = false;
      s.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, game_version, discord_server_id, time_zone, created_at, created_by, pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id)
              SELECT 'g_other_race', 'Other', realm, realm_kind, region, game_version, 'none:g_other_race', time_zone, created_at, created_by, 'writers-b3', 'nightslayer', '${NAMESPACE}', ${BLIZZARD_GUILD_ID}, ${REALM_ID} FROM guilds WHERE id = '${s.gid}'`);
    }
    return realBatch(statements);
  };
  const raced = await pinRaw(s);
  s.w.db.batch = realBatch;
  refuse(raced, 409, 'pin_taken');
  assert.deepEqual(await pinColumns(s), unpinned);
  assert.notEqual((await grantOf(s)).fresh_purpose, null, 'the rolled-back batch did not spend the grant');
  assert.equal(await s.w.count('fresh_act_markers'), 0);
  // Another game version or region is another Blizzard: no clash.
  s.exec("DELETE FROM guilds WHERE id = 'g_other_race'");
  s.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, game_version, discord_server_id, time_zone, created_at, created_by, pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id)
          SELECT 'g_other_eu', 'Other', 'Thunderstrike', realm_kind, 'EU', game_version, 'none:g_other_eu', time_zone, created_at, created_by, 'writers-b3', 'thunderstrike', 'profile-classicann-eu', ${BLIZZARD_GUILD_ID}, ${REALM_ID} FROM guilds WHERE id = '${s.gid}'`);
  assert.equal((await pinRaw(s)).status, 200);
});

check('re-pin: only to the SAME Blizzard guild (after a rename or a realm move), Owner + a new grant; another guild id is 409 pin_locked and nothing changes', async () => {
  const s = await pinWorld();
  assert.equal((await pin(s)).status, 200);
  // Blizzard renames the guild and moves it to another realm: the SAME guild id, a new realm id.
  s.live.realmId = 4002;
  s.exec(`DELETE FROM rate_limits`);
  const moved = { guildName: 'Writers Reborn', realmSlug: 'dreamscythe' };
  const rename = await pin(s, 'gm', moved);
  assert.equal(rename.status, 200, rename.text);
  assert.equal(rename.json.mode, 're_pin');
  assert.deepEqual(await pinColumns(s), {
    pinned_guild_slug: 'writers-reborn', pinned_realm_slug: 'dreamscythe', pinned_namespace: NAMESPACE, blizzard_guild_id: BLIZZARD_GUILD_ID, blizzard_realm_id: 4002,
  });
  const audit = await s.rows("SELECT after FROM audit_log WHERE action = 'guild.pin' ORDER BY created_at, id");
  assert.deepEqual(audit.map((row) => JSON.parse(row.after).rePin), [false, true]);
  // The same guild, same names: a re-pin that changes nothing still needs its grant and applies.
  assert.equal((await pin(s, 'gm', moved)).status, 200);
  // ANOTHER Blizzard guild: locked.
  s.live.guildId = 3001;
  const locked = await pin(s, 'gm', TARGET);
  refuse(locked, 409, 'pin_locked');
  assert.equal((await pinRow(s)).blizzard_guild_id, BLIZZARD_GUILD_ID);
  assert.equal((await pinRow(s)).pinned_guild_slug, 'writers-reborn');
  assert.notEqual((await grantOf(s)).fresh_purpose, null, 'a refusal does not spend the grant');
});

check('the first sync: a pin applies the fetched roster (no second fetch), an unchanged re-pin only advances the guard, a roster that is not GOOD pins NOTHING', async () => {
  const s = await pinWorld();
  const run = await measure(s, async () => { await grantPin(s); return pinRaw(s); });
  assert.equal(run.result.json.sync.status, 'applied');
  const row = await pinRow(s);
  assert(row.roster_hash && row.last_good_fetched_at);
  const stored = await s.rows('SELECT name, rank FROM guild_roster WHERE guild_id = ? ORDER BY rank', s.gid);
  assert.deepEqual(stored.map((member) => [member.name, member.rank]), [['Thelead', 0], ['Gmmain', 4]]);
  // Pinned again to the same roster: unchanged.
  s.w.advance(HOUR);
  const again = await pin(s);
  assert.equal(again.json.mode, 're_pin');
  assert.equal(again.json.sync.status, 'unchanged');
  assert.equal(await s.w.count('guild_roster'), 2);
  // A roster that is not GOOD (two rank-0 members; a guild id missing; a rank that is no number) is refused: nothing is pinned.
  for (const [label, edit, code] of [
    ['two rank 0', (members) => members.map((member) => ({ ...member, rank: 0 })), 'bnet_roster_invalid'],
  ]) {
    const t = await pinWorld();
    t.live.roster = edit(t.live.roster);
    await grantPin(t);
    const res = await pinRaw(t);
    refuse(res, 502, code);
    assert.equal(res.json.reason, 'several_rank_zero', label);
    assert.deepEqual(await pinColumns(t), unpinned, label);
    assert.equal(await t.w.count('guild_roster', 'guild_id = ?', t.gid), 0);
    assert.notEqual((await grantOf(t)).fresh_purpose, null, `${label}: the grant is kept`);
  }
  const u = await pinWorld();
  u.bnet.state.override.roster = () => ({ guild: { name: 'No Ids' }, members: [] });
  await grantPin(u);
  refuse(await pinRaw(u), 502, 'bnet_roster_invalid');
  assert.deepEqual(await pinColumns(u), unpinned);
  // A guild Blizzard has no record of, one it will not show, an outage.
  for (const [slugName, status, code] of [['missing', 404, 'bnet_guild_not_found'], ['refused', 502, 'bnet_guild_refused']]) {
    const v = await pinWorld();
    const target = { guildName: slugName, realmSlug: 'nightslayer' };
    await grantPin(v, 'gm', target);
    refuse(await pinRaw(v, 'gm', target), status, code);
    assert.deepEqual(await pinColumns(v), unpinned);
  }
  const w = await pinWorld();
  w.bnet.state.fail.roster = 500;
  await grantPin(w);
  refuse(await pinRaw(w), 502, 'bnet_unavailable');
  assert.deepEqual(await pinColumns(w), unpinned);
});

check('limits: above the 1,200 fetch limit is 409 roster_too_large, above 1,000 people is 409 roster_over_caps (nothing written); 1,000 members pin and sync', async () => {
  const s = await pinWorld({ members: [{ name: 'Thelead', id: ID.lead, rank: 0 }, { name: 'Gmmain', id: ID.gm, rank: 4 }, ...bulk(1198)] });
  await grantPin(s);
  const over = await pinRaw(s);
  refuse(over, 409, 'roster_over_caps');
  assert(/1000|1,000/.test(over.json.message), over.json.message);
  assert.deepEqual(await pinColumns(s), unpinned);
  s.live.roster = [{ name: 'Thelead', id: ID.lead, rank: 0 }, { name: 'Gmmain', id: ID.gm, rank: 4 }, ...bulk(1199)];
  refuse(await pinRaw(s), 409, 'roster_too_large');
  assert.deepEqual(await pinColumns(s), unpinned);
  assert.equal(await s.w.count('guild_roster'), 0);
  s.live.roster = [{ name: 'Thelead', id: ID.lead, rank: 0 }, { name: 'Gmmain', id: ID.gm, rank: 4 }, ...bulk(998)];
  const ok = await pinRaw(s);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.sync.members, 1000);
});

check('budget: a pin on a 1,000-member roster runs <= 45 D1 statements in the request (the batch, the first sync included) and 2 Blizzard requests; the callback that reads the characters is small', async () => {
  const s = await pinWorld({ members: [{ name: 'Thelead', id: ID.lead, rank: 0 }, { name: 'Gmmain', id: ID.gm, rank: 4 }, ...bulk(998)] });
  const callback = await measure(s, () => grantPin(s));
  assert.equal(callback.result.location, '/#/fresh?done=pin');
  const run = await measure(s, () => pinRaw(s));
  assert.equal(run.result.status, 200, run.result.text);
  assert.equal(run.result.json.sync.status, 'applied');
  assert(run.statements.length <= 45, `the pin used ${run.statements.length} D1 statements`);
  assert.equal(run.blizzard.length, 2, JSON.stringify(run.blizzard));
  assert.deepEqual(run.blizzard.map((request) => request.path.split('?')[0]).sort(), ['/data/wow/guild/nightslayer/writers-b3/roster', '/token']);
  assert.equal(await s.w.count('guild_roster'), 1000);
  // The callback: the session reads, the nonce, the limits, the link, the snapshot entry and the grant.
  assert(callback.statements.length <= 20, `the callback used ${callback.statements.length} statements`);
  assert.equal(callback.blizzard.filter((request) => request.path === '/profile/user/wow').length, 1, 'the account\'s characters are read once, in one namespace');
  console.log(`      measured: pin request ${run.statements.length} D1 statements, ${run.blizzard.length} Blizzard requests; the grant callback ${callback.statements.length} statements, ${callback.blizzard.length} requests (1,000 members)`);
  // No scan of a guild-sized table in the pin request.
  const scans = scansSince({ ...s.w.db, statementLog: run.statements, sqlite: s.w.db.sqlite }, 0);
  assert.deepEqual(scans, []);
  const seeded = scansSince({ ...s.w.db, statementLog: [{ sql: 'SELECT name FROM characters WHERE name = ?', values: ['x'] }], sqlite: s.w.db.sqlite }, 0);
  assert.equal(seeded.length, 1, 'positive control: an unbounded read of characters is reported');
});

check('the marker pattern: every statement of the batch after the consuming pair carries the marker; two parallel pins with one grant apply one; a swapped order applies nothing', async () => {
  const s = await pinWorld();
  await grantPin(s);
  const realBatch = s.w.db.batch.bind(s.w.db);
  const batches = [];
  s.w.db.batch = async (statements) => { batches.push(statements.map((statement) => statement.sql)); return realBatch(statements); };
  const first = await pinRaw(s);
  s.w.db.batch = realBatch;
  assert.equal(first.status, 200);
  const pinBatch = batches.find((statements) => statements.some((sql) => /UPDATE guilds SET pinned_guild_slug/.test(sql)));
  assert(pinBatch);
  assert(/UPDATE sessions SET fresh_purpose = NULL/.test(pinBatch[0]) && /INSERT INTO fresh_act_markers/.test(pinBatch[1]), 'the consuming pair first, adjacent');
  const unguarded = pinBatch.slice(2).filter((sql) => !/fresh_act_markers/.test(sql));
  assert.deepEqual(unguarded, [], 'a statement of the act without the marker');
  assert.equal(pinBatch.length, 4, 'consume, marker, the pin, the audit row');
  // Two parallel pins with ONE grant.
  const t = await pinWorld();
  await grantPin(t);
  const results = await Promise.all([pinRaw(t), pinRaw(t)]);
  const statuses = results.map((res) => res.status).sort();
  assert.deepEqual(statuses, [200, 403], results.map((res) => res.text).join(' | '));
  assert.equal(await t.w.count('fresh_act_markers', "purpose = 'pin'"), 1);
  assert.equal(await t.w.count('audit_log', "action = 'guild.pin'"), 1);
  // A SWAPPED statement order (the marker before the consume): refused deterministically, nothing applied, the grant not spent... it is the grant of this session, so look at the rows.
  const u = await pinWorld();
  await grantPin(u);
  const real = u.w.db.batch.bind(u.w.db);
  u.w.db.batch = async (statements) => {
    if (statements.some((statement) => /UPDATE guilds SET pinned_guild_slug/.test(statement.sql))) [statements[0], statements[1]] = [statements[1], statements[0]];
    return real(statements);
  };
  const swapped = await pinRaw(u);
  u.w.db.batch = real;
  refuse(swapped, 403, 'fresh_required');
  assert.deepEqual(await pinColumns(u), unpinned);
  assert.equal(await u.w.count('fresh_act_markers'), 0);
  assert.equal(await u.w.count('audit_log', "action = 'guild.pin'"), 0);
});

check('the pin is a fresh act with the Owner INSIDE the consume: an Owner who handed the seat over between the read and the batch pins nothing and keeps the grant', async () => {
  const s = await pinWorld();
  await s.member('new', 'Newowner');
  await grantPin(s);
  const real = s.w.db.batch.bind(s.w.db);
  s.w.db.batch = async (statements) => {
    if (statements.some((statement) => /UPDATE guilds SET pinned_guild_slug/.test(statement.sql))) {
      s.exec(`UPDATE guilds SET owner_user_id = '${s.uids.new}' WHERE id = '${s.gid}'`); // the seat moved (the stored Guild Master row no longer counts once the seat is set)
    }
    return real(statements);
  };
  const lost = await pinRaw(s);
  s.w.db.batch = real;
  refuse(lost, 403, 'fresh_required');
  assert.deepEqual(await pinColumns(s), unpinned);
  assert.notEqual((await grantOf(s)).fresh_purpose, null);
  assert.equal(await s.w.count('audit_log', "action = 'guild.pin'"), 0);
  // The guild changed under the request (a rank source chosen): the same, nothing written.
  const t = await pinWorld();
  await grantPin(t);
  const realT = t.w.db.batch.bind(t.w.db);
  t.w.db.batch = async (statements) => {
    if (statements.some((statement) => /UPDATE guilds SET pinned_guild_slug/.test(statement.sql))) t.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${t.gid}'`);
    return realT(statements);
  };
  refuse(await pinRaw(t), 403, 'fresh_required');
  t.w.db.batch = realT;
  assert.deepEqual(await pinColumns(t), unpinned);
});

check('rate limit: 6 tries per 10 minutes per Owner, then 429 (a refused try spends no grant); a limiter that cannot answer refuses (503, fail closed); a request that is refused earlier is not counted', async () => {
  const s = await pinWorld();
  s.live.profiles[ACC.gm.id] = [entry('Elsewhere', 9999)];
  await grantPin(s);
  for (let i = 0; i < 6; i++) refuse(await pinRaw(s), 403, 'pin_not_on_roster');
  const limited = await pinRaw(s);
  refuse(limited, 429, 'rate_limited');
  assert(limited.json.retryAfter > 0);
  assert.equal(guildFetches(s.bnet.state.requests).length, 6, 'the limited try made no Blizzard request');
  s.w.advance(16 * 60 * 1000);
  refuse(await pinRaw(s), 403, 'fresh_required'); // the grant has expired meanwhile: refused before the limiter is touched
  // Fail closed.
  const t = await pinWorld();
  await grantPin(t);
  const realPrepare = t.w.db.prepare.bind(t.w.db);
  t.w.db.prepare = (sql) => { if (/INSERT INTO rate_limits/.test(sql)) throw new Error('D1 down'); return realPrepare(sql); };
  const down = await pinRaw(t);
  t.w.db.prepare = realPrepare;
  refuse(down, 503, 'rate_limited');
  assert.equal(guildFetches(t.bnet.state.requests).length, 0);
  assert.deepEqual(await pinColumns(t), unpinned);
});

check('the settings read tells the page about the pin: pinned / complete / the slugs / pinOpen (additive); the pin is audited with its sentence in the Activity log', async () => {
  const s = await pinWorld();
  const before = (await s.call('gm', 'GET', '/bnet')).json;
  assert.deepEqual(before.pin, { pinned: false, complete: false, rankSource: null, guildSlug: null, realmSlug: null, namespace: null });
  assert.equal(before.pinOpen, true);
  assert.equal((await pin(s)).status, 200);
  const after = (await s.call('gm', 'GET', '/bnet')).json;
  assert.deepEqual(after.pin, { pinned: true, complete: true, rankSource: null, guildSlug: 'writers-b3', realmSlug: 'nightslayer', namespace: NAMESPACE });
  const log = await s.call('gm', 'GET', '/audit');
  assert.equal(log.status, 200, log.text);
  const row = (log.json.entries || log.json.rows || []).find((entry2) => entry2.action === 'guild.pin');
  assert(row, JSON.stringify(log.json).slice(0, 300));
  assert.match(row.sentence || row.text || row.summary || '', /Linked the guild to its in-game guild/);
});

// ---------------------------------------------------------------------------
// 2. The source/pin rules (plan "Source/pin" (1)-(6))

// Rule (1): every SQL text in worker/ that writes a pin column. The SET part of an UPDATE of guilds and the column list of an INSERT into it; a column named in a WHERE is a read.
const PIN_COLUMN = /\b(pinned_guild_slug|pinned_realm_slug|pinned_namespace|blizzard_guild_id|blizzard_realm_id)\b/;
function pinWritesIn(text) {
  const found = [];
  for (const match of text.matchAll(/UPDATE\s+(?:OR\s+\w+\s+)?guilds\s+SET\s+([\s\S]*?)\s+WHERE\b/g)) if (PIN_COLUMN.test(match[1])) found.push(match[0].replace(/\s+/g, ' ').slice(0, 80));
  for (const match of text.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+guilds\s*\(([^)]*)\)/g)) if (PIN_COLUMN.test(match[1])) found.push(match[0].replace(/\s+/g, ' ').slice(0, 80));
  return found;
}
function workerFiles(dir = 'worker') {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((item) => {
    const rel = `${dir}/${item.name}`;
    if (item.isDirectory()) return workerFiles(rel);
    return item.name.endsWith('.js') ? [rel] : [];
  });
}

check('rule (1): the pin columns are written by worker/guild-pin.js and nowhere else; the three writers have the callers the plan names (the setup pin; creation and the flip are not built); the CI grep sees a seeded violation', () => {
  assert.deepEqual(pinWritesIn("db.prepare('UPDATE guilds SET name = ?, blizzard_guild_id = ? WHERE id = ?')").length, 1, 'positive control');
  assert.deepEqual(pinWritesIn('UPDATE guilds SET roster_hash = ? WHERE id = ? AND blizzard_guild_id = ?'), [], 'a column in a WHERE is a read');
  assert.equal(pinWritesIn('INSERT OR REPLACE INTO guilds (id, name, pinned_namespace) VALUES (?, ?, ?)').length, 1, 'positive control: an INSERT');
  const writers = workerFiles().filter((file) => pinWritesIn(read(file)).length);
  assert.deepEqual(writers, ['worker/guild-pin.js']);
  assert.equal(pinWritesIn(read('worker/guild-pin.js')).length, 2, 'the pin write and the source switch');
  // Callers: the setup pin is called by its route only; the creation proof (lane B10) and the flip (lane B9) have a named writer and no caller yet.
  const callers = (name) => workerFiles().filter((file) => file !== 'worker/guild-pin.js' && new RegExp(`\\b${name}\\(`).test(read(file)));
  assert.deepEqual(callers('setupPinStatement'), ['worker/routes/bnet-pin.js']);
  assert.deepEqual(callers('creationPinStatement'), [], 'lane B10 adds its call and this expectation together');
  assert.deepEqual(callers('flipPinStatement'), [], 'lane B9 adds its call and this expectation together');
  assert.deepEqual(callers('sourceSwitchStatements'), [], 'lane B9 (flip and unflip)');
  // The fetches of a guild roster: the sync and the claim read the pin, the officer import reads rosterTarget (the pin), and the setup pin\'s own fetch is the one that names its target in the request.
  const fetchers = workerFiles().filter((file) => file !== 'worker/battlenet.js' && /\bfetchGuildRoster(?:BySlug)?\(/.test(read(file)));
  assert.deepEqual(fetchers, ['worker/gm-claim.js', 'worker/roster-sync.js', 'worker/routes/bnet-import.js', 'worker/routes/bnet-pin.js']);
});

check('rule (2): a pinned guild\'s fetches (the sync and the officer import) ask for the PINNED slugs - never the guild name, the saved Battle.net name or the guild\'s realm; the pin\'s own fetch names its target in the request', async () => {
  const s = await pinWorld();
  assert.equal((await s.call('gm', 'PUT', '/bnet', { guildName: 'Typed Name', rankLabels: [] })).status, 200);
  const target = { guildName: 'Ember Guild', realmSlug: 'dreamscythe' };
  const done = await pin(s, 'gm', target);
  assert.equal(done.status, 200, done.text);
  assert.equal((await s.call('gm', 'PATCH', '', { name: 'Zzz Display Name' })).status, 200);
  const rosterPaths = () => guildFetches(s.bnet.state.requests).map((request) => request.path.split('?')[0]);
  assert.deepEqual(rosterPaths(), ['/data/wow/guild/dreamscythe/ember-guild/roster'], 'the pin: the target of the request');
  s.w.advance(2 * HOUR);
  const sync = await s.call('gm', 'POST', '/roster-sync', {});
  assert.equal(sync.status, 200, sync.text);
  const preview = await s.call('gm', 'POST', '/roster/import/bnet/preview', { teamId: s.tids[0] });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(rosterPaths().slice(1), ['/data/wow/guild/dreamscythe/ember-guild/roster', '/data/wow/guild/dreamscythe/ember-guild/roster']);
  // A half pin is refused rather than completed from a display name, and so is one with no Blizzard guild id (a switch away from 'ingame' cut it): rule (5) needs ids to check.
  const { rosterTarget } = await load('worker/routes/bnet-import.js');
  const { pinOf } = await load('worker/roster-pin.js');
  const guild = { game_version: 'tbc', region: 'US', realm_kind: 'realm', realm_slug: 'nightslayer', realm: 'Nightslayer', name: 'Zzz Display Name' };
  const row = (over) => ({ rank_source: null, pinned_guild_slug: 'ember-guild', pinned_realm_slug: 'dreamscythe', pinned_namespace: NAMESPACE, blizzard_guild_id: 3000, blizzard_realm_id: 4001, ...over });
  assert.equal(rosterTarget(guild, { guildName: 'Typed Name' }, pinOf(row({}))).guildSlug, 'ember-guild');
  for (const over of [{ blizzard_guild_id: null }, { blizzard_realm_id: null }, { pinned_realm_slug: null }]) {
    assert.throws(() => rosterTarget(guild, { guildName: 'Typed Name' }, pinOf(row(over))), (error) => error.status === 409 && error.code === 'bnet_pin_incomplete', JSON.stringify(over));
  }
});

check('rule (3): once pinned PUT /bnet refuses a changed target (409 pinned, the field named) and saves the rank labels; PATCH /guild refuses a new realm (409 pinned) and still changes the name and the time zone', async () => {
  const s = await pinWorld();
  // Before the pin everything is as it was.
  assert.equal((await s.call('gm', 'PUT', '/bnet', { guildName: 'Typed Name', rankLabels: ['Boss'] })).status, 200);
  assert.equal((await s.call('gm', 'PATCH', '', { realm: 'Dreamscythe' })).status, 200);
  assert.equal((await s.call('gm', 'PATCH', '', { realm: 'Nightslayer' })).status, 200);
  assert.equal((await pin(s)).status, 200);
  const refused = await s.call('gm', 'PUT', '/bnet', { guildName: 'Other Name', rankLabels: ['Chief'] });
  refuse(refused, 409, 'pinned');
  assert.equal(refused.json.field, 'guildName');
  assert.equal((await s.call('gm', 'GET', '/bnet')).json.rankLabels[0], 'Boss', 'a refused PUT saves nothing');
  // The saved name sent back as it is, or left out, changes nothing; the labels are saved.
  for (const guildName of ['Typed Name', undefined, null, '']) {
    const ok = await s.call('gm', 'PUT', '/bnet', { ...(guildName === undefined ? {} : { guildName }), rankLabels: ['Chief'] });
    assert.equal(ok.status, 200, `${guildName}: ${ok.text}`);
    assert.equal(ok.json.guildName, 'Typed Name');
    assert.equal(ok.json.rankLabels[0], 'Chief');
  }
  const saved = await s.one('SELECT bnet_guild_name, bnet_realm_slug FROM guilds WHERE id = ?', s.gid);
  assert.deepEqual([saved.bnet_guild_name, saved.bnet_realm_slug], ['Typed Name', null]);
  // A ruleset guild\'s realm field is a target field too.
  s.exec(`UPDATE guilds SET realm_kind = 'ruleset' WHERE id = '${s.gid}'`);
  const realm = await s.call('gm', 'PUT', '/bnet', { realmSlug: 'old-blanchy', rankLabels: [] });
  refuse(realm, 409, 'pinned');
  assert.equal(realm.json.field, 'realmSlug');
  s.exec(`UPDATE guilds SET realm_kind = 'realm' WHERE id = '${s.gid}'`);
  // patchGuild: the realm is refused, the same realm is no change, the name and the time zone go through.
  const moved = await s.call('gm', 'PATCH', '', { realm: 'Dreamscythe' });
  refuse(moved, 409, 'pinned');
  assert.equal(moved.json.field, 'realm');
  assert.equal((await s.one('SELECT realm FROM guilds WHERE id = ?', s.gid)).realm, 'Nightslayer');
  assert.equal((await s.call('gm', 'PATCH', '', { realm: 'Nightslayer' })).status, 200);
  const renamed = await s.call('gm', 'PATCH', '', { name: 'A New Display Name', timeZone: 'America/Chicago' });
  assert.equal(renamed.status, 200, renamed.text);
  assert.deepEqual(await pinColumns(s), {
    pinned_guild_slug: 'writers-b3', pinned_realm_slug: 'nightslayer', pinned_namespace: NAMESPACE, blizzard_guild_id: BLIZZARD_GUILD_ID, blizzard_realm_id: REALM_ID,
  });
});

check('rule (4): the officer roster import is refused for an in-game guild (preview and commit, 409 bnet_import_ingame, before any Blizzard call); a pinned legacy guild\'s commit stamps namespace + realm id + character id from the same fetch', async () => {
  const s = await pinWorld();
  assert.equal((await pin(s)).status, 200);
  const team = s.tids[0];
  const calls = s.bnet.state.requests.length;
  const committed = await s.call('gm', 'POST', '/roster/import/bnet/commit', { teamId: team, defaultStatus: 'raider', members: [{ name: 'Gmmain', realmSlug: 'nightslayer' }] });
  assert.equal(committed.status, 201, committed.text);
  assert(s.bnet.state.requests.length > calls);
  assert.deepEqual(
    await s.rows("SELECT name, namespace, blizzard_realm_id, blizzard_char_id FROM characters WHERE guild_id = ? AND name = 'Gmmain'", s.gid),
    [{ name: 'Gmmain', namespace: NAMESPACE, blizzard_realm_id: REALM_ID, blizzard_char_id: ID.gm }],
  );
  // Now the guild runs on the in-game roster: the import is not for it.
  s.exec(`UPDATE guilds SET rank_source = 'ingame', owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  const mine = await s.one("SELECT player_id FROM characters WHERE guild_id = ? AND name = 'Gmmain'", s.gid);
  s.exec(`UPDATE players SET user_id = '${s.uids.gm}' WHERE id = '${mine.player_id}'`);
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.gm}', proof_bnet_account_id = '${ACC.gm.id}', proof_at = 1 WHERE player_id = '${mine.player_id}'`); // the Owner is live
  const asked = s.bnet.state.requests.length;
  for (const [route, body] of [['preview', { teamId: team }], ['commit', { teamId: team, defaultStatus: 'raider', members: [] }]]) {
    refuse(await s.call('gm', 'POST', `/roster/import/bnet/${route}`, body), 409, 'bnet_import_ingame');
  }
  assert.equal(s.bnet.state.requests.length, asked, 'refused before any Blizzard call');
});

check('rule (5): every fetch checks the Blizzard guild id and realm id against the pin - the sync and the officer import take a mismatch as NOT GOOD and change nothing; a pin with no guild id syncs and imports nothing', async () => {
  const s = await pinWorld();
  assert.equal((await pin(s)).status, 200);
  const before = { roster: await s.rows('SELECT * FROM guild_roster WHERE guild_id = ? ORDER BY blizzard_char_id', s.gid), row: await pinRow(s) };
  for (const [label, edit, reason] of [
    ['another guild', () => { s.live.guildId = 3001; }, 'guild_id_mismatch'],
    ['another realm', () => { s.live.guildId = BLIZZARD_GUILD_ID; s.live.realmId = 4002; }, 'realm_id_mismatch'],
  ]) {
    edit();
    s.live.roster = [{ name: 'Thelead', id: ID.lead, rank: 0 }, { name: 'Newcomer', id: 9310, rank: 3 }];
    s.w.advance(2 * HOUR);
    const sync = await s.call('gm', 'POST', '/roster-sync', {});
    assert.equal(sync.status, 200, sync.text);
    assert.deepEqual([sync.json.status, sync.json.reason], ['failed', reason], label);
    assert.deepEqual(await s.rows('SELECT * FROM guild_roster WHERE guild_id = ? ORDER BY blizzard_char_id', s.gid), before.roster, `${label}: the stored roster is untouched`);
    assert.equal((await pinRow(s)).roster_hash, before.row.roster_hash);
    s.w.advance(2 * HOUR);
    const preview = await s.call('gm', 'POST', '/roster/import/bnet/preview', { teamId: s.tids[0] });
    refuse(preview, 502, 'bnet_roster_invalid');
    assert.equal(preview.json.reason, reason, label);
  }
  // A pin whose Blizzard guild id was cut (the switch away from 'ingame'): nothing to check an answer against, so nothing is fetched for it.
  s.live.guildId = BLIZZARD_GUILD_ID;
  s.live.realmId = REALM_ID;
  s.exec(`UPDATE guilds SET blizzard_guild_id = NULL WHERE id = '${s.gid}'`);
  const calls = s.bnet.state.requests.length;
  s.w.advance(2 * HOUR);
  refuse(await s.call('gm', 'POST', '/roster-sync', {}), 409, 'not_pinned');
  refuse(await s.call('gm', 'POST', '/roster/import/bnet/preview', { teamId: s.tids[0] }), 409, 'bnet_pin_incomplete');
  assert.equal(guildFetches(s.bnet.state.requests.slice(calls)).length, 0);
});

check('rule (6): leaving \'ingame\' is a source_switch fresh act that nulls blizzard_guild_id (and only that); the helper is a compare-and-set under the marker; a switch between the legacy rule and manual needs no Battle.net grant; no route switches the source', async () => {
  const sw = await load('worker/guild-pin.js');
  const { ROUTES } = await load('worker/index.js');
  assert.deepEqual(ROUTES.filter((route) => /switch|rank-source|rank_source/i.test(route.path)), [], 'no user-facing switch route');
  assert.equal(sw.sourceSwitchProblem(null, 'ingame'), null);
  assert.match(sw.sourceSwitchProblem('ingame', 'ingame'), /already/);
  assert.match(sw.sourceSwitchProblem('ingame', 'discord'), /legacy rule/);
  assert.deepEqual([sw.involvesIngame(null, 'manual'), sw.involvesIngame('manual', 'ingame'), sw.involvesIngame('ingame', null)], [false, true, true]);
  assert.deepEqual([sw.leavesIngame('ingame', 'manual'), sw.leavesIngame(null, 'ingame'), sw.leavesIngame('manual', null)], [true, false, false]);

  const s = await pinWorld();
  assert.equal((await pin(s)).status, 200);
  // The Owner holds the seat and is LIVE in the in-game guild (a character proved by Battle.net on the roster): the Owner test inside the consuming UPDATE needs it.
  const mine = await s.person({ name: 'Gmmaina' });
  await s.link(mine.pid, 'gm');
  makeProven(s, 'gm', mine, { rank: 4, id: ID.gm });
  await s.setOwner('gm');
  const ctxOf = (key = 'gm') => ({ db: s.w.db, now: () => s.w.clock.now, randomBytes: s.w.randomBytes, session: { tokenHash: s.sessionHash(key), user: { id: s.uids[key] } } });
  const sourceOf = async () => (await pinRow(s)).rank_source;
  const run = async (from, to, key = 'gm') => {
    const ctx = ctxOf(key);
    const act = await sw.beginSourceSwitch(ctx, { guildId: s.gid, from, to });
    const results = await s.w.db.batch([...act.statements, ...sw.sourceSwitchStatements(ctx, { guildId: s.gid, from, to, guard: act.guard })]);
    return { act, results };
  };
  // To 'ingame' (from the legacy rule): a Battle.net grant is needed; the pin is untouched.
  await assert.rejects(() => run(null, 'ingame'), (error) => error.code === 'fresh_required' && error.status === 403);
  await s.grant('gm', { purpose: 'source_switch', guildId: s.gid, params: { from: null, to: 'ingame' } });
  const into = await run(null, 'ingame');
  assert(into.act.consumed(into.results));
  assert.equal(await sourceOf(), 'ingame');
  assert.equal((await pinRow(s)).blizzard_guild_id, BLIZZARD_GUILD_ID, 'switching TO ingame keeps the pin');
  assert.deepEqual(await grantOf(s), NO_GRANT);
  // A grant for another switch is no grant for this one.
  await s.grant('gm', { purpose: 'source_switch', guildId: s.gid, params: { from: null, to: 'ingame' } });
  await assert.rejects(() => run('ingame', null), (error) => error.code === 'fresh_required');
  assert.equal(await sourceOf(), 'ingame');
  // Away from 'ingame': the grant is consumed, rank_source moves, blizzard_guild_id is NULL, the rest of the pin stays.
  await s.grant('gm', { purpose: 'source_switch', guildId: s.gid, params: { from: 'ingame', to: null } });
  const away = await run('ingame', null);
  assert(away.act.consumed(away.results));
  assert.equal(away.results[away.act.offset].meta.changes, 1);
  assert.equal(await sourceOf(), null);
  assert.deepEqual(await pinColumns(s), {
    pinned_guild_slug: 'writers-b3', pinned_realm_slug: 'nightslayer', pinned_namespace: NAMESPACE, blizzard_guild_id: null, blizzard_realm_id: REALM_ID,
  });
  const audit = await s.rows("SELECT before, after, actor_role FROM audit_log WHERE action = 'guild.source_switch' ORDER BY created_at, id");
  assert.deepEqual(audit.map((row) => [JSON.parse(row.before).rankSource, JSON.parse(row.after).rankSource, JSON.parse(row.after).unpinned, row.actor_role]), [[null, 'ingame', false, 'owner'], ['ingame', null, true, 'owner']]);
  // Compare-and-set: the guild is not what the caller read, so nothing changes (and no audit row).
  s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  await s.grant('gm', { purpose: 'source_switch', guildId: s.gid, params: { from: 'ingame', to: null } });
  const stale = await run('ingame', null);
  assert.equal(stale.results[stale.act.offset].meta.changes, 0);
  assert.equal(await sourceOf(), 'manual');
  assert.equal(await s.w.count('audit_log', "action = 'guild.source_switch'"), 2);
  // legacy <-> manual: session only, no grant, the pin untouched.
  const manual = await run('manual', null);
  assert.equal(manual.act.required, false);
  assert.equal(manual.results[manual.act.offset].meta.changes, 1);
  assert.equal(await sourceOf(), null);
  // Only the Owner: an Officer\'s own grant does not move the source.
  await s.officer('off', 'Officerone');
  await s.grant('off', { purpose: 'source_switch', guildId: s.gid, params: { from: null, to: 'ingame' } });
  const notOwner = await run(null, 'ingame', 'off');
  assert.equal(notOwner.act.consumed(notOwner.results), false);
  assert.equal(await sourceOf(), null);
  // The Blizzard guild is free again: another Raidsmith guild can take it, and this guild may be pinned to ANY guild (nothing is locked: the id is gone).
  s.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, game_version, discord_server_id, time_zone, created_at, created_by, pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id)
          SELECT 'g_takes_it', 'Other', realm, realm_kind, region, game_version, 'none:g_takes_it', time_zone, created_at, created_by, 'writers-b3', 'nightslayer', '${NAMESPACE}', ${BLIZZARD_GUILD_ID}, ${REALM_ID} FROM guilds WHERE id = '${s.gid}'`);
  s.live.guildId = 3002;
  const freshPin = await pin(s);
  assert.equal(freshPin.status, 200, freshPin.text);
  assert.equal(freshPin.json.mode, 'first', 'with no Blizzard guild id the pin is not locked');
  assert.equal((await pinRow(s)).blizzard_guild_id, 3002);
});

// ---------------------------------------------------------------------------
// 3. The Discord role-sync gate

const D_OFFICERS = '700000000000000001';
// A direct call of the sync with a fake bot: the Discord roles every account holds, and every call counted.
async function discordWorld(rankSource = null) {
  const s = await pinWorld();
  for (const key of ['mem', 'out']) await s.member(key, key === 'mem' ? 'Memberone' : 'Outsidertwo');
  const discordIdOf = async (key) => (await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids[key])).discord_id;
  // The Owner is live (a character proved by Battle.net on the roster, the seat) and 'mem' is linked to a person on the roster: both are members of the guild by ANY rank source.
  const own = await s.person({ name: 'Ownermain' });
  await s.link(own.pid, 'gm');
  makeProven(s, 'gm', own, { rank: 4, id: 9599 });
  await s.setOwner('gm');
  const linked = await s.person({ name: 'Memberone' });
  await s.link(linked.pid, 'mem');
  makeProven(s, 'mem', linked, { rank: 5, id: 9500, proof: 'officer', link: false });
  const calls = [];
  const roles = {};
  s.bot = {
    calls,
    roles,
    ctx: {
      db: s.w.db, env: { ...s.w.env, DISCORD_BOT_TOKEN: 'bot-token' }, now: () => s.w.clock.now, randomBytes: s.w.randomBytes, log: () => {},
      fetch: async (url) => {
        calls.push(String(url));
        const member = /\/members\/(\d+)$/.exec(String(url));
        return Response.json({ user: { id: member[1] }, roles: roles[member[1]] || [] });
      },
    },
    guild: { id: s.gid, discord_server_id: s.serverId },
  };
  s.exec(`INSERT INTO discord_role_maps (guild_id, discord_role_id, role_id, team_id) VALUES ('${s.gid}', '${D_OFFICERS}', 'officer', NULL)`);
  for (const key of ['mem', 'out']) roles[await discordIdOf(key)] = [D_OFFICERS];
  if (rankSource) s.exec(`UPDATE guilds SET rank_source = '${rankSource}' WHERE id = '${s.gid}'`);
  s.discordRows = () => s.rows("SELECT user_id, role_id, source FROM role_assignments WHERE guild_id = ? AND source = 'discord' ORDER BY user_id", s.gid);
  return s;
}

check('Discord gate: a legacy guild still gets its roles from Discord (control); a guild with a rank source gets NONE - syncMember skips (reason rank_source), reads nothing from Discord, writes no role and no audit row', async () => {
  const { syncMember } = await load('worker/discord-sync.js');
  const legacy = await discordWorld();
  const done = await syncMember(legacy.bot.ctx, legacy.bot.guild, legacy.uids.mem);
  assert.deepEqual(done, { status: 'changed', added: 1, removed: 0 });
  assert.deepEqual((await legacy.discordRows()).map((row) => [row.user_id, row.role_id]), [[legacy.uids.mem, 'officer']]);
  assert.equal(legacy.bot.calls.length, 1);
  for (const source of ['ingame', 'manual']) {
    const s = await discordWorld(source);
    // A member of the guild by its own rule ('mem') and a Discord-server-only account ('out', a NON-MEMBER of an in-game or manual guild): both skipped.
    for (const key of ['mem', 'out']) {
      assert.deepEqual(await syncMember(s.bot.ctx, s.bot.guild, s.uids[key]), { status: 'skipped', reason: 'rank_source' }, `${source} ${key}`);
    }
    assert.equal(s.bot.calls.length, 0, `${source}: nothing was read from Discord`);
    assert.deepEqual(await s.discordRows(), []);
    assert.equal(await s.w.count('audit_log', "action = 'roles.discord_sync'"), 0);
    // What was there stays exactly as it is: no add, no removal (a leftover Discord row of a guild that has a rank source is not this sync's to touch).
    s.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('ra_left_${source}', '${s.gid}', '${s.uids.out}', 'officer', NULL, 'discord', 1)`);
    s.bot.roles[(await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.out)).discord_id] = [];
    assert.deepEqual(await syncMember(s.bot.ctx, s.bot.guild, s.uids.out), { status: 'skipped', reason: 'rank_source' });
    assert.equal((await s.discordRows()).length, 1);
  }
});

check('Discord gate: the sign-in sync and Sync everyone read nobody in a guild with a rank source, and the mapping route refuses (409 discord_roles_off) without deleting a role; GET stays readable', async () => {
  const { syncSignIn, syncGuildMembers } = await load('worker/discord-sync.js');
  for (const source of ['ingame', 'manual']) {
    const s = await discordWorld(source);
    await syncSignIn(s.bot.ctx, s.uids.mem);
    assert.deepEqual(await syncGuildMembers(s.bot.ctx, s.bot.guild, { actorId: s.uids.gm }), { processed: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0, problem: null, next: null });
    assert.equal(s.bot.calls.length, 0, `${source}: Discord was not asked`);
    s.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('ra_d_${source}', '${s.gid}', '${s.uids.mem}', 'officer', NULL, 'discord', 1)`);
    const maps = [{ discordRoleId: '700000000000000002', roleId: 'officer', teamId: null }];
    const refused = await s.call('gm', 'PUT', '/discord/maps', { maps });
    refuse(refused, 409, 'discord_roles_off');
    assert(new RegExp(source === 'ingame' ? 'in-game' : 'by hand').test(refused.json.message), refused.json.message);
    refuse(await s.call('gm', 'POST', '/discord/sync', {}), 409, 'discord_roles_off');
    assert.equal(await s.w.count('discord_role_maps', 'guild_id = ?', s.gid), 1, 'the stored mapping is as it was');
    assert.equal((await s.discordRows()).length, 1, 'the mapping route deleted no role');
    assert.equal((await s.call('gm', 'GET', '/discord')).status, 200);
  }
  // Control: a legacy guild takes the mapping and the sign-in sync reads the server's members.
  const legacy = await discordWorld();
  await syncSignIn(legacy.bot.ctx, legacy.uids.mem);
  assert.equal(legacy.bot.calls.length, 1);
  assert.equal((await legacy.call('gm', 'PUT', '/discord/maps', { maps: [{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }] })).status, 200);
});

check('Discord gate: the writes carry the test too - a flip between the sync\'s read and its write gives no role and writes no audit row', async () => {
  const { syncMember } = await load('worker/discord-sync.js');
  const s = await discordWorld();
  const real = s.w.db.batch.bind(s.w.db);
  let calls = 0;
  s.w.db.batch = async (statements) => {
    calls += 1;
    if (calls === 2) s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`); // the sync's own write batch: the guild has been switched meanwhile
    return real(statements);
  };
  const result = await syncMember(s.bot.ctx, s.bot.guild, s.uids.mem);
  s.w.db.batch = real;
  assert.equal(calls, 2, 'read batch, write batch');
  assert.equal(result.status, 'changed', 'the sync believed it had written');
  assert.deepEqual(await s.discordRows(), []);
  assert.equal(await s.w.count('audit_log', "action = 'roles.discord_sync'"), 0);
});

// ---------------------------------------------------------------------------
// 4. The flip dry run: permission lines and the Owner line

const { setMap, DEFAULT_MAP } = require('../guild-ingame');
const rolesTable = (s) => s.rows("SELECT user_id, role_id, COALESCE(team_id, '') AS team_id FROM effective_roles WHERE guild_id = ? GROUP BY user_id, role_id, team_id ORDER BY user_id, role_id, team_id", s.gid);
const tupleKey = (row) => `${row.user_id}|${row.role_id}|${row.team_id}`;

// A legacy guild with one account of every kind the permission lines treat differently. The map is the default one plus rank 6 -> a custom role.
async function permissionWorld({ ownerLive = true } = {}) {
  const s = await pinWorld();
  const custom = (await s.ok('gm', 'POST', '/roles', { name: 'Loot helper', permissions: { 'loot.view': 'guild' } }, 201)).roles.find((role) => role.name === 'Loot helper').id;
  s.customRole = custom;
  setMap(s, [...DEFAULT_MAP, { rank: 6, label: 'Looter', coreRank: 'raider', roleId: custom }]);
  let nextId = 9600;
  const account = async (key, name, rank, { teamId, leftOn = null, proof = 'bnet', link = true } = {}) => {
    await s.member(key, name);
    const made = await s.person({ name, ...(teamId === undefined ? {} : { teamId }) });
    await s.link(made.pid, key);
    const id = ++nextId;
    makeProven(s, key, made, { rank, id, proof, link });
    if (leftOn) s.exec(`UPDATE characters SET left_on = '${leftOn}' WHERE id = '${made.cid}'`);
    return { ...made, id };
  };
  s.people = {};
  // The Owner is the account 'gm' of the fixture (its Battle.net link exists already); its person is made here.
  if (ownerLive) {
    const made = await s.person({ name: 'Ownermain' });
    await s.link(made.pid, 'gm');
    makeProven(s, 'gm', made, { rank: 4, id: 9599 });
    s.people.gm = { ...made, id: 9599 };
  }
  s.people.offr = await account('offr', 'Dofficer', 1);
  s.people.lead = await account('lead', 'Derivedlead', 2, { teamId: s.tids[0] });
  s.people.lead2 = await account('lead2', 'Teamlesslead', 2, { teamId: null });
  s.people.gmx = await account('gmx', 'Derivedgm', 0);
  s.people.loot = await account('loot', 'Derivedloot', 6);
  s.people.plain = await account('plain', 'Plainraider', 4);
  s.people.former = await account('former', 'Formerofc', 1, { leftOn: '2026-10-01' });
  s.people.handproof = await account('handproof', 'Handproof', 1, { proof: 'officer', link: false });
  // Best rank wins: a second character at rank 2 does not add Team Lead to an account whose best is rank 1.
  s.people.multi = await account('multi', 'Multirank', 1);
  const alt = await s.alt(s.people.multi.pid, 'Multialt', {});
  s.exec(`UPDATE characters SET owner_proof = 'bnet', proof_user_id = '${s.uids.multi}', proof_bnet_account_id = (SELECT bnet_account_id FROM bnet_links WHERE user_id = '${s.uids.multi}'), proof_at = 1, namespace = '${NAMESPACE}', blizzard_realm_id = ${REALM_ID}, blizzard_char_id = 9700, team_id = '${s.tids[1]}' WHERE id = '${alt}'`);
  s.exec(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES ('${s.gid}', '${NAMESPACE}', ${REALM_ID}, 9700, 'Multialt', 'multialt', 'nightslayer', 'ROGUE', 70, 2)`);
  // Stored roles today: a hand-set Officer (not proven: an officer's proof only), Discord-given Officers (one with a hand-set twin).
  s.people.oldoff = await account('oldoff', 'Oldofficer', 5, { proof: 'officer', link: false });
  await s.ok('gm', 'PUT', `/people/${s.uids.oldoff}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  s.people.disc = await account('disc', 'Discordoff', 5, { proof: 'officer', link: false });
  s.people.disc2 = await account('disc2', 'Discordtwin', 5, { proof: 'officer', link: false });
  await s.ok('gm', 'PUT', `/people/${s.uids.disc2}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  for (const [key, id] of [['disc', 'ra_disc'], ['disc2', 'ra_disc2']]) {
    s.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_at) VALUES ('${id}', '${s.gid}', '${s.uids[key]}', 'officer', NULL, 'discord', 1)`);
  }
  return s;
}
const dryRun = (s, who = 'gm') => s.call(who, 'POST', '/flip/dry-run', {});
const sampleKeys = (list) => list.samples.map((sample) => [sample.name, sample.roleId, sample.teamId || null]);

check('dry run, permissions: who gains and loses a role at the flip - derived Officer / Team Lead (the team of the character) / Guild Master / a custom role; the best rank wins; Former, hand-proof and teamless cases give nothing; stored Discord rows are listed as becoming hand-set', async () => {
  const s = await permissionWorld();
  const res = await dryRun(s);
  assert.equal(res.status, 200, res.text);
  const { permissions, owner } = res.json;
  assert.deepEqual(Object.keys(res.json).sort(), ['access', 'discordOwned', 'expiresAt', 'owner', 'permissions', 'rankSource', 'rosterSyncId', 'token'], 'additive: the older sections are still there');
  const byName = (a, b) => a[0].localeCompare(b[0]);
  assert.deepEqual(sampleKeys(permissions.gains).sort(byName), [
    ['Derivedgm', 'guild_master', null],
    ['Derivedlead', 'team_lead', s.tids[0]],
    ['Derivedloot', s.customRole, null],
    ['Dofficer', 'officer', null],
    ['Multirank', 'officer', null],
  ].sort(byName));
  assert.equal(permissions.gains.count, 5);
  assert.deepEqual(permissions.gains.byRole, { guild_master: 1, team_lead: 1, [s.customRole]: 1, officer: 2 });
  assert.deepEqual(permissions.gains.reasons, { rank: 5 });
  assert.equal(permissions.gains.samples.find((sample) => sample.name === 'Derivedlead').teamName, 'Alpha');
  assert.equal(permissions.gains.samples.find((sample) => sample.name === 'Derivedloot').roleName, 'Loot helper');
  // Nobody loses a role: the Owner is live, the Discord rows become hand-set rows and keep their tuple.
  assert.deepEqual([permissions.loses.count, permissions.loses.samples], [0, []]);
  // The stored Discord-given rows: both listed; one already has a hand-set twin (the converted row is dropped).
  assert.equal(permissions.discordRoles.count, 2);
  assert.equal(permissions.discordRoles.withHandTwin, 1);
  assert.deepEqual(permissions.discordRoles.samples.map((sample) => [sample.name, sample.roleId, sample.handTwin]).sort(), [['Discordoff', 'officer', false], ['Discordtwin', 'officer', true]]);
  // The Owner line.
  assert.deepEqual([owner.exists, owner.name, owner.live, owner.willBeSuspended, owner.reason, owner.source, owner.userId], [true, 'Ownermain', true, false, 'live', 'stored_guild_master', s.uids.gm]);
  assert.equal(owner.via.rank, 4);
  assert.equal(owner.rosterStored, true);
  // No Discord ID and no BattleTag in the new lines.
  const discordIds = (await s.rows('SELECT discord_id FROM users WHERE discord_id IS NOT NULL')).map((row) => row.discord_id);
  for (const id of discordIds) assert(!res.text.includes(id), 'a Discord ID in the answer');
  assert(!/battletag|#75/i.test(res.text));
  // The token covers the lines: the same state hashes the same, a changed rank map changes it.
  const { previewFlip } = await load('worker/flip-preview.js');
  const one = await previewFlip(s.w.db, s.gid);
  const two = await previewFlip(s.w.db, s.gid);
  assert.equal(one.stateHash, two.stateHash);
  s.exec(`UPDATE source_rank_maps SET role_id = 'officer' WHERE guild_id = '${s.gid}' AND source = 'ingame' AND source_key = '2'`);
  const changed = await previewFlip(s.w.db, s.gid);
  assert.notEqual(changed.stateHash, one.stateHash, 'a changed rank map makes the token stale');
  assert.equal(changed.payload.permissions.gains.byRole.team_lead, undefined);
});

check('dry run, permissions: the lines are what the in-game rule really does - after the flip is made by hand (the seat, the Guild Master row gone, Discord rows made hand-set) the accounts\' roles differ from before by exactly the listed gains and losses', async () => {
  const s = await permissionWorld();
  const body = (await dryRun(s)).json;
  const before = await rolesTable(s);
  // The flip, by hand.
  s.exec(`UPDATE guilds SET rank_source = 'ingame', owner_user_id = '${s.uids.gm}' WHERE id = '${s.gid}'`);
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  s.exec(`UPDATE OR IGNORE role_assignments SET source = 'manual' WHERE guild_id = '${s.gid}' AND source = 'discord'`);
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND source = 'discord'`);
  const after = await rolesTable(s);
  const was = new Set(before.map(tupleKey));
  const now = new Set(after.map(tupleKey));
  const gained = [...now].filter((key) => !was.has(key)).sort();
  const lost = [...was].filter((key) => !now.has(key)).sort();
  const listed = (list) => list.samples.map((sample) => `${sample.userId}|${sample.roleId}|${sample.teamId || ''}`).sort();
  assert.equal(gained.length, 5);
  assert.deepEqual(listed(body.permissions.gains), gained);
  assert.deepEqual(listed(body.permissions.loses), lost);
  assert.equal(body.permissions.gains.count, gained.length);
  // The Owner stays the Owner and is live.
  assert.deepEqual(rolesOf(s, 'gm').map((row) => row[0]), ['guild_master']);
  assert.equal(body.owner.live, true);
  // The converted rows: both Discord officers still hold Officer, now by hand; the one with a twin has a single row.
  assert.deepEqual((await s.rows("SELECT source FROM role_assignments WHERE guild_id = ? AND role_id = 'officer' AND user_id IN (?, ?) ORDER BY user_id", s.gid, s.uids.disc, s.uids.disc2)).map((row) => row.source), ['manual', 'manual']);
});

check('dry run, the Owner line: an Owner who will NOT be live on the stored roster (no proven character, the proven character is off the roster, nothing stored at all) is SUSPENDED after the flip - they lose the Guild Master role, drop out of access, and the lines say so; a Former proven character still on the roster keeps them live', async () => {
  const { previewFlip } = await load('worker/flip-preview.js');
  // No character of the Owner is proven by Battle.net.
  const a = await permissionWorld({ ownerLive: false });
  const none = (await dryRun(a)).json;
  assert.deepEqual([none.owner.exists, none.owner.live, none.owner.willBeSuspended, none.owner.reason, none.owner.via], [true, false, true, 'no_proven_character', null]);
  assert.deepEqual(none.permissions.loses.samples.map((sample) => [sample.userId, sample.roleId, sample.reason]), [[a.uids.gm, 'guild_master', 'owner_not_live']]);
  assert.deepEqual(none.permissions.loses.reasons, { owner_not_live: 1 });
  // The Owner is a member today (they sit in the Discord server) and not after the flip: the access section agrees.
  assert(none.access.loses.samples.some((sample) => sample.userId === a.uids.gm), 'the suspended Owner loses access with the others');
  assert.equal(none.access.gains.reasons.owner, undefined);
  // The proven character is off the stored roster (the roster moved on): not live.
  const b = await permissionWorld();
  assert.equal((await dryRun(b)).json.owner.live, true);
  b.exec(`DELETE FROM guild_roster WHERE guild_id = '${b.gid}' AND blizzard_char_id = ${b.people.gm.id}`);
  const off = (await dryRun(b)).json;
  assert.deepEqual([off.owner.live, off.owner.reason, off.owner.rosterStored], [false, 'no_proven_character', true]);
  assert.equal(off.permissions.loses.samples[0].reason, 'owner_not_live');
  // Nothing stored at all (the guild was never pinned): reason no_roster.
  const c = await pinWorld();
  const empty = (await dryRun(c)).json;
  assert.deepEqual([empty.owner.live, empty.owner.reason, empty.owner.rosterStored, empty.owner.rosterFetchedAt], [false, 'no_roster', false, null]);
  // A Former proven character that is still on the roster keeps the Owner live (the rule of the Owner view), but gives no derived role.
  const d = await permissionWorld();
  d.exec(`UPDATE characters SET left_on = '2026-10-01' WHERE id = '${d.people.gm.cid}'`);
  const former = (await dryRun(d)).json;
  assert.deepEqual([former.owner.live, former.owner.reason], [true, 'live']);
  // The token covers the Owner line: the same guild, the Owner made live or not, hashes differently.
  const missing = await previewFlip(b.w.db, b.gid);
  b.exec(`INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES ('${b.gid}', '${NAMESPACE}', ${REALM_ID}, ${b.people.gm.id}, 'Back', 'back', 'nightslayer', 'MAGE', 70, 4)`);
  const back = await previewFlip(b.w.db, b.gid);
  assert.notEqual(missing.stateHash, back.stateHash);
  assert.equal(missing.payload.owner.live, false);
  assert.equal(back.payload.owner.live, true);
  // A guild without an Owner at all.
  const e = await pinWorld();
  e.exec(`DELETE FROM role_assignments WHERE guild_id = '${e.gid}' AND role_id = 'guild_master'`);
  const ownerless = await previewFlip(e.w.db, e.gid);
  assert.deepEqual([ownerless.payload.owner.exists, ownerless.payload.owner.reason], [false, 'no_owner']);
});

check('dry run, the Owner line follows the seat, and B5 open point (c): an Owner who is no member under the legacy rule runs the dry run (the others are refused as before)', async () => {
  const s = await permissionWorld();
  // The seat is held by somebody who is in no Discord server and linked to no person: the legacy rule does not let them in.
  await s.outsider('seat', 'Seatholder');
  await s.setOwner('seat');
  refuse(await s.call('seat', 'GET', ''), 403, 'not_member');
  const ok = await dryRun(s, 'seat');
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.owner.userId, ok.json.owner.source, ok.json.owner.live, ok.json.owner.name], [s.uids.seat, 'seat', false, 'Seatholder']);
  assert.equal(await s.w.count('dry_run_approvals', 'approver_user_id = ?', s.uids.seat), 1, 'the token is the Owner\'s');
  // The same refusals as before for everybody else: a stranger is not a member, an Officer and the Guild Master by role are not the Owner, a signed-out caller is 401, no guild is 404.
  await s.outsider('stranger', 'Strangerthree');
  refuse(await dryRun(s, 'stranger'), 403, 'not_member');
  refuse(await dryRun(s, 'offr'), 403, 'forbidden');
  refuse(await dryRun(s, 'gm'), 403, 'forbidden');
  assert.equal((await s.w.call({}, 'POST', `${s.base}/flip/dry-run`, {})).status, 401);
  refuse(await s.call('seat', 'POST', '/api/guild/g_NoSuchGuild00000000000/flip/dry-run', {}), 404, 'not_found');
});

check('dry run: the new lines read the guild by index (no scan of players, characters, guild_roster, role_assignments or guilds) in 4 statements of the one snapshot', async () => {
  const s = await permissionWorld();
  const { FLIP_SECTIONS } = await load('worker/flip-preview.js');
  assert.deepEqual(FLIP_SECTIONS.map((section) => section.key), ['access', 'discordOwned', 'permissions', 'owner']);
  const statements = FLIP_SECTIONS.filter((section) => ['permissions', 'owner'].includes(section.key)).flatMap((section) => section.statements(s.w.db, s.gid));
  assert.equal(statements.length, 4);
  const mark = s.w.db.statementLog.length;
  await s.w.db.batch(statements);
  assert.deepEqual(scansSince(s.w.db, mark), []);
  const total = await measure(s, () => dryRun(s));
  assert(total.statements.length <= 20, `the dry run used ${total.statements.length} statements`);
  console.log(`      measured: the dry run ran ${total.statements.length} D1 statements`);
});

runChecks(checks);
