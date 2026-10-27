// The ONE writer of a guild's Blizzard pin (user-hierarchy build, lane B6b part 3a; plan "Source/pin" rules (1), (3) and (6)).
//
// THE PIN is five columns of `guilds` (migration 0031): pinned_guild_slug, pinned_realm_slug, pinned_namespace, blizzard_guild_id, blizzard_realm_id. Every roster fetch for a pinned
// guild reads its target from them and from nowhere else (worker/roster-pin.js). They are written ONLY here, and only three paths may call a writer:
//   setupPinStatement      the setup pin: the Owner, a consumed `pin` fresh grant and a Battle.net-proven character on the live roster (worker/routes/bnet-pin.js)
//   creationPinStatement   the guild-creation proof (lane B10, not built): in-game creation by the in-game Guild Master proves the target in the same flow
//   flipPinStatement       the flip (lane B9, not built): the one atomic batch that turns a guild to 'ingame'
// and the switch away from the in-game source (sourceSwitchStatements below) nulls blizzard_guild_id. A CI grep (tests/guild/guild-b6b-p3a-tests.js) pins every SQL text in worker/ that writes
// one of these columns to this file, and pins the callers of the three writers; lanes B9 and B10 add their call and that test's expectation together.
//
// THE UNIQUE RULE. (game_version, region, blizzard_realm_id, blizzard_guild_id) is unique (index guilds_blizzard_identity, migration 0031): one Raidsmith guild per Blizzard guild. A
// writer that hits it throws a UNIQUE constraint error; the setup route answers 409 pin_taken. NULLs are distinct, so unpinned guilds never collide, and the switch away from
// 'ingame' frees the Blizzard guild by nulling blizzard_guild_id.
//
// A writer returns ONE statement for the caller's batch. `expected` is the pin AS READ (and the rank source): the statement changes nothing when the guild moved since (a flip, another
// pin), so a race never writes over a newer state. `guards` are the act's own conditions (the fresh-act marker, the Owner test): every pin write carries the marker of its act.
import { auditStatement } from './audit.js';
import { beginFreshAct } from './fresh.js';
import { ownerGuard } from './owner.js';
import { involvesIngame, leavesIngame, sourceSwitchParams } from './pin-target.js';

export { RANK_SOURCES, involvesIngame, leavesIngame, sourceSwitchParams, sourceSwitchProblem } from './pin-target.js';

// -> { sql, params }: the guild is exactly as read. `expected`: { rankSource, guildSlug, realmSlug, namespace, blizzardGuildId, blizzardRealmId } (any of them null).
export const expectedPinGuard = (guildId, expected) => ({
  sql: `EXISTS (SELECT 1 FROM guilds WHERE id = ? AND rank_source IS ? AND pinned_guild_slug IS ? AND pinned_realm_slug IS ? AND pinned_namespace IS ?
                  AND blizzard_guild_id IS ? AND blizzard_realm_id IS ?)`,
  params: [guildId, expected.rankSource, expected.guildSlug, expected.realmSlug, expected.namespace, expected.blizzardGuildId, expected.blizzardRealmId],
});

// The write itself. `pin`: { guildSlug, realmSlug, namespace, blizzardGuildId, blizzardRealmId } (all set). nextSyncAt: the sync lease the pin leaves behind (the caller syncs in the
// same flow, so the cron has nothing to do for one interval).
function pinStatement(db, { guildId, pin, expected, nextSyncAt, guards = [] }) {
  const extra = [expectedPinGuard(guildId, expected), ...guards];
  return db.prepare(
    `UPDATE guilds SET pinned_guild_slug = ?, pinned_realm_slug = ?, pinned_namespace = ?, blizzard_guild_id = ?, blizzard_realm_id = ?, next_sync_at = ?
      WHERE id = ?${extra.map((guard) => ` AND (${guard.sql})`).join('')}`,
  ).bind(pin.guildSlug, pin.realmSlug, pin.namespace, pin.blizzardGuildId, pin.blizzardRealmId, nextSyncAt, guildId, ...extra.flatMap((guard) => guard.params));
}

export const setupPinStatement = (db, args) => pinStatement(db, args);
export const creationPinStatement = (db, args) => pinStatement(db, args);
export const flipPinStatement = (db, args) => pinStatement(db, args);

// The audit row of a setup pin or re-pin: it must come DIRECTLY after the pin write in the batch and is written only when that write changed a row (`changes() = 1`) under the act's
// guard. before/after hold slugs and the namespace, no Blizzard ids.
export function pinAuditStatement(ctx, { guildId, userId, before, after, guard }) {
  return auditStatement(ctx, { guildId, actorUserId: userId, action: 'guild.pin', entityType: 'guild', entityId: guildId, before, after }, { sql: `changes() = 1 AND (${guard.sql})`, params: guard.params });
}

// ---------------------------------------------------------------------------
// The switch of the rank source (plan "Source/pin" rule (6)): to OR away from the in-game source is a fresh-auth act (purpose source_switch), and leaving 'ingame' nulls blizzard_guild_id.
// No route switches the rank source yet: lane B9's flip (to 'ingame') and unflip (away from it) consume these helpers inside their own batches.
// The opening of the act (worker/fresh.js beginFreshAct): a Battle.net fresh grant consumed in the caller's batch whenever the switch involves 'ingame' (a switch between the legacy
// rule and 'manual' is session-only: it moves no Owner seat and deletes nothing, unlike a manual guild's hand-over and delete, which ask for the fresh sign-in too), and the Owner
// test inside the consuming UPDATE. -> the shape of beginFreshAct; the caller puts
// `act.statements` first and `act.guard` on every statement after.
export async function beginSourceSwitch(ctx, { guildId, from, to }) {
  return beginFreshAct(ctx, {
    required: involvesIngame(from, to), purpose: 'source_switch', guildId, params: sourceSwitchParams(from, to), extra: ownerGuard(guildId, ctx.session.user.id),
  });
}

// The statements of the switch: the compare-and-set of rank_source from `from` to `to` (changes nothing when the guild moved since), nulling blizzard_guild_id when it leaves
// 'ingame', and the audit row, written only when the first statement changed a row. `guard`: the act's ({ sql, params }). Placeholders are bare `?` throughout (the audit helper is too).
export function sourceSwitchStatements(ctx, { guildId, from, to, guard }) {
  const unpin = leavesIngame(from, to);
  return [
    ctx.db.prepare(
      `UPDATE guilds SET rank_source = ?, blizzard_guild_id = CASE WHEN ? = 1 THEN NULL ELSE blizzard_guild_id END WHERE id = ? AND rank_source IS ? AND (${guard.sql})`,
    ).bind(to, unpin ? 1 : 0, guildId, from, ...guard.params),
    auditStatement(ctx, {
      guildId, actorUserId: ctx.session.user.id, action: 'guild.source_switch', entityType: 'guild', entityId: guildId, before: { rankSource: from }, after: { rankSource: to, unpinned: unpin },
    }, { sql: `changes() = 1 AND (${guard.sql})`, params: guard.params }),
  ];
}
