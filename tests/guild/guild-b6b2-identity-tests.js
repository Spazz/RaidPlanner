/**
 * Raidsmith guild tracker - lane B6b part 2a of the user-hierarchy build: IDENTITY-CHANGE PROTECTION (worker/fresh.js, the link and unlink routes, the first-link columns)
 * Run: node tests/guild/guild-b6b2-identity-tests.js
 *
 *   - every writer sets the first-link time (users.discord_linked_at, bnet_links.first_linked_at) and nothing moves it but unlink + link;
 *   - no age rule (the former rule (a) was removed by user decision 2026-10-29): every identity linked to the account confirms hand-over, guild delete, pin and source switch at once,
 *     however young the link; the SQL guard and the pure read agree;
 *   - rule (b): on an account that holds the Owner seat or any stored or derived staff role anywhere, linking, replacing or unlinking either identity is itself a fresh-auth act
 *     (purpose identity_change, params { change }), consumed inside the batch; any other account needs none;
 *   - rule (c): every identity change nulls the account's grants and is audited (identity.change, never pruned) in each guild the account is a member of;
 *   - the scenarios of the plan: link your own Battle.net in the session, then hand-over / delete / pin / source switch pass at once; a Battle.net refresh then pin passes; unlink +
 *     relink then pin passes at once; a Discord-first Guild Master links Battle.net and claims at once.
 * Drives worker/index.js over the node:sqlite D1 stand-in, Discord faked by an injected fetch, Battle.net by tools/fake-battlenet.js on a local port.
 */
const assert = require('node:assert/strict');
const { load, runChecks } = require('../guild-b3-world');
const { freshScenario, sessionHashOf } = require('../guild-fresh');
const { adminOf, signIn } = require('../guild-world');
const { flip, makeProven } = require('../guild-ingame');

const checks = [];
function check(name, fn) {
  checks.push({
    name,
    fn: async () => {
      globalThis.__identityWorlds = [];
      try { await fn(); } finally { await Promise.all(globalThis.__identityWorlds.map((s) => s.close())); }
    },
  });
}
const DAY = 24 * 60 * 60 * 1000;
const BNET = {
  gm: { id: '740000001', battletag: 'Gm#0001' }, ivy: { id: '740000002', battletag: 'Ivy#0002' }, kai: { id: '740000003', battletag: 'Kai#0003' },
  mem: { id: '740000004', battletag: 'Mem#0004' }, off: { id: '740000005', battletag: 'Off#0005' }, other: { id: '740000009', battletag: 'Other#0009' },
};

// The setup pin (lane B6b part 3a) is behind the operator's allowlist and takes the in-game guild it names as its params; these suites use it as a plain Battle.net Owner act.
const PIN = { guildName: 'Writers B3', realmSlug: 'nightslayer' };
const SWITCH = { from: null, to: 'manual' };

async function world(options = {}) {
  const s = await freshScenario({ ...options, env: { SETUP_PIN_GUILDS: '*', ...(options.env || {}) } });
  globalThis.__identityWorlds.push(s);
  // The accounts of the scenario were made a moment ago; a day on, a link made by a test is a young one (it must still confirm every act).
  s.w.advance(DAY);
  s.user = (key) => s.one('SELECT created_at, discord_id, discord_linked_at FROM users WHERE id = ?', s.uids[key]);
  s.bnetOf = async (key) => s.one('SELECT bnet_account_id, linked_at, first_linked_at FROM bnet_links WHERE user_id = ?', s.uids[key]);
  s.change = (change) => ({ purpose: 'identity_change', params: { change } });
  // The real flow: fresh-auth for the change with the account's own Discord, then the change.
  s.allow = async (key, change, provider = 'discord') => {
    const flow = await s.fresh(key, { ...s.change(change), provider });
    assert.equal(flow.location, '/#/fresh?done=identity_change', `${key} ${change}: ${flow.location}`);
  };
  s.at = (key, ms) => s.exec(`UPDATE bnet_links SET first_linked_at = ${ms}, linked_at = ${ms} WHERE user_id = '${s.uids[key]}'`);
  s.nothing = async (key) => assert.deepEqual(await s.grantOf(key), { fresh_purpose: null, fresh_hash: null, fresh_at: null });
  return s;
}

