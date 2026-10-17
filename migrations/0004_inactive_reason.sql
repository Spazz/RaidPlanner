-- Raidsmith guild tracker: why and when a person went Inactive. Both are optional and only meaningful while status = 'inactive'
-- (the Worker clears them on reactivation). left_on is a guild-local calendar date, TEXT YYYY-MM-DD.

ALTER TABLE players ADD COLUMN left_on TEXT CHECK (left_on IS NULL OR date(left_on) IS left_on);
ALTER TABLE players ADD COLUMN left_reason TEXT CHECK (left_reason IS NULL OR left_reason IN ('left', 'kicked', 'break', 'other'));
