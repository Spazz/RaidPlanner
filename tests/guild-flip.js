// Fixtures of the flip suites (lane B9, tests/guild/guild-b9-*-tests.js). Nothing here is a test. The suites' check() wrapper sets globalThis.__flipWorlds = [] before each check and closes
// every world in it afterwards.
//   const s = await flipWorld({ ownerLive, mapped, bulk })   a LEGACY guild (rank_source NULL; the Guild Master 'gm' is the Owner by the stored row), pinned to its in-game guild, with a good
//                                                            sync, a stored roster, the in-game rank map and these people:
//        gm       the Owner: Gmmain, a character proved by Battle.net at rank 4 (ownerLive false = the proof is gone: the Owner would be suspended)
//        mem      a Discord member with Memberone (an officer's proof, rank 5); has a Discord-given Officer row
//        off      an Officer by a hand-set row; Officerone (officer proof, rank 1)
//        dis      a Discord member with no person of the guild (loses access at the flip); a person Dcperson records its Discord ID and nobody owns it; a Discord-given Team Lead row on
//                 Alpha that also exists by hand (the flip drops the twin)
//        nb       a Discord member linked to Nbperson, whose only character is id-less and bound by name: they keep their access
//        out      an account in no server of the guild
//   and these characters, each its own person on Alpha, none of them linked to an account:
//        Namebound (officer proof) and Namenoproof (proof cleared) are bound to their roster rows by name; Nameclass has the right name and the wrong class; Namehand (a hand-added
//        character), Nameleft (left the guild) and Nametaken (the roster row's key is held by another character) are not bound; Namemissing has no roster row at all;
//        Trialone sits on a rank the map calls Trial; Offroster is keyed but not on the roster.
//   mapped false leaves roster rank 9 without a map row. memRank is Memberone's roster rank (5 = Social in the map). bulk N adds N persons with an id-less character each that the flip binds by name (a big roster).
//   dryRun(s, who), flipWith(s, token, who, { grant }), grant(s, who, extra), stateOf(s)
const assert = require('node:assert/strict');
const { STEP } = require('./guild-b3-world');
const { freshScenario } = require('./guild-fresh');
const { DEFAULT_MAP, makeProven, setMap } = require('./guild-ingame');
const { NAMESPACE, REALM_ID } = require('./guild-seat');

const SLUG = 'nightslayer';
const BLIZZARD_GUILD_ID = 3000;
const SWITCH = { from: null, to: 'ingame' };
const MAP = [...DEFAULT_MAP, { rank: 6, label: 'Trial', coreRank: 'trial', roleId: null }];

const rosterRow = (s, { name, id, rank, cls = 'MAGE' }) => s.exec(
  `INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
   VALUES ('${s.gid}', '${NAMESPACE}', ${REALM_ID}, ${id}, '${name}', '${name.toLowerCase()}', '${SLUG}', '${cls}', 70, ${rank})`,
);
const keyCharacter = (s, characterId, id) => s.exec(`UPDATE characters SET namespace = '${NAMESPACE}', blizzard_realm_id = ${REALM_ID}, blizzard_char_id = ${id} WHERE id = '${characterId}'`);