// ---------------------------------------------------------------------------
// 1. The writers

check('the first-link times: a Discord account\'s discord_linked_at is its creation, a Battle.net account\'s first_linked_at is its creation, a refresh moves neither, unlink + link starts over', async () => {
  const s = await world();
  const gm = await s.user('gm');
  assert.equal(gm.discord_linked_at, gm.created_at, 'a new Discord account: the Discord identity is first linked at creation');
  s.w.advance(3 * DAY);
  const again = await signIn(s.w, s.discordOf('gm'), [adminOf(s.serverId)]);
  assert.equal((await s.user('gm')).discord_linked_at, gm.created_at, 'a returning Discord sign-in does not touch it');
  assert(again.jar);
  // Battle.net sign-up: created_at = first_linked_at.
  await s.bnetSignUp('ivy', BNET.ivy);
  const ivy = await s.user('ivy');
  assert.equal(ivy.discord_linked_at, null, 'no Discord yet');
  assert.deepEqual([(await s.bnetOf('ivy')).first_linked_at, (await s.bnetOf('ivy')).linked_at], [ivy.created_at, ivy.created_at]);
  // A returning Battle.net sign-in and a link-mode refresh of the same account move linked_at (or nothing) and never first_linked_at.
  s.w.advance(9 * DAY);
  const login = await s.w.req('GET', '/auth/bnet/login?mode=signin', { jar: {} });
  s.bnet.state.account = BNET.ivy;
  await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(new URL(login.headers.get('Location')).searchParams.get('state'))}`, { jar: {} });
  assert.equal((await s.bnetOf('ivy')).first_linked_at, ivy.created_at);
  assert.equal(await s.linkBnet('ivy', BNET.ivy), '/#/characters');
  const refreshed = await s.bnetOf('ivy');
  assert.equal(refreshed.first_linked_at, ivy.created_at, 'the link-mode UPSERT rewrites linked_at only');
  assert(refreshed.linked_at > ivy.created_at);
  // Discord linked later: its own time, not the account's creation; a refresh keeps it.
  s.w.advance(DAY);
  const linkedAt = s.w.clock.now + 2000;
  assert.equal(await s.linkDiscord('ivy', { id: '117777777777777701', username: 'ivyd', globalName: 'Ivy D' }), '/#/linked');
  assert.equal((await s.user('ivy')).discord_linked_at, linkedAt);
  s.w.advance(DAY);
  await s.linkDiscord('ivy', { id: '117777777777777701', username: 'ivyd', globalName: 'Ivy D' });
  assert.equal((await s.user('ivy')).discord_linked_at, linkedAt, 'a refresh of the same Discord account moves nothing');
  // Unlink then link: both start over.
  assert.equal((await s.call('ivy', 'DELETE', '/auth/discord', {})).status, 200);
  assert.equal((await s.user('ivy')).discord_linked_at, null, 'unlink clears it');
  s.w.advance(DAY);
  assert.equal((await s.call('ivy', 'DELETE', '/auth/bnet', {})).status, 409, 'the last identity stays');
  await s.linkDiscord('ivy', { id: '117777777777777701', username: 'ivyd', globalName: 'Ivy D' });
  assert.equal((await s.user('ivy')).discord_linked_at, s.w.clock.now, 'linked again: a new first-link time');
  assert.equal((await s.call('ivy', 'DELETE', '/auth/bnet', {})).status, 200);
  assert.equal(await s.bnetOf('ivy'), undefined);
  s.w.advance(DAY);
  await s.linkBnet('ivy', BNET.ivy);
  assert.equal((await s.bnetOf('ivy')).first_linked_at, s.w.clock.now, 'a Battle.net account linked again starts over too');
});

check('CI grep: every worker statement that attaches a Discord id to an account or inserts a Battle.net link also writes its first-link time, and nothing else writes discord_id', () => {
  const { sqlLiterals, workerFiles } = require('../worker-sql');
  const found = { users: [], bnet: [], discordUpdate: [] };
  for (const file of workerFiles()) {
    for (const { sql } of sqlLiterals(file)) {
      if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+users\b/.test(sql)) found.users.push([file, sql]);
      if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+bnet_links\b/.test(sql)) found.bnet.push([file, sql]);
      if (/\bUPDATE\s+users\s+SET[^;]*\bdiscord_id\s*=/.test(sql)) found.discordUpdate.push([file, sql]);
    }
  }
  // INSERT INTO users: the Discord sign-in (a new account's Discord id) writes discord_linked_at; the Battle.net account insert has discord_id NULL and so no Discord time.
  assert.equal(found.users.length, 2, found.users.map(([file]) => file).join(', '));
  for (const [file, sql] of found.users) assert(/discord_linked_at/.test(sql) || /VALUES \(\?, \?, NULL,/.test(sql), `${file}: an account insert that sets a Discord id must set discord_linked_at`);
  assert.equal(found.bnet.length, 2, 'the Battle.net link inserts: sign-up and first link (a refresh is an UPDATE of the account\'s own row, see guild-b6b-fix-tests.js)');
  for (const [file, sql] of found.bnet) assert(/first_linked_at/.test(sql), `${file}: a Battle.net link insert must set first_linked_at`);
  assert(found.bnet.some(([file]) => file === 'worker/routes/bnet.js'));
  // UPDATE users SET discord_id = ...: linking (sets discord_linked_at) and unlinking (clears it); no other statement moves a Discord id.
  assert.equal(found.discordUpdate.length, 2, found.discordUpdate.map(([file]) => file).join(', '));
  for (const [file, sql] of found.discordUpdate) assert(/discord_linked_at/.test(sql), `${file}: a statement that changes users.discord_id must write discord_linked_at`);
  // The link UPSERT's DO UPDATE branch only FILLS IN first_linked_at (a missing value, with the link time as it stands before the overwrite); it never moves one.
  for (const [, sql] of found.bnet) {
    const branch = /DO UPDATE SET([^]*)$/.exec(sql);
    if (branch && /first_linked_at\s*=/.test(branch[1])) assert(/first_linked_at\s*=\s*COALESCE\(bnet_links\.first_linked_at, bnet_links\.linked_at\)/.test(branch[1]), 'the UPSERT never moves first_linked_at');
  }
});

// ---------------------------------------------------------------------------
// 2. No age rule: every identity linked to the account confirms a purpose at once (the former rule (a) was removed by user decision 2026-10-29)

check('no age rule: heldIdentityId and identityGuard accept any linked identity whatever its first-link time (missing, just now, long ago) and nothing else', async () => {
  const s = await world();
  const fresh = await load('worker/fresh.js');
  const created = 1_700_000_000_000;
  const both = { discord_id: '1', bnet_account_id: '2' };
  assert.equal(fresh.heldIdentityId(both, 'discord'), '1');
  assert.equal(fresh.heldIdentityId(both, 'bnet'), '2');
  assert.equal(fresh.heldIdentityId({ ...both, discord_id: null }, 'discord'), null);
  assert.equal(fresh.heldIdentityId({ ...both, bnet_account_id: null }, 'bnet'), null);
  const okOf = async (guard) => (await s.w.db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first()).ok;
  let serial = 0;
  for (const linkedAt of [null, created, created + 1, created + 60_001, created + 100 * DAY]) {
    serial += 1;
    const userId = `u_held${serial}`;
    const bnetId = `75000000${serial}`;
    const stamp = linkedAt === null ? 'NULL' : linkedAt;
    s.exec(`INSERT INTO users (id, account_key, discord_id, username, prefs, created_at, last_seen_at, discord_linked_at) VALUES ('${userId}', '${userId}', '${userId}d', 'x', '{}', ${created}, ${created}, ${stamp})`);
    s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${userId}', '${bnetId}', 'T#1', ${created + 100 * DAY}, '{}', 1, ${stamp})`);
    const row = await fresh.loadIdentityRow(s.w.db, userId);
    assert.deepEqual([fresh.heldIdentityId(row, 'discord'), fresh.heldIdentityId(row, 'bnet')], [`${userId}d`, bnetId], `first-link time ${linkedAt}`);
    for (const [provider, identity] of [['discord', `${userId}d`], ['bnet', bnetId]]) {
      assert.equal(await okOf(fresh.identityGuard(provider, userId, identity)), 1, `${provider} linked at ${linkedAt}`);
      assert.equal(await okOf(fresh.identityGuard(provider, userId, `${identity}x`)), 0, `${provider}: another identity does not hold`);
      assert.equal(await okOf(fresh.identityGuard(provider, `${userId}x`, identity)), 0, `${provider}: another account does not hold it`);
    }
  }
});

