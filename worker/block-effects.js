// What a block does to the roster (user-hierarchy build, lane B7a; plan M11 "Users v2"): a block takes the person off every team and withdraws their upcoming
// sign-ups, in the SAME batch as the block itself. The person is told nothing beyond today's "access removed".
//
//   off every team ........ characters.team_id = NULL for every character of the person(s) (the characters stay on the roster, teamless)
//   upcoming sign-ups ..... the native sign-ups (not Raid-Helper rows, which live in Discord) on raids that have not started, the standing sign-ups, and for an
//                           account the open-raid guest sign-ups it made (raid_signups.guest = 1, guest_user_id)
//   pending team requests . the account's own, still waiting
//   raids ................. the upcoming raids that read those sign-ups are re-versioned and the raids that depend on the rosters are marked stale
// "The person(s)": an account's persons are the roster people linked to it (players.user_id, or the Discord id it carries: worker/membership.js ownPlayerSql); an
// account-less block names the one person. Every statement carries `guard` ({ sql, params }): the block row this very call wrote is there, so a lost race writes
// nothing. A pending-review block (a tombstone match) does NOT run these: the match only enforces, an officer's Keep decides (lane B7b).
import { markRaidsStale } from './attendance-store.js';
import { ownPlayerSql } from './membership.js';
import { nameKey } from './roster-data.js';

const personsOfAccount = (guildId, userId) => ({
  sql: `SELECT players.id FROM players WHERE players.guild_id = ? AND ${ownPlayerSql('players', '?')}`,
  params: [guildId, userId, userId],
});
const onePerson = (guildId, playerId) => ({ sql: 'SELECT players.id FROM players WHERE players.id = ? AND players.guild_id = ?', params: [playerId, guildId] });

// target: { userId } for an account, { playerId } for an account-less person. -> Promise<statement[]> (run them AFTER the block insert, in its batch).
export async function blockEffectStatements(db, { guildId, target, nowMs, guard }) {
  const persons = target.userId ? personsOfAccount(guildId, target.userId) : onePerson(guildId, target.playerId);
  // The characters that sit on a team now (the release below empties it): which teams' raids and attendance change.
  const placed = await db.prepare(
    `SELECT c.name, c.team_id FROM characters c WHERE c.guild_id = ? AND c.player_id IN (${persons.sql})`,
  ).bind(guildId, ...persons.params).all();
  const teamIds = [...new Set(placed.results.map((row) => row.team_id).filter(Boolean))];
  const nameKeys = placed.results.map((row) => nameKey(row.name));

  const inPersons = `player_id IN (${persons.sql})`;
  const upcoming = 'raid_id IN (SELECT id FROM raids WHERE guild_id = ? AND starts_at > ?)';
  const guestOfAccount = target.userId ? ' OR (guest = 1 AND guest_user_id = ?)' : '';
  const statements = [
    // 1. The raids that read what is about to go (the person's team and every upcoming raid the person is signed up for) are re-versioned.
    db.prepare(
      `UPDATE raids SET policy_fp = '', version = version + 1
        WHERE guild_id = ? AND starts_at > ?
          AND (team_id IN (SELECT team_id FROM characters WHERE guild_id = ? AND team_id IS NOT NULL AND ${inPersons})
               OR id IN (SELECT raid_id FROM raid_signups WHERE guild_id = ? AND (${inPersons}${guestOfAccount})))
          AND ${guard.sql}`,
    ).bind(guildId, nowMs, guildId, ...persons.params, guildId, ...persons.params, ...(target.userId ? [target.userId] : []), ...guard.params),
    // 2. Off every team.
    db.prepare(`UPDATE characters SET team_id = NULL, updated_at = ? WHERE guild_id = ? AND team_id IS NOT NULL AND ${inPersons} AND ${guard.sql}`)
      .bind(nowMs, guildId, ...persons.params, ...guard.params),
    // 3. The upcoming native sign-ups (the person's, and an account's open-raid guest sign-ups).
    db.prepare(
      `DELETE FROM raid_signups WHERE guild_id = ? AND source = 'raidsmith' AND ((guest = 0 AND ${inPersons})${guestOfAccount}) AND ${upcoming} AND ${guard.sql}`,
    ).bind(guildId, ...persons.params, ...(target.userId ? [target.userId] : []), guildId, nowMs, ...guard.params),
    // 4. The standing sign-ups.
    db.prepare(`DELETE FROM standing_signups WHERE guild_id = ? AND ${inPersons} AND ${guard.sql}`).bind(guildId, ...persons.params, ...guard.params),
    // 5. Raids that depend on the rosters of the teams the person left.
    markRaidsStale(db, guildId, nameKeys, null, teamIds, guard),
  ];
  if (target.userId) {
    statements.push(db.prepare("DELETE FROM team_requests WHERE guild_id = ? AND requested_by = ? AND status = 'pending' AND " + guard.sql).bind(guildId, target.userId, ...guard.params));
  }
  return statements;
}
