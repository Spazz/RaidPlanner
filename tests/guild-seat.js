// Seats an account in a guild whose rank source is 'ingame' (lane B5). In such a guild an account is a member only when it is linked (players.user_id) to a person with a
// character on the in-game roster (worker/membership.js), so a fixture that flips a guild to 'ingame' and then acts as an Officer or a plain member first gives that
// account a person on the roster. Do this BEFORE the flip when the acting account is not the Owner: the person is made through the ordinary routes, as the Owner.
//   seatOnRoster({ call, sqlite, guildId, teamId, userId, who }, { name, id, rank, leftOn })
//     call(who, method, tail, body) -> { status, json }   the suite's own Worker caller, tail under /api/guild/<gid>
//     sqlite                                              the D1 stand-in's node:sqlite handle (world.db.sqlite)
//     who                                                 the key of the account that makes the person (the Guild Master / Owner); default 'gm'
// -> { pid, cid, id }: the person, its Main character and the roster key.
const assert = require('node:assert/strict');
const { ownPerson } = require('./guild-owner-fixture');

const NAMESPACE = 'profile-classicann-us';
const REALM_ID = 4001;

async function seatOnRoster({ call, sqlite, guildId, teamId, userId, who = 'gm' }, { name, id, rank = 4, leftOn = null, link = true }) {
  const made = await call(who, 'POST', '/roster', { teamId, name, class: 'MAGE', mainSpec: 'Fire', offSpec: null });
  assert.equal(made.status, 201, made.text);
  const pid = made.json.person.id;
  const cid = made.json.characters[0].id;
  sqlite.prepare('UPDATE characters SET namespace = ?, blizzard_realm_id = ?, blizzard_char_id = ?, left_on = ? WHERE id = ?').run(NAMESPACE, REALM_ID, id, leftOn, cid);
  sqlite.prepare(
    `INSERT OR REPLACE INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
     VALUES (?, ?, ?, ?, ?, ?, 'nightslayer', 'MAGE', 70, ?)`,
  ).run(guildId, NAMESPACE, REALM_ID, id, name, name.toLowerCase(), rank);
  if (link) ownPerson(sqlite, pid, userId); // players.user_id: the Link account route only records a Discord ID since the identity split (tests/guild-owner-fixture.js)
  return { pid, cid, id };
}

module.exports = { seatOnRoster, NAMESPACE, REALM_ID };