check('a Discord-first Owner links Battle.net in the session (a fresh Discord sign-in first); the NEW Battle.net identity confirms hand-over, guild delete, pin and source switch at once; the GM claim and in-game creation work as before', async () => {
  const s = await world();
  await s.member('mem', 'Plainmember');
  const bareLogin = await s.w.req('GET', '/auth/bnet/login', { jar: s.jars.gm });
  assert.equal(bareLogin.headers.get('Location'), '/#/linked?error=fresh_required', 'an Owner links an identity only after a fresh sign-in');
  assert.equal(s.bnet.state.requests.length, 0);
  await s.allow('gm', 'link_bnet');
  assert.equal(await s.linkBnet('gm', BNET.gm), '/#/characters');
  const link = await s.bnetOf('gm');
  assert.equal(link.first_linked_at, s.w.clock.now, 'the new Battle.net identity was first linked just now');
  await s.nothing('gm');
  // The new identity confirms every Owner act at once.
  for (const [purpose, params] of [['handover', { targetUserId: s.uids.mem }], ['guild_delete', {}], ['pin', PIN], ['source_switch', SWITCH]]) {
    const done = await s.fresh('gm', { purpose, guildId: s.gid, params, provider: 'bnet', account: BNET.gm });
    assert.equal(done.start.status, 200, `${purpose}: ${done.start.text}`);
    assert.equal(done.location, `/#/fresh?done=${purpose}`, purpose);
    assert.equal((await s.grantOf('gm')).fresh_purpose, purpose);
  }
  // So does the Discord identity.
  const discord = await s.fresh('gm', { purpose: 'handover', guildId: s.gid, params: { targetUserId: s.uids.mem }, provider: 'discord' });
  assert.equal(discord.location, '/#/fresh?done=handover');
  // The GM claim and in-game creation never looked at the identity's age: their authority is live Blizzard data.
  // (The guild must have an in-game seat to claim, lane B6b part 2b; the claim then runs inside the callback and writes no grant. The fake's roster has another rank-0 member than
  // this account's characters, so the answer is not_gm: what matters is that the Battle.net identity is not turned away at the start.)
  s.exec(`UPDATE guilds SET rank_source = 'ingame', pinned_guild_slug = 'writers-b3', pinned_realm_slug = 'nightslayer', pinned_namespace = 'profile-classicann-us', blizzard_guild_id = 3000, blizzard_realm_id = 4001 WHERE id = '${s.gid}'`);
  const claim = await s.fresh('gm', { purpose: 'gm_claim', guildId: s.gid, provider: 'bnet', account: BNET.gm });
  assert.equal(claim.start.status, 200, claim.start.text);
  assert.equal(claim.location, '/#/fresh?error=not_gm&purpose=gm_claim');
  assert.notEqual((await s.grantOf('gm')).fresh_purpose, 'gm_claim', 'the claim leaves no grant behind');
  s.exec(`UPDATE guilds SET rank_source = NULL, pinned_guild_slug = NULL, pinned_realm_slug = NULL, pinned_namespace = NULL, blizzard_guild_id = NULL, blizzard_realm_id = NULL WHERE id = '${s.gid}'`);
  await s.fresh('gm', { purpose: 'ingame_create', params: { realm: 'x' }, provider: 'bnet', account: BNET.gm });
  assert.equal((await s.grantOf('gm')).fresh_purpose, 'ingame_create');
});

