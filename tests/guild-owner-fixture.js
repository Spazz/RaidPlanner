// The ownership fixture of the identity split (user decision 2026-10-26). Nothing here is a test.
//
// "My person" is players.user_id and nothing else, and players.user_id is written only by Battle.net proof, the account holder's own accepted application and an
// officer-approved "This is me" claim (tests/guild/guild-identity-split-tests.js pins the writers). The officer's Link account route no longer makes an account the owner of a
// person (it records the account's Discord ID), so a suite that needs "this account owns this person" writes the column itself, the way those paths leave it. The version stays
// as it is (a person created with linkUserId was never bumped by that link); { bump: true } moves it like a later link does. The proof-clearing trigger of migration 0031 fires as it does for a real change of owner.
//   ownPerson(sqlite, personId, userId, { bump })       sqlite = the D1 stand-in's node:sqlite handle (world.db.sqlite)
//   disownPerson(sqlite, personId)
//   ownByDiscord(sqlite)
const assert = require('node:assert/strict');

function ownPerson(sqlite, personId, userId, { bump = false } = {}) {
  assert(userId, 'ownPerson: no account id (is the account signed in?)');
  const result = sqlite.prepare(`UPDATE players SET user_id = ?${bump ? ', version = version + 1' : ''} WHERE id = ?`).run(userId, personId);
  assert.equal(result.changes, 1, `ownPerson: no person ${personId}`);
}

function disownPerson(sqlite, personId, { bump = false } = {}) {
  const result = sqlite.prepare(`UPDATE players SET user_id = NULL${bump ? ', version = version + 1' : ''} WHERE id = ?`).run(personId);
  assert.equal(result.changes, 1, `disownPerson: no person ${personId}`);
}

// Every person that records a Discord ID of a signed-in account becomes that account's: the fixture for suites that stamp discord_user_id on people with raw SQL BEFORE the
// member signs in, where the old rule made the person the member's by the Discord ID alone. Call it after the sign-ins. (Migration 0039 is the production form of this.)
function ownByDiscord(sqlite) {
  sqlite.exec(`UPDATE players SET user_id = (SELECT u.id FROM users u WHERE u.discord_id = players.discord_user_id)
                WHERE user_id IS NULL AND discord_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.discord_id = players.discord_user_id)`);
}

module.exports = { ownPerson, disownPerson, ownByDiscord };
