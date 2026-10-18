-- Raidsmith guild tracker, PM wave 5: the pre-raid loot board and manual loot awards. ADD COLUMN and new tables only.
--
-- loot_awards.source is CHECK (source IN ('gargul')) since 0008 and the table was rebuilt once already (0011). A CHECK cannot change without another
-- rebuild, and a rebuild of a table other tables lean on is what D1 cannot do safely, so a hand-made award keeps source = 'gargul' and says it is
-- manual in its own column. Its checksum is 'm-<uuid>' (38 characters), which no Gargul export can produce, so a re-import never touches it.
ALTER TABLE loot_awards ADD COLUMN manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1));

-- One raid's pasted loot lists: the ThatsMyBIS (TMB) prios and wishlists and the softres.it soft-reserves, normalized by the browser. Only what the
-- board needs is kept. A paste REPLACES the raid's rows of that source (the Worker deletes them first, in the same batch). The character name is
-- matched to a roster character on READ (name_key), exactly like a loot winner, so linking a name fixes the board too.
--   kind 'prio' / 'wish' (TMB; prio = the order, 1 = first in line, NULL = the export gave none) or 'sr' (softres; copies = how often the player reserved it).
-- An item name is only stored when the paste carried one (a TMB export holds item ids only; the board falls back to names from past awards).
CREATE TABLE raid_loot_lists (
  raid_id   TEXT NOT NULL,
  guild_id  TEXT NOT NULL,
  source    TEXT NOT NULL CHECK (source IN ('tmb', 'softres')),
  position  INTEGER NOT NULL CHECK (position >= 0),     -- the row's place in the paste: keeps the order and makes the key
  kind      TEXT NOT NULL CHECK (kind IN ('prio', 'wish', 'sr')),
  name      TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 12),
  name_key  TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 48),
  item_id   INTEGER NOT NULL CHECK (item_id > 0),
  item_name TEXT CHECK (item_name IS NULL OR length(item_name) <= 100),
  prio      INTEGER CHECK (prio IS NULL OR prio BETWEEN 0 AND 9999),
  copies    INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 20),
  PRIMARY KEY (raid_id, source, position),
  CHECK ((source = 'softres') = (kind = 'sr')),
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
CREATE INDEX raid_loot_lists_item ON raid_loot_lists(raid_id, item_id);

-- When each list was pasted and by whom (the account is dropped from the row if it is deleted).
CREATE TABLE raid_loot_imports (
  raid_id     TEXT NOT NULL,
  guild_id    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('tmb', 'softres')),
  row_count   INTEGER NOT NULL CHECK (row_count >= 0),
  imported_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (raid_id, source),
  FOREIGN KEY (guild_id, raid_id) REFERENCES raids(guild_id, id) ON DELETE CASCADE
);
