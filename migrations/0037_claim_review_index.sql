-- Raidsmith user hierarchy, lane B6b part 2b (GM claim): ONE partial index and nothing else (no table, no column, no data).
--
-- WHY IT IS NEEDED. After the in-game Guild Master claims the Owner seat, the new Owner sees a "claim_review" item on the guild Home until they dismiss it, and the Owner-only
-- GET /api/guild/:gid/claim-review names the claim. Both find the guild's latest `guild.claim` audit row. audit_log is indexed by (guild_id, created_at) only, so without this index
-- every Home load of the Owner would walk the whole audit log of the guild looking for an action that almost no guild has. The partial index holds the claim rows alone: the lookup is
-- one index probe whatever the log holds. (Migration 0034's triggers guard UPDATE and DELETE of audit rows; an index does not touch them.)
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (the deploy applies this file BEFORE the new Worker is live): an index only adds maintenance work to the INSERTs of `guild.claim` rows,
-- which the old code writes at most once per guild (the legacy claim). No statement of the old Worker changes meaning.
CREATE INDEX IF NOT EXISTS audit_log_guild_claim ON audit_log(guild_id, created_at) WHERE action = 'guild.claim';
