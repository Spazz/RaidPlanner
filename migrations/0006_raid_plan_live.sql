-- Raidsmith guild tracker: the live share link (its 7-character id) of a raid's plan, so the Planner can reopen the saved plan.
-- Set together with plan_label by PUT .../plan when the plan came from a live link, cleared by DELETE .../plan.

ALTER TABLE raids ADD COLUMN plan_live TEXT CHECK (plan_live IS NULL OR (length(plan_live) = 7 AND plan_live NOT GLOB '*[^0-9A-Za-z]*'));