check('a Battle.net link made a minute ago passes fresh-auth for pin and source_switch (the account is a day old)', async () => {
  const s = await world();
  await s.member('kai', 'Kaione');
  s.w.advance(DAY); // the account is a day old
  await s.setOwner('kai');
  const linkedAt = s.w.clock.now - 60_000;
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.kai}', '${BNET.kai.id}', 'Kai#3', ${linkedAt}, '{}', 1, ${linkedAt})`);
  const user = await s.user('kai');
  assert(linkedAt > user.created_at + 60_000, 'the link is a minute old and the account a day old');
  for (const [purpose, params] of [['pin', PIN], ['source_switch', SWITCH]]) {
    const done = await s.fresh('kai', { purpose, guildId: s.gid, params, provider: 'bnet', account: BNET.kai });
    assert.equal(done.start.status, 200, `${purpose}: ${done.start.text}`);
    assert.equal(done.location, `/#/fresh?done=${purpose}`, purpose);
    assert.equal((await s.grantOf('kai')).fresh_purpose, purpose, `${purpose}: the grant is on the session`);
  }
});

check('a Battle.net refresh then pin passes; unlink + relink then pin passes at once too (the first-link time starts over, nothing waits on it)', async () => {
  const s = await world();
  // ivy: made with Battle.net, Owner by the seat, a member through a linked person.
  await s.bnetSignUp('ivy', BNET.ivy);
  const made = await s.person({ name: 'Ivymain' });
  s.exec(`UPDATE players SET user_id = '${s.uids.ivy}' WHERE id = '${made.pid}'`);
  await s.setOwner('ivy');
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  const pin = (key, account) => s.fresh(key, { purpose: 'pin', guildId: s.gid, params: PIN, provider: 'bnet', account });
  assert.equal((await pin('ivy', BNET.ivy)).location, '/#/fresh?done=pin');
  // A refresh weeks later moves linked_at, not first_linked_at, and the pin still passes.
  s.w.advance(10 * DAY);
  assert.equal(await s.linkBnet('ivy', BNET.ivy), '/#/characters');
  assert((await s.bnetOf('ivy')).linked_at > (await s.bnetOf('ivy')).first_linked_at);
  assert.equal((await pin('ivy', BNET.ivy)).location, '/#/fresh?done=pin', 'a Battle.net refresh then pin passes');
  // kai: Discord-first Owner with a Battle.net identity linked long ago.
  await s.member('kai', 'Kaione');
  s.w.advance(DAY);
  await s.setOwner('kai');
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.kai}', '${BNET.kai.id}', 'Kai#3', 1, '{}', 1, 1)`);
  assert.equal((await pin('kai', BNET.kai)).location, '/#/fresh?done=pin', 'linked long ago: passes');
  // Unlink and relink: the first-link time starts over, and the pin passes at once.
  await s.allow('kai', 'unlink_bnet');
  assert.equal((await s.call('kai', 'DELETE', '/auth/bnet', {})).status, 200);
  await s.allow('kai', 'link_bnet');
  assert.equal(await s.linkBnet('kai', BNET.kai), '/#/characters');
  assert.equal((await s.bnetOf('kai')).first_linked_at, s.w.clock.now);
  assert.equal((await pin('kai', BNET.kai)).location, '/#/fresh?done=pin', 'relinked just now: passes at once');
});

