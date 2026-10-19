-- Raidsmith guild tracker, Loot page redesign + officer loot maintenance. ADD COLUMN and a new leaf table only: loot_awards is never rebuilt.
--
-- An officer can now correct an award (the winner, the item, the raid). edited_fields lists WHICH of "winner", "item", "raid" an officer changed, so a
-- later re-import of the same Gargul export keeps those fields and asks about them in the preview instead of overwriting them. The tag keeps its own
-- marker (tag_set_by / tag_set_at); the note is never written by an import.
ALTER TABLE loot_awards ADD COLUMN edited_fields TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(edited_fields));
ALTER TABLE loot_awards ADD COLUMN edited_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE loot_awards ADD COLUMN edited_at INTEGER;

-- A deleted GARGUL award leaves a tombstone, so a re-import does not bring it back unasked (the preview shows it as "deleted"). One row per
-- checksum; a manual award (checksum 'm-...') leaves none. The tombstone goes with its raid.
CREATE TABLE loot_award_deletions (
  guild_id    TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  checksum    TEXT NOT NULL,
  raid_id     TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  item_id     INTEGER NOT NULL,
  winner_name TEXT,
  deleted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, checksum),
  FOREIGN KEY (guild_id, team_id, raid_id) REFERENCES raids(guild_id, team_id, id) ON DELETE CASCADE
);
CREATE INDEX loot_award_deletions_raid ON loot_award_deletions(guild_id, raid_id);

-- "Keep both" on a possible duplicate reuses attention_dismissals (0024): its item_id is free text, so the key
-- 'loot-dupe:<raid_id>:<item_id>:<winner_name_key>' fits as kind 'loot_dupe', mode 'dismiss'. No table here.
