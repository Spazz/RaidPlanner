-- Raidsmith user hierarchy: mark every raid's attendance stale, for the R2 push.
--
-- From R2 on attendance is read per CHARACTER (expected on a team, home team for the Other-team credit, the dated name aliases), so the stored results of every
-- past raid were computed under the old rules. A raid is "stale" when its policy_fp is '' (worker/attendance-view.js raidState: a recompute never ran or the
-- inputs changed since); the team page, the raid page and Needs attention then show it as needing a recalculation instead of as reviewed, and the next
-- recompute (an officer's Recalculate, or any write to the raid's inputs) rewrites it under the new rules. The stored attendance rows, officer decisions and
-- flags are left exactly as they are until then.
--
-- The same two columns every input write sets (worker/attendance-store.js bumpRaidStatement): policy_fp = '' and version = version + 1 (a recompute that read the
-- old inputs finds the version changed and discards its write). Only raids that are not stale yet are touched, so the statement is IDEMPOTENT: a second run
-- changes nothing, not even a version. One statement, so it applies whole or not at all.
--   npx wrangler d1 execute raidsmith --remote --file tools/hierarchy/mark-all-stale.sql        (--local --persist-to <state> for a local database)
-- Run it right after the R2 push, once.

UPDATE raids SET policy_fp = '', version = version + 1 WHERE policy_fp != '';