// ---------------------------------------------------------------------------
// 3. Rule (b): who is protected, and what protection asks

check('protected accounts: the Owner seat (live or suspended), a stored Officer, a stored Team Lead, a legacy Guild Master and a derived Officer are protected; a plain member and a custom role are not', async () => {
  const s = await world();
  const fresh = await load('worker/fresh.js');
  for (const [key, name] of [['mem', 'Plainmember'], ['cus', 'Customrole'], ['sof', 'Storedoff'], ['stl', 'Storedlead'], ['seat', 'Seatholder'], ['dof', 'Derivedoff']]) await s.member(key, name);
  await s.ok('gm', 'PUT', `/people/${s.uids.sof}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  await s.ok('gm', 'PUT', `/people/${s.uids.stl}/roles`, { officer: false, teamLeadTeamIds: [s.tids[0]] }, 200);
  const created = await s.ok('gm', 'POST', '/roles', { name: 'Loot helper', permissions: { 'loot.view': 'guild' } }, 201);
  const roleId = created.roles.find((role) => role.name === 'Loot helper').id;
  await s.ok('gm', 'PUT', `/people/${s.uids.cus}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId, teamId: null }] }, 200);
  const protectedOf = async (key) => fresh.isProtectedAccount(s.w.db, s.uids[key]);
  assert.deepEqual(await Promise.all(['gm', 'mem', 'cus', 'sof', 'stl'].map(protectedOf)), [true, false, false, true, true]);
  // The seat, and a derived Officer in an in-game guild.
  const made = await s.person({ name: 'Derivedmain' });
  await s.link(made.pid, 'dof');
  makeProven(s, 'dof', made, { rank: 1 });
  const seatPerson = await s.person({ name: 'Seatmain' });
  await s.link(seatPerson.pid, 'seat');
  makeProven(s, 'seat', seatPerson, { rank: 4 });
  flip(s, { owner: 'seat' });
  assert.equal(await protectedOf('dof'), true, 'a derived Officer');
  assert.equal(await protectedOf('seat'), true, 'the Owner seat');
  assert.equal(await protectedOf('gm'), false, 'the stored Guild Master row stopped counting at the flip');
  s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${seatPerson.cid}'`);
  assert.equal(await protectedOf('seat'), true, 'a SUSPENDED Owner still holds the seat');
  assert.equal(await protectedOf('mem'), false);
});

