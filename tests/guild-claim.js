// Fixtures of the Guild Master claim and the succession suites (lane B6b part 2b): an in-game guild whose Battle.net is the fake of tools/fake-battlenet.js with its profile and
// roster answers OVERRIDDEN, so that an account's characters and the guild's roster carry the same ids. Nothing here is a test. The suite's check() wrapper sets
// globalThis.__claimWorlds = [] before each check and closes every world in it afterwards.
//   const s = await claimWorld({ stored, ownerLive })   the previous Owner 'gm' (live: a character proved by Battle.net at rank 4; ownerLive false = suspended), a plain member 'mem' (an
//                                                        officer's proof, rank 5), the in-game Guild Master 'igm' (a Battle.net-only account that is NOT a member yet: its character
//                                                        Gmlive, id 9100, is rank 0 on the LIVE roster; stored false = the stored roster does not hold it yet). s.live = { roster,
//                                                        profiles: { <Battle.net account id>: [entry] }, guildId, realmId } is what the fake serves; s.suspendOwner() suspends 'gm'.
//   await claim(s, 'igm')                               the whole claim flow (start, provider, callback) -> { start, location, statements, blizzard }
//   seatOf(s), auditRows(s, action), charactersOf(s, personId), personOf(s, key), jsonOf(text), rosterRow(s, ...), signInAgain(s, key)
const assert = require('node:assert/strict');
const { STEP } = require('./guild-b3-world');
const { freshScenario } = require('./guild-fresh');
const { flip, makeProven } = require('./guild-ingame');
const { NAMESPACE, REALM_ID } = require('./guild-seat');

const SLUG = 'nightslayer';
const BLIZZARD_GUILD_ID = 3000;
const ID = { old: 9001, mem: 9002, gm: 9100, alt: 9101, squat: 9200 };
const ACCOUNT = {
  igm: { id: '730000001', battletag: 'Igm#7001' },
  sq: { id: '730000002', battletag: 'Sq#7002' },
  oth: { id: '730000003', battletag: 'Other#7003' },
};
// The tombstone keys: the current secret is version 2, a retired one (version 1) still has rows in the table.
const KEY = 'a-test-key-of-more-than-16-characters';
const OLD_KEY = 'an-older-test-key-of-16-plus-chars';
const DONE = '/#/fresh?done=gm_claim';
const refused = (reason) => `/#/fresh?error=${reason}&purpose=gm_claim`;

// ---------------------------------------------------------------------------
// Blizzard bodies: the account profile and the guild roster, with the same ids on both sides.
const entry = (name, id, { cls = 8, level = 70 } = {}) => ({ id, name, realm: { id: REALM_ID, slug: SLUG, name: 'Nightslayer' }, playable_class: { id: cls }, level });
const profileOf = (characters) => ({ wow_accounts: [{ id: 555, characters }] });
const rosterBody = (members, { guildId = BLIZZARD_GUILD_ID, realmId = REALM_ID } = {}) => ({
  guild: { id: guildId, name: 'Writers B3', realm: { id: realmId, slug: SLUG } },
  members: members.map(({ name, id, rank, cls = 8 }) => ({ character: { id, name, realm: { id: REALM_ID, slug: SLUG }, level: 70, playable_class: { id: cls } }, rank })),
});

