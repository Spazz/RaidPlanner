-- Officer-entered Guest / Pug character names override one imported sign-up.
-- Kept on the native row so refreshing Raid-Helper cannot erase the decision.
ALTER TABLE raid_signups ADD COLUMN rh_signup_id INTEGER
  CHECK (rh_signup_id IS NULL OR (source = 'raidsmith' AND guest = 1 AND player_id IS NULL));
CREATE UNIQUE INDEX raid_signups_guest_resolution ON raid_signups(raid_id, rh_signup_id)
  WHERE rh_signup_id IS NOT NULL;