check('a protected account links and unlinks only with a grant for exactly that change: the link starts redirect to fresh_required, the unlink routes answer 403 fresh_required { purpose, params }; nothing is written', async () => {
  const s = await world();
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.gm}', '${BNET.gm.id}', 'Gm#1', 1, '{}', 1, 1)`);
  const outbound = () => s.w.discord.calls.length + s.bnet.state.requests.length;
  const dump = async () => JSON.stringify([await s.rows('SELECT id, discord_id, discord_linked_at FROM users ORDER BY id'), await s.rows('SELECT * FROM bnet_links ORDER BY user_id'),
    await s.rows("SELECT action FROM audit_log WHERE action IN ('identity.change', 'bnet.unlink', 'discord.unlink')")]);
  const before = await dump();
  // An Officer (staff) with both identities: unlinking Discord is a protected act; so is gm's Battle.net.
  await s.officer('off', 'Officerone');
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.off}', '${BNET.off.id}', 'Off#5', 1, '{}', 1, 1)`);
  const before0 = await dump();
  const calls = outbound();
  for (const [who, path, change] of [['off', '/auth/discord', 'unlink_discord'], ['off', '/auth/bnet', 'unlink_bnet'], ['gm', '/auth/bnet', 'unlink_bnet']]) {
    const refused = await s.call(who, 'DELETE', path, {});
    assert.deepEqual([refused.status, refused.json.error, refused.json.purpose, refused.json.params], [403, 'fresh_required', 'identity_change', { change }], `${who} ${path}`);
  }
  assert.equal(await dump(), before0);
  // A grant for another change (or another purpose) is no grant for this one.
  await s.grant('gm', { purpose: 'identity_change', params: { change: 'link_bnet' } });
  assert.equal((await s.call('gm', 'DELETE', '/auth/bnet', {})).json.error, 'fresh_required');
  await s.grant('gm', { purpose: 'guild_delete', guildId: s.gid, params: {} });
  assert.equal((await s.call('gm', 'DELETE', '/auth/bnet', {})).json.error, 'fresh_required');
  assert.equal(await dump(), before0);
  // The right grant: the change happens, the grant is spent, a marker exists, and the audit rows and the nulling follow (rule (c)).
  await s.grant('gm', { purpose: 'identity_change', params: { change: 'unlink_bnet' } });
  const done = await s.call('gm', 'DELETE', '/auth/bnet', {});
  assert.equal(done.status, 200, done.text);
  assert.equal(await s.bnetOf('gm'), undefined);
  await s.nothing('gm');
  assert.equal(await s.w.count('fresh_act_markers'), 1);
  assert.equal(await s.w.count('audit_log', "action = 'identity.change'"), 1);
  // The same grant cannot be used twice, and the next unlink needs its own.
  assert.equal((await s.call('gm', 'DELETE', '/auth/discord', {})).json.error, 'last_identity');
  assert.equal(outbound(), calls, 'no provider was called by any of this');
});

