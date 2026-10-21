-- 0027: the full Planner plan of a guild raid, one JSON document per raid (tasks/open/guild-plans-db-plan.md, section 2).
-- A new leaf table: nothing references it and `raids` is untouched (D1 cannot disable foreign keys, so no table is rebuilt).
--   data       the whole PlanStore.capture() object (sign-up markers and the change log stay out), at most 256 KB.
--   rev        1, 2, 3 ... one per accepted change; a writer names the rev it started from (baseRev) and loses with a 409 when it is stale.
--   write_id   random per write: the same batch's projection into raid_plan / raids.plan_* is guarded on it.
--   lineup_fp  fingerprint of what the raid page reads (plan name + who sits in which group); the projection is rewritten only when it changes.
--   audited_by / audited_at   the last actor that got an Activity-log row for editing this plan, so one editing session is one row per 30 minutes.
CREATE TABLE raid_plan_doc (
  raid_id       TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  rev           INTEGER NOT NULL CHECK (rev >= 1),
  write_id      TEXT NOT NULL,
  schema_ver    INTEGER NOT NULL DEFAULT 1,
  game_version  TEXT NOT NULL,
  data          TEXT NOT NULL CHECK (json_valid(data) AND length(data) <= 262144),
  lineup_fp     TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    INTEGER NOT NULL,
  audited_by    TEXT,
  audited_at    INTEGER,
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
