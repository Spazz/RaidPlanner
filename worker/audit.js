import { newId } from './ids.js';

// The audited actions (nothing else writes the log).
export const AUDIT_ACTIONS = [
  'guild.create',
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
  'roster.import',
];

const COLUMNS = 'id, guild_id, actor_user_id, action, entity_type, entity_id, before, after, created_at';

// The audit INSERT, ready to go into the same DB.batch as the write it describes.
// before/after hold internal IDs and flags only. A guard ({ sql, params }) makes the row
// conditional (it is written only when the guarded write applied).
export function auditStatement({ db, randomBytes, now }, entry, guard = null) {
  const values = [
    newId('al', randomBytes),
    entry.guildId ?? null,
    entry.actorUserId ?? null,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
    entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
    now(),
  ];
  if (!guard) {
    return db.prepare(`INSERT INTO audit_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...values);
  }
  return db.prepare(`INSERT INTO audit_log (${COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`)
    .bind(...values, ...guard.params);
}