// The in-game guild of the suite: the previous Owner 'gm' (a live Owner: a character proved by Battle.net at rank 4), a plain member 'mem' (bound by an officer's proof), the
// in-game Guild Master 'igm' (a Battle.net-only account that is NOT a member yet: its character Gmlive, id 9100, is rank 0 on the live roster). With stored: false the GM is new
// since the last sync (the stored roster does not hold the key). The fake Battle.net serves s.live.roster for the guild and s.live.profiles[<account id>] for an account.
async function claimWorld({ stored = true, ownerLive = true } = {}) {
  const s = await freshScenario({ teams: ['Alpha', 'Bravo'], env: { TOMBSTONE_KEY: KEY, TOMBSTONE_KEY_VERSION: '2', TOMBSTONE_OLD_KEYS: `1:${OLD_KEY}` } });
  globalThis.__claimWorlds.push(s);
  s.people = {};
  s.people.gm = await s.person({ name: 'Oldowner' });
  await s.link(s.people.gm.pid, 'gm');
  makeProven(s, 'gm', s.people.gm, { rank: 4, id: ID.old });
  await s.member('mem', 'Plainmember');
  s.people.mem = await s.person({ name: 'Memberone' });
  await s.link(s.people.mem.pid, 'mem');
  makeProven(s, 'mem', s.people.mem, { rank: 5, id: ID.mem, proof: 'officer', link: false });
  flip(s, { owner: 'gm' });
  s.exec(`UPDATE guilds SET pinned_guild_slug = 'writers-b3', pinned_realm_slug = '${SLUG}', pinned_namespace = '${NAMESPACE}', blizzard_guild_id = ${BLIZZARD_GUILD_ID}, blizzard_realm_id = ${REALM_ID} WHERE id = '${s.gid}'`);
  // The stored roster carries the characters' own names (the live roster uses the same, so a sync renames nobody).
  s.exec(`UPDATE guild_roster SET name = 'Oldowner', name_key = 'oldowner' WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${ID.old}`);
  s.exec(`UPDATE guild_roster SET name = 'Memberone', name_key = 'memberone' WHERE guild_id = '${s.gid}' AND blizzard_char_id = ${ID.mem}`);
  if (stored) rosterRow(s, { name: 'Gmlive', id: ID.gm, rank: 0 });
  s.live = {
    roster: [{ name: 'Oldowner', id: ID.old, rank: 4 }, { name: 'Memberone', id: ID.mem, rank: 5 }, { name: 'Gmlive', id: ID.gm, rank: 0 }],
    profiles: {},
    guildId: BLIZZARD_GUILD_ID,
    realmId: REALM_ID,
  };
  const override = s.bnet.state.override;
  override.profile = ({ account }) => profileOf(s.live.profiles[account.id] || []);
  override.roster = () => rosterBody(s.live.roster, { guildId: s.live.guildId, realmId: s.live.realmId });
  // The Guild Master's account: a Battle.net sign-up while its profile lists nothing, so the sign-in match has nothing to bind and the claim does all the work.
  await s.bnetSignUp('igm', ACCOUNT.igm);
  s.live.profiles[ACCOUNT.igm.id] = [entry('Gmlive', ID.gm), entry('Gmalt', ID.alt, { cls: 5 })];
  // The previous Owner stops being live: their character is no longer proved by Battle.net (the seat stays theirs, suspended).
  s.suspendOwner = () => s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.gm.cid}'`);
  if (!ownerLive) s.suspendOwner();
  return s;
}

function rosterRow(s, { name, id, rank, cls = 'MAGE' }) {
  s.exec(`INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
          VALUES ('${s.gid}', '${NAMESPACE}', ${REALM_ID}, ${id}, '${name}', '${name.toLowerCase()}', '${SLUG}', '${cls}', 70, ${rank})`);
}

// The whole claim flow for one account: the start step, the provider, the callback. -> { start, location, statements (the callback's D1 statements), blizzard (its requests) }.
async function claim(s, key, { account = ACCOUNT[key], guildId = s.gid } = {}) {
  s.w.advance(STEP);
  const start = await s.w.call(s.jars[key], 'POST', `/api/guild/${guildId}/fresh/start`, { purpose: 'gm_claim', params: {} });
  if (start.status !== 200) return { start, location: null };
  const state = new URL(start.json.authorizeUrl).searchParams.get('state');
  s.bnet.state.account = account;
  s.w.advance(STEP);
  const mark = s.w.db.statementLog.length;
  const calls = s.bnet.state.requests.length;
  const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars[key] });
  return {
    start, state, callback, location: callback.headers.get('Location'), statements: s.w.db.statementLog.slice(mark), blizzard: s.bnet.state.requests.slice(calls),
  };
}