async function flipWorld({ ownerLive = true, mapped = true, bulk = 0, memRank = 5, env = {} } = {}) {
  const s = await freshScenario({ teams: ['Alpha', 'Bravo'], env });
  globalThis.__flipWorlds.push(s);
  s.people = {};
  const person = async (key, name) => { s.people[key] = await s.person({ name }); return s.people[key]; };

  // The accounts
  await s.member('mem', 'Memberaccount');
  await s.officer('off', 'Officeraccount');
  await s.member('dis', 'Discordaccount');
  await s.member('nb', 'Nbaccount');
  await s.outsider('out', 'Outsideraccount');

  // The Owner and the people with characters on the roster
  await person('gm', 'Gmmain');
  await s.link(s.people.gm.pid, 'gm');
  makeProven(s, 'gm', s.people.gm, { rank: 4, id: 9400 });
  s.exec(`UPDATE guild_roster SET name = 'Gmmain', name_key = 'gmmain' WHERE guild_id = '${s.gid}' AND blizzard_char_id = 9400`);
  await person('mem', 'Memberone');
  await s.link(s.people.mem.pid, 'mem');
  makeProven(s, 'mem', s.people.mem, { rank: memRank, id: 9401, proof: 'officer', link: false });
  await person('off', 'Officerone');
  await s.link(s.people.off.pid, 'off');
  makeProven(s, 'off', s.people.off, { rank: 1, id: 9402, proof: 'officer', link: false });

  // Characters the flip binds by name, or does not
  const named = async (key, name, { id, rank = 3, cls = 'MAGE', proof } = {}) => {
    await person(key, name);
    if (id) rosterRow(s, { name, id, rank, cls });
    if (proof !== undefined) s.exec(`UPDATE characters SET owner_proof = ${proof === null ? 'NULL' : `'${proof}'`} WHERE id = '${s.people[key].cid}'`);
    return s.people[key];
  };
  await named('bound', 'Namebound', { id: 9501 });
  await named('none', 'Namenoproof', { id: 9502, rank: 4, proof: null });
  await named('klass', 'Nameclass', { id: 9503, cls: 'WARRIOR' });
  await named('hand', 'Namehand', { id: 9504, proof: 'hand' });
  const left = await named('left', 'Nameleft', { id: 9505 });
  s.exec(`UPDATE characters SET left_on = '2026-01-01' WHERE id = '${left.cid}'`);
  await named('taken', 'Nametaken', { id: 9506 });
  const holder = await person('holder', 'Holderrename');
  keyCharacter(s, holder.cid, 9506);
  await named('missing', 'Namemissing');
  await named('trial', 'Trialone', { id: 9510, rank: 6 });
  const off = await person('offroster', 'Offroster');
  keyCharacter(s, off.cid, 9511);

  // A member whose person has only an id-less character that the flip binds by name: they keep their access, because the binding gives the person a place on the roster.
  const nb = await named('nb', 'Nbperson', { id: 9540 });
  await s.link(nb.pid, 'nb');

  // Roles: a Discord-given Officer for mem, a Discord-given Team Lead for dis that also exists by hand, a person that only records dis's Discord ID
  const role = (user, roleId, teamId, source) => s.exec(
    `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at, source)
     VALUES ('ra_${user}${roleId}${source}', '${s.gid}', '${s.uids[user]}', '${roleId}', ${teamId ? `'${teamId}'` : 'NULL'}, NULL, 1, '${source}')`,
  );
  role('mem', 'officer', null, 'discord');
  role('dis', 'team_lead', s.tids[0], 'discord');
  role('dis', 'team_lead', s.tids[0], 'manual');
  const dc = await person('dc', 'Dcperson');
  s.exec(`UPDATE players SET discord_user_id = '${(await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.dis)).discord_id}' WHERE id = '${dc.pid}'`);

  // The pin, the good sync and the rank map
  const sync = (id, good) => s.exec(`INSERT INTO roster_syncs (id, guild_id, started_at, finished_at, good, http_status, reason, counts) VALUES ('${id}', '${s.gid}', 1, 2, ${good}, 200, NULL, '{}')`);
  sync('rs_good', 1);
  s.exec(`UPDATE guilds SET pinned_guild_slug = 'writers-b3', pinned_realm_slug = '${SLUG}', pinned_namespace = '${NAMESPACE}', blizzard_guild_id = ${BLIZZARD_GUILD_ID}, blizzard_realm_id = ${REALM_ID},
                last_good_sync_id = 'rs_good', last_good_fetched_at = 2 WHERE id = '${s.gid}'`);
  setMap(s, MAP);
  if (!mapped) rosterRow(s, { name: 'Unmappedrank', id: 9520, rank: 9 });
  if (!ownerLive) s.exec(`UPDATE characters SET owner_proof = 'officer', proof_user_id = NULL, proof_bnet_account_id = NULL WHERE id = '${s.people.gm.cid}'`);
  if (bulk) addNamedBulk(s, bulk);
  return s;
}

