import { newId } from './ids.js';
import { MEMBER_GUILD_IDS_SQL } from './membership.js';
import { ownerSql } from './owner.js';
import { wrote } from './d1-changes.js';

// The audited actions (nothing else writes the log).
export const AUDIT_ACTIONS = [
  'guild.create',
  'guild.update',
  'team.create',
  'team.rename',
  'team.archive',
  'team.restore',
  'roles.set',
  'guild_master.transfer',
  'access.remove',
  'access.restore',
  'account.delete',
  'guild.delete',
  'guild.export',
  'guild.claim',
  'guild_master.auto_promote',
  'person.create',
  'person.update',
  'person.delete',
  'person.notes',
  'character.create',
  'character.update',
  'character.delete',
  'character.main',
  'character.place',
  'character.release',
  'character.move',
  'team_request.create',
  'team_request.withdraw',
  'team_request.approve',
  'team_request.reject',
  'roster.import',
  'raid.create',
  'raid.delete',
  'raid.event',
  'raid.report',
  'raid.plan',
  'raid.plan_edit',
  'raid.manual',
  'attendance.decide',
  'attendance.undo',
  'attendance.link',
  'attendance.guest',
  'policy.update',
  'wcl.settings',
  'loot.import',
  'loot.update',
  'loot.delete',
  'loot.list',
  'loot.add',
  'loot.policy',
  'bnet.link',
  'bnet.unlink',
  'discord.link',
  'discord.unlink',
  'person.account_link',
  'person.account_unlink',
  'bnet.settings',
  'rank_map.update',
  'claim.create',
  'claim.withdraw',
  'claim.approve',
  'claim.reject',
  'character.claim',
  'signup.set',
  'signup.remove',
  'signup.link',
  'signup.lock',
  'schedule.update',
  'schedule.fill',
  'role.create',
  'role.update',
  'role.delete',
  'role.reset',
  'discord.maps',
  'roles.discord_sync',
  'guest.create',
  'guest.revoke',
  'public.update',
  'team.size',
  'team.trial_days',
  'raid.settings',
  'roster.publish',
  'roster.unpublish',
  'roster.decline',
  'away.set',
  'away.remove',
  'intent.open',
  'intent.close',
  'intent.pick',
  'intent.unpick',
  'recruiting.targets',
  'apply.settings',
  'application.submit',
  'application.update',
  'application.accept',
  'application.delete',
  'notify.update',
  'notify.disabled',
  'notify.test',
  'apikey.create',
  'apikey.revoke',
  'person.rank',
  'rank.dismiss',
  'duties.set',
  'launch.update',
  'launch.team',
  'attention.dismiss',
  'attention.restore',
  'join.create',
  'join.revoke',
  'signup.guest',
  'signup.guest_remove',
  'signup.guest_resolve',
  'signup.guests_clear',
  'signup.open',
  'signup.open_withdraw',
  'person.join',
  'character.match_roster',
  'person.match_create',
  'person.match_link',
  'character.proof_supersede',
  // Lane B6a part 2b: a character moved to the person whose Battle.net account proved it; a Former character whose name went to a dated alias.
  'character.rehome',
  'character.name_retire',
  // Lane B7a: blocks and tombstones, and the rows the prune/coalesce rules know by name (PRUNABLE_ACTIONS below).
  'person.block',
  'person.unblock',
  'block.match',
  'block.match_held',
  'person.core_rank',
  'person.ingame_rank',
  'person.former',
  'guild.claim_failed',
  'fresh.failed',
  // Lane B6b part 2a: a sign-in identity (Discord or Battle.net) of an account was linked or disconnected; written in each guild the account is a member of, never pruned.
  'identity.change',
  // Lane B6b part 2b: the Owner seat passed to the next account when its holder's account was deleted (permanent; the GM claim writes 'guild.claim', also permanent).
  'guild.succession',
  // Lane B7b: an officer kept a block that a tombstone match wrote (the review queue): it is a block like any other from then on. Never pruned.
  'block.keep',
  // Lane B6b part 3a: the Owner linked the guild to its in-game guild (setup pin or re-pin), and the rank source was switched (to the in-game roster or away from it, lane B9's flip and unflip). Permanent.
  'guild.pin',
  'guild.source_switch',
];

