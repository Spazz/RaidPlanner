-- Raidsmith guild tracker, officer Home redesign (round 2): a to-do on the Needs attention home can be dismissed, snoozed or (the attendance watch list)
-- marked Reviewed, and that is SHARED by every officer of the guild. One row per (guild, item): the item id is the one /attention hands out
-- ('no_loot:r_..', 'trial:p_..', 'watch:t_..:p_..'). Add only: a new leaf table, nothing is rebuilt.
--   mode         dismiss (hidden until the fingerprint changes) | snooze (hidden until `until`, or until the fingerprint changes) | reviewed (watch list)
--   until        ms; NULL = until the fingerprint changes. Set by the Worker from its per-kind policy (worker/attention.js DISMISS_RULES), never by a client.
--   fingerprint  what the item looked like when it was hidden (the unmatched names, the trial end date, ...); the item returns when it no longer matches.

CREATE TABLE attention_dismissals (
  id            TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  team_id       TEXT,
  mode          TEXT NOT NULL CHECK (mode IN ('dismiss', 'snooze', 'reviewed')),
  until         INTEGER,
  fingerprint   TEXT NOT NULL,
  dismissed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (guild_id, item_id)
);