check('the link starts (GET /auth/login?mode=link, GET /auth/bnet/login) turn a protected account without a grant away before the provider; a refresh needs none; the callback checks the grant again', async () => {
  const s = await world();
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.gm}', '${BNET.gm.id}', 'Gm#1', 1, '{}', 1, 1)`);
  // A refresh of the Battle.net account gm already has is not an identity change.
  assert.equal(await s.linkBnet('gm', BNET.gm), '/#/characters', 'a refresh needs no grant');
  // Discord: gm has it already (same id: a refresh). A Bnet-only protected account linking Discord is a change.
  await s.bnetSignUp('ivy', BNET.ivy);
  const made = await s.person({ name: 'Ivymain' });
  s.exec(`UPDATE players SET user_id = '${s.uids.ivy}' WHERE id = '${made.pid}'`);
  await s.setOwner('ivy');
  const discordIvy = { id: '117777777777777702', username: 'ivyd', globalName: 'Ivy D' };
  const turnedAway = await s.linkDiscord('ivy', discordIvy);
  assert.equal(turnedAway, '/#/linked?error=fresh_required');
  assert.equal((await s.user('ivy')).discord_id, null);
  // With the grant the begin passes; the callback consumes it; losing it in between ends the callback with fresh_required and nothing linked.
  await s.allow('ivy', 'link_discord', 'bnet');
  s.w.discord.next = { user: { id: discordIvy.id, username: 'ivyd', global_name: 'Ivy D', avatar: null }, servers: [] };
  s.w.advance(1000);
  const login = await s.w.req('GET', '/auth/login?mode=link', { jar: s.jars.ivy });
  assert(/authorize|oauth2/.test(login.headers.get('Location')), login.headers.get('Location'));
  s.exec(`UPDATE sessions SET fresh_purpose = NULL, fresh_hash = NULL, fresh_at = NULL WHERE user_id = '${s.uids.ivy}'`);
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await s.w.req('GET', `/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars.ivy });
  assert.equal(callback.headers.get('Location'), '/#/linked?error=fresh_required');
  assert.equal((await s.user('ivy')).discord_id, null, 'nothing was linked');
  assert.equal(await s.w.count('audit_log', "action IN ('discord.link', 'identity.change')"), 0);
  // Grant, then the whole thing.
  await s.allow('ivy', 'link_discord', 'bnet');
  assert.equal(await s.linkDiscord('ivy', discordIvy), '/#/linked');
  const ivy = await s.user('ivy');
  assert.equal(ivy.discord_id, discordIvy.id);
  assert.equal(ivy.discord_linked_at, s.w.clock.now, 'the Discord identity has its own first-link time');
  await s.nothing('ivy');
  assert.equal(await s.w.count('fresh_act_markers'), 1);
});

check('an account that holds no staff role changes identities without a grant - but its grants are nulled and the change is audited in its guilds', async () => {
  const s = await world();
  await s.member('mem', 'Plainmember');
  assert.equal(await s.linkBnet('mem', BNET.mem), '/#/characters', 'no grant asked of a plain member');
  const grants = await s.grant('mem', { purpose: 'guild_delete', guildId: s.gid, params: {} });
  assert(grants);
  // (c) Another session of the same account holds a grant too.
  const other = {};
  await signIn(s.w, s.discordOf('mem'), [require('../guild-world').memberOf(s.serverId)], other);
  s.exec(`UPDATE sessions SET fresh_purpose = 'pin', fresh_hash = 'h', fresh_at = ${s.w.clock.now} WHERE token_hash = '${sessionHashOf(other)}'`);
  // A refresh is no change: grants stay, no audit row.
  const rowsBefore = await s.w.count('audit_log', "action = 'identity.change'");
  assert.equal(await s.linkBnet('mem', BNET.mem), '/#/characters');
  assert.equal((await s.grantOf('mem')).fresh_purpose, 'guild_delete', 'a refresh leaves the grant');
  assert.equal(await s.w.count('audit_log', "action = 'identity.change'"), rowsBefore);
  // Unlinking Discord (the account keeps Battle.net): a change.
  assert.equal((await s.call('mem', 'DELETE', '/auth/discord', {})).status, 200);
  await s.nothing('mem');
  assert.equal((await s.one('SELECT fresh_purpose FROM sessions WHERE token_hash = ?', sessionHashOf(other))).fresh_purpose, null, 'every session of the account loses its grant');
  const rows = await s.rows("SELECT guild_id, actor_user_id, entity_id, actor_role, after FROM audit_log WHERE action = 'identity.change' ORDER BY created_at, id");
  assert.deepEqual(rows.map((row) => [row.guild_id, row.actor_user_id, row.entity_id, row.actor_role, JSON.parse(row.after)]), [
    [s.gid, s.uids.mem, s.uids.mem, 'member', { provider: 'bnet', change: 'link' }],
    [s.gid, s.uids.mem, s.uids.mem, 'member', { provider: 'discord', change: 'unlink' }],
  ], 'the unlink is audited in the guild the Discord server membership made them a member of (read before the server rows went)');
  const { PRUNABLE_ACTIONS } = await load('worker/audit.js');
  assert(!PRUNABLE_ACTIONS.includes('identity.change'), 'never pruned');
});

check('(c) an identity change of a staff account is audited in EACH guild it is a member of with the role it holds there', async () => {
  const s = await world();
  // A second guild for gm on another Discord server.
  const SERVER2 = '900000000000000092';
  const jar = (await signIn(s.w, s.discordOf('gm'), [adminOf(s.serverId), adminOf(SERVER2)])).jar;
  s.jars.gm = jar;
  const second = await s.call('gm', 'POST', '/api/guild', {
    serverId: SERVER2, name: 'Second Guild', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: false, teamNames: ['Only'],
  });
  assert.equal(second.status, 201, second.text);
  const gid2 = second.json.guild.id;
  await s.member('off', 'Officerone');
  await s.ok('gm', 'PUT', `/people/${s.uids.off}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  // The Officer (staff in guild 1, not a member of guild 2) links Battle.net: protected, so a grant first.
  await s.allow('off', 'link_bnet');
  assert.equal(await s.linkBnet('off', BNET.off), '/#/characters');
  const offRows = await s.rows("SELECT guild_id, actor_role FROM audit_log WHERE action = 'identity.change' AND actor_user_id = ?", s.uids.off);
  assert.deepEqual(offRows, [{ guild_id: s.gid, actor_role: 'officer' }]);
  // gm (Owner of both) changes an identity: one row in each guild, role owner in both.
  await s.allow('gm', 'link_bnet');
  assert.equal(await s.linkBnet('gm', BNET.gm), '/#/characters');
  const rows = await s.rows("SELECT guild_id, actor_role FROM audit_log WHERE action = 'identity.change' AND actor_user_id = ? ORDER BY guild_id", s.uids.gm);
  assert.deepEqual(rows, [{ guild_id: s.gid, actor_role: 'owner' }, { guild_id: gid2, actor_role: 'owner' }].sort((a, b) => (a.guild_id < b.guild_id ? -1 : 1)));
});

runChecks(checks);