// The PRUNABLE set (plan "Audit"): per-person detail of a sync run and failures. The daily job deletes these past AUDIT_PRUNE_AFTER_MS; every other row is
// permanent. migrations/0034_audit_log_trigger.sql repeats the list (the trigger refuses a delete outside it) and a test keeps the two equal.
export const PRUNABLE_ACTIONS = Object.freeze(['person.core_rank', 'person.ingame_rank', 'person.former', 'guild.claim_failed', 'fresh.failed']);
export const AUDIT_PRUNE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
// The failures that coalesce to one counted row per user, guild and hour (failureAuditStatements).
export const COALESCED_FAILURE_ACTIONS = Object.freeze(['fresh.failed', 'guild.claim_failed']);
export const FAILURE_WINDOW_MS = 60 * 60 * 1000;

const COLUMNS = 'id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at, actor_short_id, actor_role';

// The actor snapshot of a row (migration 0031 columns), computed by the INSERT itself so it holds what the database says when the row is written:
//   actor_short_id  the first 8 characters of the id after its prefix (u_ab12CD34...): enough to tell two former members apart, nothing to look up
//   actor_role      'owner' (the Owner, worker/owner.js: the seat holder who is not suspended), else the best built-in role the actor EFFECTIVELY holds in the row's guild
//                   (effective_roles: stored + derived from the in-game rank; guild_master, officer, team_lead), else 'member'; NULL for a row with no actor or no guild
//                   (an account's own sign-in)
// Both survive the account's deletion (the foreign key sets actor_user_id NULL). Placeholders in order: actor | actor, guild | guild, actor, actor | guild, actor.
// snapshotSqlOf takes the actor and the guild as SQL expressions (a bare `?` for each use, or a numbered parameter).
const snapshotSqlOf = (actor, guild) => `substr(${actor}, 3, 8),
  CASE WHEN ${actor} IS NULL OR ${guild} IS NULL THEN NULL
       WHEN ${ownerSql(guild, actor)} THEN 'owner'
       ELSE COALESCE((SELECT ra.role_id FROM effective_roles ra JOIN roles r ON r.id = ra.role_id
                       WHERE ra.guild_id = ${guild} AND ra.user_id = ${actor} AND ra.role_id IN ('guild_master', 'officer', 'team_lead') ORDER BY r.rank LIMIT 1), 'member') END`;
const SNAPSHOT_SQL = snapshotSqlOf('?', '?');
const snapshotParams = (actorUserId, guildId) => [actorUserId, actorUserId, guildId, guildId, actorUserId, actorUserId, guildId, actorUserId];
// A row that records WHAT the actor became rather than what they were (the GM claim: the claimant takes the seat in the same batch, and a claimant whose character the batch has
// not placed yet would read as suspended): the role is given, the short id still comes from the actor. Placeholders: actor, role.
const FORCED_SNAPSHOT_SQL = 'substr(?, 3, 8), ?';
const FORCED_ROLES = Object.freeze(['owner', 'guild_master', 'officer', 'team_lead', 'member']);

