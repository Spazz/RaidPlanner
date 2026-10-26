-- Raidsmith user hierarchy, lane B3 (release R3): team requests, open raids, and one scheduler index. Additive only, no table rebuild.
-- Applied BY HAND before the B3 push (the build then finds nothing pending), so every statement is safe for the code of release R2.
--
-- WHAT EACH PART IS FOR
--  team_requests        a person asks that one of their characters (on no team) is placed on a team; the team's Team Leads and officers (team-scoped
--                       roster.edit) approve or reject, the person withdraws. One open (pending) request per character. Composite tenant key
--                       (guild_id, team_id) -> teams, (guild_id, character_id) -> characters (both parents have a unique (guild_id, id)); both
--                       cascade, so deleting a team, a character, a person or the guild takes its requests along. requested_by and decided_by are
--                       FKs to users ON DELETE SET NULL (Delete my data keeps the decided row without the account).
--  raids.guests_open    U R8-Q3: 1 = "Open to guests": a signed-in non-member may sign up without a join link. Set at raid creation and by raid edit
--                       (raids.edit). 0 = a link is needed, exactly as before.
--  raid_signups.guest_user_id
--                       the account behind an open-raid guest sign-up (guest = 1, join_link_id NULL). The partial unique index below is "one sign-up
--                       per account per raid" (sec A9-07); ON DELETE SET NULL, and Delete my data removes the rows first (worker/routes/auth.js).
--  guilds_next_sync_pinned
--                       the scheduler's due list reads only guilds with a pin (blizzard_guild_id IS NOT NULL); unpinned guilds sit at next_sync_at = 0
--                       and would be read every tick without it (B4a-code follow-up (a)). The due query already carries the same predicate.
--
-- SAFE FOR THE PREVIOUS RELEASE'S CODE (R2 runs on this schema until the push):
--   - both added columns are nullable or have a DEFAULT, and every INSERT INTO raids / raid_signups in the R2 Worker names its columns, so none of
--     its statements changes meaning; R2 never reads them. The unique index covers only rows with guest_user_id set, which is NULL on every row R2 writes.
--   - team_requests is a new table nobody writes. Its FKs only cascade (R2's DELETE of a team, character, person or guild works unchanged) or SET NULL.
--   - the index only adds maintenance work.
--
-- RERUN. wrangler records the file only after it ends cleanly and remote D1 applies a file atomically. ALTER TABLE ... ADD COLUMN has no IF NOT EXISTS, so
-- a rerun by hand after a stop part way through fails at the first ALTER already applied (recovery = Time Travel bookmark, or run the statements after
-- the last one that applied). Everything after the two ALTERs is CREATE ... IF NOT EXISTS, so the tail is rerunnable.
--
-- ROLLBACK (code only is enough: R2 ignores all of it). To drop the data as well, by hand, in this order:
--   DROP INDEX IF EXISTS guilds_next_sync_pinned;  DROP INDEX IF EXISTS raid_signups_guest_user;  DROP TABLE IF EXISTS team_requests;
--   (the two columns stay: SQLite drops a column only by rebuilding the table, which agent-brief forbids for raids and raid_signups)

ALTER TABLE raids ADD COLUMN guests_open INTEGER NOT NULL DEFAULT 0 CHECK (guests_open IN (0, 1));
ALTER TABLE raid_signups ADD COLUMN guest_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS raid_signups_guest_user ON raid_signups(raid_id, guest_user_id) WHERE guest_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_requests (
  id            TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  team_id       TEXT NOT NULL,
  character_id  TEXT NOT NULL,
  requested_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 200),
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, character_id) REFERENCES characters(guild_id, id) ON DELETE CASCADE
);
-- One open request per character; the pending list of a team (the Team Leads' to-do) and a person's own requests are index reads.
CREATE UNIQUE INDEX IF NOT EXISTS team_requests_open ON team_requests(character_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS team_requests_team ON team_requests(guild_id, team_id, status);
CREATE INDEX IF NOT EXISTS team_requests_user ON team_requests(requested_by, guild_id) WHERE requested_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS guilds_next_sync_pinned ON guilds(next_sync_at) WHERE blizzard_guild_id IS NOT NULL;
