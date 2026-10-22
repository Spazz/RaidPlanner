-- 0028: live share links (/<version>/<id>), moved from Upstash to D1 (worker/share.js). A new leaf table: nothing references it.
--   id          the 7-character link id in the URL (0-9, A-Z, a-z).
--   code        the plan's share code (Import.encodeSharePayload), at most 32 KB, URL-safe characters only.
--   updated_at  ms; the Planner compares it to decide whether a remote copy is newer.
--   expires_at  ms; 30 days after the last save. Reads ignore expired rows, the daily cron deletes them.
CREATE TABLE share_links (
  id          TEXT PRIMARY KEY CHECK (length(id) = 7),
  code        TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 32768),
  updated_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_share_links_expires ON share_links(expires_at);