// The audit INSERT, ready to go into the same DB.batch as the write it describes.
// before/after hold internal IDs and flags only. A guard ({ sql, params }) makes the row
// conditional (it is written only when the guarded write applied). entry.actorRole: the role to record instead of the one the database says (see FORCED_SNAPSHOT_SQL).
export function auditStatement({ db, randomBytes, now }, entry, guard = null) {
  const actorUserId = entry.actorUserId ?? null;
  const guildId = entry.guildId ?? null;
  if (entry.actorRole !== undefined && !FORCED_ROLES.includes(entry.actorRole)) throw new Error(`auditStatement: unknown actorRole ${entry.actorRole}`);
  const values = [
    entry.id || newId('al', randomBytes), // a caller that needs the row as a batch marker (worker/rehome.js) passes its own id
    guildId,
    actorUserId,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
    entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
    now(),
  ];
  const where = guard ? ` WHERE ${guard.sql}` : '';
  const forced = entry.actorRole !== undefined;
  const snapshotSql = forced ? FORCED_SNAPSHOT_SQL : SNAPSHOT_SQL;
  return db.prepare(`INSERT INTO audit_log (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ${snapshotSql}${where}`)
    .bind(...values, ...(forced ? [actorUserId, entry.actorRole] : snapshotParams(actorUserId, guildId)), ...(guard ? guard.params : []));
}

// One statement for a db.batch: one audit row for EACH entity a SELECT names (a bulk Block writes the same row for every account it blocked). buildSource(add) -> the SQL of a
// SELECT with ONE column named entity_id; `add(value)` registers a bound value and returns its numbered placeholder (?1, ?2, ...): the statement numbers all of its own, so the
// source may use them freely. The row is written only for the entities the SELECT returns, so the SELECT carries the guard (the block rows THIS call wrote). entry as for
// auditStatement without entityId and with one before/after for all rows.
export function auditManyStatement({ db, now }, entry, buildSource) {
  if (entry.actorRole !== undefined) throw new Error('auditManyStatement: the actor snapshot comes from the database');
  const values = [];
  const add = (value) => { values.push(value); return `?${values.length}`; };
  const guild = add(entry.guildId ?? null);
  const actor = add(entry.actorUserId ?? null);
  const source = buildSource(add);
  const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
  // (Built apart from prepare(): the interpolations are fixed column lists, numbered placeholders and the source SELECT, never request data.)
  const sql = `INSERT INTO audit_log (${COLUMNS})
     SELECT 'al_' || lower(hex(randomblob(16))), ${guild}, ${actor}, ${add(entry.action)}, ${add(entry.entityType)}, e.entity_id, ${add(json(entry.before))}, ${add(json(entry.after))}, ${add(now())},
            ${snapshotSqlOf(actor, guild)}
       FROM (${source}) e`;
  return db.prepare(sql).bind(...values);
}

// One statement for a db.batch: the same audit row in EACH guild the actor is a member of right now (identity changes: plan "Identity-change protection" (c)). Put it BEFORE
// the statements that change what membership reads (a Discord disconnect deletes the user_servers rows). The snapshot columns follow the single-row form: actor_role is read per
// guild. entry: { actorUserId, action, entityType, entityId, after }. guard: { sql, params } as for auditStatement (bare placeholders; they are renumbered after the six this statement binds).
export function auditEachMemberGuildStatement({ db, randomBytes, now }, entry, guard = null) {
  // D1 does not take numbered and bare placeholders in one statement: the guard's bare `?` are numbered on from ?7.
  let next = 6;
  const where = guard ? ` WHERE ${guard.sql.replace(/\?/g, () => `?${++next}`)}` : '';
  return db.prepare(
    `INSERT INTO audit_log (${COLUMNS})
     SELECT 'al_' || lower(hex(randomblob(16))), mgs.guild_id, ?1, ?2, ?3, ?4, NULL, ?5, ?6, substr(?1, 3, 8),
            CASE WHEN ${ownerSql('mgs.guild_id', '?1')} THEN 'owner'
                 ELSE COALESCE((SELECT ra.role_id FROM effective_roles ra JOIN roles r ON r.id = ra.role_id
                                 WHERE ra.guild_id = mgs.guild_id AND ra.user_id = ?1 AND ra.role_id IN ('guild_master', 'officer', 'team_lead') ORDER BY r.rank LIMIT 1), 'member') END
       FROM (${MEMBER_GUILD_IDS_SQL}) mgs${where}`,
  ).bind(entry.actorUserId, entry.action, entry.entityType, entry.entityId ?? null, entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after), now(),
    ...(guard ? guard.params : []));
}

