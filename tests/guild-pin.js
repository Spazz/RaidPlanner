// Fixtures of the setup-pin suite (lane B6b part 3a, tests/guild/guild-b6b-p3a-tests.js). Nothing here is a test. The suite's check() wrapper sets globalThis.__pinWorlds = [] before each
// check and closes every world in it afterwards.
//   const s = await pinWorld({ env, members })   a LEGACY guild (rank_source NULL, the Guild Master 'gm' is the Owner by the stored row), the setup pin open for every guild
//                                                (SETUP_PIN_GUILDS '*'), Battle.net = tools/fake-battlenet.js with its profile and roster answers overridden: s.live = { roster, profiles,
//                                                guildId, realmId } is what the fake serves. 'gm' has a Battle.net link made long ago (the age of a link never matters) and the character
//                                                Gmmain (id 9301, rank 4) on the live roster; the rank-0 member Thelead (id 9300) is nobody's.
//   await grantPin(s, key, target)               the real fresh flow for the pin (start, provider, callback) -> { start, location }
//   await pin(s, key, target, { grant })         grantPin, then POST .../bnet/pin -> the response ({ status, json, text }) with .flow
//   await pinRaw(s, key, target)                 POST .../bnet/pin only (no grant of its own)
//   pinRow(s)                                    the guild's pin columns, rank source and sync columns
const { STEP } = require('./guild-b3-world');
const { freshScenario } = require('./guild-fresh');
const { entry, profileOf, rosterBody } = require('./guild-claim');
const { NAMESPACE, REALM_ID } = require('./guild-seat');

const TARGET = { guildName: 'Writers B3', realmSlug: 'nightslayer' };
const BLIZZARD_GUILD_ID = 3000;
const ACC = {
  gm: { id: '750000001', battletag: 'Gm#7501' },
  off: { id: '750000002', battletag: 'Off#7502' },
  mem: { id: '750000003', battletag: 'Mem#7503' },
  seat: { id: '750000004', battletag: 'Seat#7504' },
};
const ID = { lead: 9300, gm: 9301 };

// A bulk of `count` extra roster members on the live roster (ranks 1-9).
const bulk = (count, from = 20000) => Array.from({ length: count }, (_, i) => ({ name: `Bulk${i}`, id: from + i, rank: 1 + (i % 9) }));

async function pinWorld({ env = {}, members = null, setupOpen = '*' } = {}) {
  const s = await freshScenario({ teams: ['Alpha', 'Bravo'], env: { ...(setupOpen === null ? {} : { SETUP_PIN_GUILDS: setupOpen }), ...env } });
  globalThis.__pinWorlds.push(s);
  s.live = {
    roster: members || [{ name: 'Thelead', id: ID.lead, rank: 0 }, { name: 'Gmmain', id: ID.gm, rank: 4 }],
    profiles: {},
    guildId: BLIZZARD_GUILD_ID,
    realmId: REALM_ID,
  };
  const override = s.bnet.state.override;
  override.profile = ({ account }) => profileOf(s.live.profiles[account.id] || []);
  override.roster = () => rosterBody(s.live.roster, { guildId: s.live.guildId, realmId: s.live.realmId });
  // The Owner is a Discord-first account with a Battle.net link made long ago (the age of a link never matters) and a character on the live roster.
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids.gm}', '${ACC.gm.id}', '${ACC.gm.battletag}', 1, '{}', 1, 1)`);
  s.live.profiles[ACC.gm.id] = [entry('Gmmain', ID.gm)];
  return s;
}

// A second account with a Battle.net link made long ago, for the others to act as.
function linkOld(s, key) {
  s.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at, first_linked_at) VALUES ('${s.uids[key]}', '${ACC[key].id}', '${ACC[key].battletag}', 1, '{}', 1, 1)`);
}

const grantPin = (s, key = 'gm', target = TARGET) => s.fresh(key, { purpose: 'pin', guildId: s.gid, params: target, provider: 'bnet', account: ACC[key] });

async function pinRaw(s, key = 'gm', target = TARGET) {
  s.w.advance(STEP);
  return s.call(key, 'POST', '/bnet/pin', target);
}

async function pin(s, key = 'gm', target = TARGET) {
  const flow = await grantPin(s, key, target);
  const res = await pinRaw(s, key, target);
  res.flow = flow;
  return res;
}

const pinRow = (s) => s.one(
  `SELECT rank_source, owner_user_id, pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id, next_sync_at, last_good_sync_id, last_good_fetched_at, roster_hash
     FROM guilds WHERE id = ?`, s.gid,
);
const unpinned = { pinned_guild_slug: null, pinned_realm_slug: null, pinned_namespace: null, blizzard_guild_id: null, blizzard_realm_id: null };
const pinColumns = async (s) => {
  const { pinned_guild_slug: a, pinned_realm_slug: b, pinned_namespace: c, blizzard_guild_id: d, blizzard_realm_id: e } = await pinRow(s);
  return { pinned_guild_slug: a, pinned_realm_slug: b, pinned_namespace: c, blizzard_guild_id: d, blizzard_realm_id: e };
};

// The statements and the Blizzard requests a call used: measure(s, fn) -> { result, statements: [{ sql }], blizzard: [{ method, path }] }
async function measure(s, fn) {
  const mark = s.w.db.statementLog.length;
  const calls = s.bnet.state.requests.length;
  const result = await fn();
  return { result, statements: s.w.db.statementLog.slice(mark), blizzard: s.bnet.state.requests.slice(calls) };
}

module.exports = {
  TARGET, BLIZZARD_GUILD_ID, ACC, ID, NAMESPACE, REALM_ID, bulk, pinWorld, linkOld, grantPin, pinRaw, pin, pinRow, pinColumns, unpinned, measure, entry, profileOf, rosterBody,
};