// A person of the guild linked to the account (players.user_id) and nothing else: the account has a TIE to the guild, so its refused sign-in checks are counted in the guild's log
// (worker/membership.js guildTieSql); a stranger's are logged only.
const tieToGuild = (s, key) => s.exec(`INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES ('p_tie_${key}', '${s.gid}', 'raider', '${s.uids[key]}', 1, 1)`);

const seatOf = async (s) => (await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id;
const auditRows = (s, action) => s.rows('SELECT actor_user_id, actor_role, entity_id, before, after FROM audit_log WHERE guild_id = ? AND action = ? ORDER BY created_at, id', s.gid, action);
const charactersOf = (s, personId) => s.rows('SELECT id, name, name_key, owner_proof, proof_user_id, proof_bnet_account_id, blizzard_char_id, is_main, left_on, player_id FROM characters WHERE player_id = ? ORDER BY name_key', personId);
const personOf = async (s, key) => s.one('SELECT id, version FROM players WHERE guild_id = ? AND user_id = ?', s.gid, s.uids[key]);
const jsonOf = (text) => JSON.parse(text);

const signInAgain = async (s, key, account = ACCOUNT[key]) => {
  s.w.advance(STEP);
  s.bnet.state.account = account;
  const jar = {};
  const login = await s.w.req('GET', '/auth/bnet/login?mode=signin', { jar });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar });
  assert.equal(callback.headers.get('Location'), '/#/');
  s.jars[key] = jar;
  return jar;
};


// `count` more members for a big guild: every one a person with a character bound to a roster row (every third proved by Battle.net, ranks 1-9), on the stored AND the live roster.
// The guild holds 1,000 people at most (players_cap): the fixture is bigger on purpose, so the trigger goes.
function addBulkMembers(s, bulk) {
  const sqlite = s.w.db.sqlite;
  sqlite.exec('DROP TRIGGER players_cap');
  sqlite.exec('BEGIN');
  const user = sqlite.prepare('INSERT INTO users (id, account_key, username, created_at, last_seen_at) VALUES (?, ?, ?, 1, 1)');
  const person = sqlite.prepare("INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES (?, ?, 'raider', ?, 1, 1)");
  const character = sqlite.prepare(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on,
      owner_proof, proof_user_id, proof_bnet_account_id, proof_at, namespace, blizzard_realm_id, blizzard_char_id)
    VALUES (?, ?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', 1, 1, 1, 'raider', NULL, ?, ?, ?, ?, ?, ?, ?)`);
  const link = sqlite.prepare("INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)");
  const roster = sqlite.prepare(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'MAGE', 70, ?)`);
  for (let i = 0; i < bulk; i++) {
    const id = `u_bulk${String(i).padStart(5, '0')}`;
    const proven = i % 3 === 0;
    const charId = 20000 + i;
    const rank = 1 + (i % 9);
    user.run(id, id, id);
    person.run(`p_bulk${i}`, s.gid, id);
    character.run(`c_bulk${i}`, s.gid, `p_bulk${i}`, i % 2 === 0 ? s.tids[0] : s.tids[1], `Bulk${i}`, `bulk${i}`,
      proven ? 'bnet' : 'officer', proven ? id : null, proven ? String(600000 + i) : null, proven ? 1 : null, NAMESPACE, REALM_ID, charId);
    if (proven) link.run(id, String(600000 + i), `Bulk${i}#1`);
    roster.run(s.gid, NAMESPACE, REALM_ID, charId, `Bulk${i}`, `bulk${i}`, SLUG, rank);
    s.live.roster.push({ name: `Bulk${i}`, id: charId, rank });
  }
  sqlite.exec('COMMIT');
}

module.exports = {
  SLUG, BLIZZARD_GUILD_ID, ID, ACCOUNT, KEY, OLD_KEY, DONE, refused, entry, profileOf, rosterBody, claimWorld, rosterRow, claim, tieToGuild, seatOf, auditRows, charactersOf, personOf, jsonOf, signInAgain, addBulkMembers,
};
