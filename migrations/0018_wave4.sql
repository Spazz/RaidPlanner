-- PM wave 4: Discord channel posts, reminders to people who have not answered, the roster confirm reminder and the automatic Raid-Helper refresh.
-- New tables and ADD COLUMN only (D1 cannot rebuild a table the others reference).
--
--   team_notifications  one row per team that has anything set: the Discord channel webhook (a secret: the Worker never sends it back, only its last
--                       four characters), the role an officer wants mentioned, the five switches and the no-reply lead time. Every switch is off by default,
--                       so adding a webhook never starts posts nobody asked for. A webhook Discord answers 404/401 to is switched off (webhook_state
--                       'disabled') and shows in Needs attention until an officer saves a webhook again.
--   notification_log    one row per message the Worker sent or tried to send: the dedupe key makes every message once-only (a roster post is keyed by the
--                       publish time, a reminder by its raid and kind). 'pending' is claimed-and-sending, 'retry' a transient failure the next run may
--                       try again (attempts counts), 'failed' is final. No message text and no names are kept. The daily run prunes rows after 90 days.
--   reminder_optouts    "Don't mention me in reminders" (Linked accounts): one row per account. It goes with the account (Delete my data).
-- raids.event_checked_at   the last time the scheduler asked Raid-Helper about the raid's event, whatever the answer (it paces the next ask).
-- raids.event_moved_on     the date Raid-Helper says the event is on when that is not the raid's date: the scheduler never moves a raid, it only flags it.

CREATE TABLE team_notifications (
  team_id          TEXT PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  webhook_url      TEXT CHECK (webhook_url IS NULL OR length(webhook_url) <= 220),
  webhook_state    TEXT NOT NULL DEFAULT 'ok' CHECK (webhook_state IN ('ok', 'disabled')),
  disabled_at      INTEGER,
  disabled_status  INTEGER,
  role_mention     TEXT CHECK (role_mention IS NULL OR (length(role_mention) BETWEEN 17 AND 20 AND role_mention NOT GLOB '*[^0-9]*')),
  post_roster      INTEGER NOT NULL DEFAULT 0 CHECK (post_roster IN (0, 1)),
  post_loot        INTEGER NOT NULL DEFAULT 0 CHECK (post_loot IN (0, 1)),
  post_reminders   INTEGER NOT NULL DEFAULT 0 CHECK (post_reminders IN (0, 1)),
  post_noreply     INTEGER NOT NULL DEFAULT 0 CHECK (post_noreply IN (0, 1)),
  noreply_hours    INTEGER NOT NULL DEFAULT 24 CHECK (noreply_hours IN (6, 12, 24, 48)),
  post_confirm     INTEGER NOT NULL DEFAULT 0 CHECK (post_confirm IN (0, 1)),
  updated_at       INTEGER NOT NULL,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX team_notifications_guild ON team_notifications(guild_id);

CREATE TABLE notification_log (
  id           TEXT PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  team_id      TEXT NOT NULL,
  raid_id      TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('roster', 'loot', 'remind_24h', 'remind_2h', 'no_reply', 'confirm')),
  dedupe_key   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'retry', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  http_status  INTEGER,
  people       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  sent_at      INTEGER,
  FOREIGN KEY (guild_id, team_id) REFERENCES teams(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX notification_log_dedupe ON notification_log(guild_id, dedupe_key);
CREATE INDEX notification_log_created ON notification_log(created_at);

CREATE TABLE reminder_optouts (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);

ALTER TABLE raids ADD COLUMN event_checked_at INTEGER;
ALTER TABLE raids ADD COLUMN event_moved_on TEXT CHECK (event_moved_on IS NULL OR date(event_moved_on) IS event_moved_on);