// `count` persons with an id-less character each, all bound by name at the flip (a big roster); the guild's person cap (1,000) is lifted for the fixture.
function addNamedBulk(s, count) {
  const sqlite = s.w.db.sqlite;
  sqlite.exec('DROP TRIGGER players_cap');
  sqlite.exec('BEGIN');
  const person = sqlite.prepare("INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES (?, ?, 'raider', 1, 1)");
  const character = sqlite.prepare(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, owner_proof)
    VALUES (?, ?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', 1, 1, 1, 'raider', 'officer')`);
  const roster = sqlite.prepare(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'MAGE', 70, ?)`);
  for (let i = 0; i < count; i++) {
    const name = `Bulk${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${String.fromCharCode(97 + Math.floor(i / 676))}`;
    person.run(`p_bulk${i}`, s.gid);
    character.run(`c_bulk${i}`, s.gid, `p_bulk${i}`, i % 2 === 0 ? s.tids[0] : s.tids[1], name, name.toLowerCase());
    roster.run(s.gid, NAMESPACE, REALM_ID, 30000 + i, name, name.toLowerCase(), SLUG, 1 + (i % 6));
  }
  sqlite.exec('COMMIT');
}

const dryRun = (s, who = 'gm') => s.call(who, 'POST', '/flip/dry-run', {});

// The fresh grant of the source switch, written on the session row (no OAuth: this is about the act).
const grant = (s, who = 'gm', extra = {}) => s.grant(who, { purpose: 'source_switch', guildId: s.gid, params: SWITCH, ...extra });

// POST /flip with its grant (grant: false = none, or an object = the grant's own fields).
async function flipWith(s, token, who = 'gm', { grant: wanted = true } = {}) {
  if (wanted) await grant(s, who, wanted === true ? {} : wanted);
  return s.call(who, 'POST', '/flip', token === undefined ? {} : { token });
}

// Everything a flip may write, as plain data: two calls to it compare equal exactly when the flip changed nothing.
async function stateOf(s) {
  const q = (sql, ...values) => s.rows(sql, ...values);
  return {
    guild: await s.one('SELECT rank_source, owner_user_id, last_good_sync_id FROM guilds WHERE id = ?', s.gid),
    roles: await q('SELECT id, user_id, role_id, team_id, source FROM role_assignments WHERE guild_id = ? ORDER BY id', s.gid),
    characters: await q('SELECT id, namespace, blizzard_realm_id, blizzard_char_id, core_rank, trial_start, trial_end, owner_proof, updated_at FROM characters WHERE guild_id = ? ORDER BY id', s.gid),
    persons: await q('SELECT id, user_id, discord_user_id FROM players WHERE guild_id = ? ORDER BY id', s.gid),
    approvals: await q('SELECT token_hash, used_at FROM dry_run_approvals WHERE guild_id = ? ORDER BY token_hash', s.gid),
    grants: await q('SELECT token_hash, fresh_purpose, fresh_hash, fresh_at FROM sessions ORDER BY token_hash'),
    markers: await q('SELECT act_id, purpose FROM fresh_act_markers ORDER BY act_id'),
    audit: await q('SELECT id, action FROM audit_log WHERE guild_id = ? ORDER BY id', s.gid),
  };
}

// A hook on db.batch: `action` (async) runs just before the first batch whose statements satisfy `when`, then the batch runs.
function beforeBatch(s, when, action) {
  const real = s.w.db.batch.bind(s.w.db);
  let fired = false;
  s.w.db.batch = async (statements) => {
    if (!fired && when(statements)) { fired = true; await action(statements); }
    return real(statements);
  };
  return () => { s.w.db.batch = real; };
}
const isFlipBatch = (statements) => statements.some((statement) => /UPDATE guilds SET rank_source = 'ingame'/.test(statement.sql));

module.exports = {
  SLUG, BLIZZARD_GUILD_ID, SWITCH, MAP, STEP, flipWorld, rosterRow, keyCharacter, dryRun, grant, flipWith, stateOf, beforeBatch, isFlipBatch, addNamedBulk,
};
