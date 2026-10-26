// Fixtures for an in-game guild (lane B6b): a guild whose rank_source is 'ingame', a rank map, a stored roster, and accounts with Battle.net-proven characters. The
// effective-roles view (migration 0035) derives roles from exactly these rows, so a test sets them with the columns themselves (the writers are other lanes' business).
//   makeProven(s, key, made, { rank, id, bnetId, proof })   made = { pid, cid } of a person already linked to the account (s.person + s.link, as the Owner of a legacy guild).
//                                                           Gives the account a Battle.net link, proves the character (owner_proof / proof_user_id / proof_bnet_account_id /
//                                                           identity key) and puts it on the stored roster at the in-game rank. proof: 'bnet' (default) | 'officer' | 'hand'.
//   flip(s, { owner, map })                                 the flip's end state: rank_source 'ingame', the seat on `owner` (a key of s.uids), the stored Guild Master row gone,
//                                                           the rank map set (DEFAULT_MAP: 0 Guild Master, 1 Officer, 2 Team Lead, 3 and 4 Raider with no role, 5 Social).
//   derivedGm(s, key, name)                                 a plain member whose character sits on in-game rank 0: a DERIVED Guild Master (not the Owner). Call it BEFORE flip().
//   ingameize(s, { owner, derivedGm, people, memberRank })  turns a legacy fixture into an in-game guild without moving anyone: every account in `people` ({ key: { pid, cid } }, persons already
//                                                           linked to their account) gets its Main bound to the stored roster (an officer's proof, in-game rank `memberRank`, no role: it keeps
//                                                           the membership the account had); `owner` gets a Battle.net proof at rank 4 (a LIVE Owner: not suspended) and the seat; `derivedGm`
//                                                           gets a Battle.net proof at rank 0 (a DERIVED Guild Master, not the Owner). Then flip().
//   rolesOf(s, key)                                         [[role_id, team_id, source]] the account holds in the guild, from the view, sorted.
// Order matters: make people first (the routes need a Guild Master), then flip().
const { NAMESPACE, REALM_ID } = require('./guild-seat');

let nextCharId = 9000;
let nextBnetId = 500000000;

const DEFAULT_MAP = [
  { rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' },
  { rank: 1, label: 'Officer', coreRank: 'raider', roleId: 'officer' },
  { rank: 2, label: 'Raid Assistant', coreRank: 'raider', roleId: 'team_lead' },
  { rank: 3, label: 'Core', coreRank: 'raider', roleId: null },
  { rank: 4, label: 'Raider', coreRank: 'raider', roleId: null },
  { rank: 5, label: 'Social', coreRank: 'social', roleId: null },
];

function makeProven(s, key, made, { rank = 5, id = ++nextCharId, bnetId, proof = 'bnet', link = true } = {}) {
  const userId = s.uids[key];
  // The account's Battle.net link is one per account: a second proven character of the same account reuses the id of the link it already has.
  const existing = s.w.db.sqlite.prepare('SELECT bnet_account_id FROM bnet_links WHERE user_id = ?').get(userId);
  const account = bnetId || (existing && existing.bnet_account_id) || ++nextBnetId;
  const proven = proof === 'bnet';
  if (link && proven) {
    s.w.db.sqlite.prepare("INSERT OR IGNORE INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)")
      .run(userId, String(account), `Tag${key}#1234`);
  }
  // An officer's or a hand proof carries no Battle.net columns (the account never proved the character itself).
  s.w.db.sqlite.prepare(
    `UPDATE characters SET owner_proof = ?, proof_user_id = ?, proof_bnet_account_id = ?, proof_at = ?, namespace = ?, blizzard_realm_id = ?, blizzard_char_id = ? WHERE id = ?`,
  ).run(proof, proven ? userId : null, proven ? String(account) : null, proven ? 1 : null, NAMESPACE, REALM_ID, id, made.cid);
  s.w.db.sqlite.prepare(
    `INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
     VALUES (?, ?, ?, ?, ?, ?, 'nightslayer', 'MAGE', 70, ?)`,
  ).run(s.gid, NAMESPACE, REALM_ID, id, `Roster${id}`, `roster${id}`, rank);
  return { id, bnetId: proven ? String(account) : null };
}

function setMap(s, map = DEFAULT_MAP) {
  const sqlite = s.w.db.sqlite;
  sqlite.prepare("DELETE FROM source_rank_maps WHERE guild_id = ? AND source = 'ingame'").run(s.gid);
  for (const entry of map) {
    sqlite.prepare("INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id, team_id) VALUES (?, 'ingame', ?, ?, ?, ?, NULL)")
      .run(s.gid, String(entry.rank), entry.label, entry.coreRank, entry.roleId);
  }
}

function flip(s, { owner = 'gm', map = DEFAULT_MAP, keepStoredMaster = false } = {}) {
  const sqlite = s.w.db.sqlite;
  setMap(s, map);
  sqlite.prepare("UPDATE guilds SET rank_source = 'ingame', owner_user_id = ? WHERE id = ?").run(owner ? s.uids[owner] : null, s.gid);
  if (!keepStoredMaster) sqlite.prepare("DELETE FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'").run(s.gid);
}

// A plain member with a person on the first team, linked and proven on in-game rank `rank` (default 0, Guild Master).
async function derived(s, key, name, { rank = 0, teamId } = {}) {
  await s.member(key, name);
  const made = await s.person(teamId === undefined ? { name } : { name, teamId });
  await s.link(made.pid, key);
  const proof = makeProven(s, key, made, { rank });
  return { ...made, ...proof };
}
const derivedGm = (s, key, name) => derived(s, key, name, { rank: 0 });

function ingameize(s, { owner = 'gm', derivedGm = null, people, memberRank = 5, map } = {}) {
  for (const [key, made] of Object.entries(people)) {
    if (!s.uids[key]) continue;
    if (key === owner) makeProven(s, key, made, { rank: 4 });
    else if (key === derivedGm) makeProven(s, key, made, { rank: 0 });
    else makeProven(s, key, made, { rank: memberRank, proof: 'officer', link: false });
  }
  flip(s, { owner, ...(map ? { map } : {}) });
}

// [[role_id, team_id, source]] sorted: what the view says the account holds in the test guild.
function rolesOf(s, key, guildId = s.gid) {
  return s.w.db.sqlite.prepare('SELECT role_id, team_id, source FROM effective_roles WHERE guild_id = ? AND user_id = ? ORDER BY role_id, team_id, source')
    .all(guildId, s.uids[key]).map((row) => [row.role_id, row.team_id, row.source]);
}

module.exports = { DEFAULT_MAP, makeProven, setMap, flip, ingameize, derived, derivedGm, rolesOf };