// ---------------------------------------------------------------------------
// Failure coalescing (plan "Audit": repeated failures by one user in one guild become ONE counted row per hour)
//
// audit_log rows are never updated (migrations/0034), so the count cannot live in the row. The first failure of an hour inserts the row (count 1); every
// failure bumps a counter in rate_limits (key auditfail:<action>:<guild>:<user>:<hour>); the daily retention job (flushFailureCounters, called by
// worker/retention.js) writes ONE summary row per hour that saw more than one failure ({ count, windowStart, coalesced: true }) and drops the counter. So an
// attacker who fails ten thousand times in an hour leaves two rows, not ten thousand.
export const FAILURE_KEY_PREFIX = 'auditfail:';
export const failureCounterKey = (action, guildId, userId, bucket) => `${FAILURE_KEY_PREFIX}${action}:${guildId}:${userId}:${bucket}`;

// -> two statements for the caller's batch (the refusal itself is thrown after the batch). ctx: { db, randomBytes, now }.
export function failureAuditStatements(ctx, { guildId, userId, action, detail = null }) {
  if (!COALESCED_FAILURE_ACTIONS.includes(action)) throw new Error(`failureAuditStatements: ${action} is not a coalesced failure action`);
  if (!guildId || !userId) throw new Error('failureAuditStatements: a guild and a user are required');
  const bucket = Math.floor(ctx.now() / FAILURE_WINDOW_MS);
  const windowStart = bucket * FAILURE_WINDOW_MS;
  const key = failureCounterKey(action, guildId, userId, bucket);
  return [
    ctx.db.prepare(
      'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = count + 1',
    ).bind(key, windowStart),
    auditStatement(ctx, {
      guildId, actorUserId: userId, action, entityType: 'user', entityId: userId, after: { count: 1, windowStart, ...(detail ? { detail } : {}) },
    }, { sql: '(SELECT count FROM rate_limits WHERE key = ?) = 1', params: [key] }),
  ];
}

// A daily run summarises at most this many counters (2 D1 statements each, plus the read): the rest wait for the next run, oldest first. A run is then at most
// 1 + 2 * FLUSH_LIMIT = 201 statements (a flood of counters would have made it 1,001).
export const FLUSH_LIMIT = 100;

// The summary rows of the hours that saw more than one failure, for the daily job. deps: { db, now, randomBytes } -> number of summaries written.
export async function flushFailureCounters({ db, now, randomBytes }) {
  const nowMs = now();
  const due = await db.prepare(
    `SELECT key, window_start, count FROM rate_limits WHERE substr(key, 1, ${FAILURE_KEY_PREFIX.length}) = ? AND window_start <= ? ORDER BY window_start, key LIMIT ?`,
  ).bind(FAILURE_KEY_PREFIX, nowMs - FAILURE_WINDOW_MS, FLUSH_LIMIT).all();
  let written = 0;
  for (const row of due.results) {
    const [action, guildId, userId] = row.key.slice(FAILURE_KEY_PREFIX.length).split(':');
    const statements = [];
    if (row.count > 1 && COALESCED_FAILURE_ACTIONS.includes(action) && guildId && userId) {
      // The guild must still exist (its rows cascade away with it); the account may be gone since: the actor is then NULL and the id stays as entity_id.
      statements.push(db.prepare(
        `INSERT INTO audit_log (${COLUMNS})
         SELECT ?, g.id, (SELECT u.id FROM users u WHERE u.id = ?), ?, 'user', ?, NULL, ?, ?, substr(?, 3, 8), NULL FROM guilds g WHERE g.id = ?`,
      ).bind(newId('al', randomBytes), userId, action, userId, JSON.stringify({ count: row.count, windowStart: row.window_start, coalesced: true }),
        row.window_start + FAILURE_WINDOW_MS - 1, userId, guildId));
    }
    statements.push(db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(row.key));
    const results = await db.batch(statements);
    if (statements.length === 2 && wrote(results[0])) written++;
  }
  return written;
}
