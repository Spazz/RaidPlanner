-- Raidsmith user hierarchy, lane B7a (R4): the audit_log protection. TWO TRIGGERS and nothing else (no table, no column, no index, no data).
-- (Plan "Migrations": 0034 (B7, R4): audit_log trigger only.)
--
-- The audit log is append-only. Exactly these changes are allowed; everything else RAISE(ABORT)s, which rolls the whole statement (and a db.batch) back:
--   UPDATE  that sets actor_user_id to NULL and changes nothing else. This is the foreign key's own ON DELETE SET NULL when an account is deleted
--           (Delete my data), so the actor snapshot columns (actor_short_id, actor_role, migration 0031) are what remains of the person.
--   DELETE  when the row's guild no longer exists. This is the foreign key's own ON DELETE CASCADE when a guild is deleted. SQLite runs the cascade AFTER
--           the parent row is gone, so the trigger sees the guild missing; tests/guild/guild-b7a-blocks-tests.js pins that on the node:sqlite D1 stand-in.
--   DELETE  of a row of the PRUNABLE set older than 180 days. The set is the actions below; worker/audit.js PRUNABLE_ACTIONS repeats them and a test keeps
--           the two lists equal (changing the set needs a new migration that drops and recreates audit_log_no_delete). Age is the database clock (the
--           trigger has no way to be told one); the daily job (worker/retention.js) cuts at 180 days plus one hour, so a clock skew never makes it
--           ask for a row the trigger still protects.
--             person.core_rank    a character's core rank changed (per-person detail of a sync or a map edit)
--             person.ingame_rank  a character's in-game rank changed (per-person detail of a sync)
--             person.former       a character entered Former (per-person detail of a sync)
--             guild.claim_failed  a failed Guild Master claim (coalesced to one counted row per hour, worker/audit.js failureAuditStatements)
--             fresh.failed        a failed fresh-auth (the same)
--           Permission-tier, Owner, proof, block, tombstone, successful claim, creation and configuration rows are never in the set.
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live):
--   - the previous Worker only ever INSERTs into audit_log (worker/audit.js auditStatement; nothing UPDATEs or DELETEs a row), so no statement of it
--     touches a trigger. The two paths that change rows do so through the foreign keys and are both allowed above: DELETE FROM users (Delete my data,
--     worker/routes/auth.js deleteMe) sets actor_user_id NULL, and DELETE FROM guilds (deleting a guild) cascades the guild's rows away.
--   - the triggers are inert until a row is changed, so applying them touches no data.
-- Both are IF NOT EXISTS, so a rerun is harmless. Rollback = DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
WHEN NOT (
  NEW.actor_user_id IS NULL
  AND NEW.id IS OLD.id
  AND NEW.guild_id IS OLD.guild_id
  AND NEW.action IS OLD.action
  AND NEW.entity_type IS OLD.entity_type
  AND NEW.entity_id IS OLD.entity_id
  AND NEW."before" IS OLD."before"
  AND NEW."after" IS OLD."after"
  AND NEW.created_at IS OLD.created_at
  AND NEW.actor_short_id IS OLD.actor_short_id
  AND NEW.actor_role IS OLD.actor_role
)
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows cannot be changed');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
WHEN NOT (
  (OLD.guild_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM guilds WHERE id = OLD.guild_id))
  OR (
    OLD.action IN ('person.core_rank', 'person.ingame_rank', 'person.former', 'guild.claim_failed', 'fresh.failed')
    AND OLD.created_at < (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 15552000000)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows cannot be deleted');
END;
