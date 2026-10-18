-- Raidsmith guild tracker, PM wave 8 (WoW Forever launch readiness), part 2: a first name, a space and a surname in a pasted TMB / softres list.
-- 0019 made raid_loot_lists with CHECK (length(name) BETWEEN 2 AND 12) and a CHECK cannot be changed in place. The table is a LEAF (nothing references it, and
-- D1 cannot rebuild a referenced one), so it is copied: a Forever name is up to 25 characters (12 + a space + 12). Its own file, after 0022, so a database
-- that has not yet got 0019 (guild-loot-worker-tests.js builds one on purpose) can take 0022 first.

CREATE TABLE raid_loot_lists_w8 (
  raid_id   TEXT NOT NULL,
  guild_id  TEXT NOT NULL,
  source    TEXT NOT NULL CHECK (source IN ('tmb', 'softres')),
  position  INTEGER NOT NULL CHECK (position >= 0),
  kind      TEXT NOT NULL CHECK (kind IN ('prio', 'wish', 'sr')),
  name      TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 25),
  name_key  TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 48),
  item_id   INTEGER NOT NULL CHECK (item_id > 0),
  item_name TEXT CHECK (item_name IS NULL OR length(item_name) <= 100),
  prio      INTEGER CHECK (prio IS NULL OR prio BETWEEN 0 AND 9999),
  copies    INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 20),
  PRIMARY KEY (raid_id, source, position),
  CHECK ((source = 'softres') = (kind = 'sr')),
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
INSERT INTO raid_loot_lists_w8 (raid_id, guild_id, source, position, kind, name, name_key, item_id, item_name, prio, copies)
  SELECT raid_id, guild_id, source, position, kind, name, name_key, item_id, item_name, prio, copies FROM raid_loot_lists;
DROP TABLE raid_loot_lists;
ALTER TABLE raid_loot_lists_w8 RENAME TO raid_loot_lists;
CREATE INDEX raid_loot_lists_item ON raid_loot_lists(raid_id, item_id);

