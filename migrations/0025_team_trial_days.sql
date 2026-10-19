-- Per-team trial length (Guild settings > Teams): used by Add person, Accept and Extend. ALTER only: D1 cannot rebuild teams.
ALTER TABLE teams ADD COLUMN trial_days INTEGER NOT NULL DEFAULT 14;
