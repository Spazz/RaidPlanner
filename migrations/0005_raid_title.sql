-- Raidsmith guild tracker: an optional title for a raid made by hand (a Raid-Helper event keeps its own title in event_title,
-- which a refresh or an unlink rewrites, so a hand-typed title needs its own column).

ALTER TABLE raids ADD COLUMN title TEXT CHECK (title IS NULL OR length(title) <= 100);
