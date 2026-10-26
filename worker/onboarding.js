// The setup checklist on a guild's Home (Phase 8): six steps that tick themselves from the guild's own data, so there is no progress to save but the
// "dismissed" flag (guilds.onboarding_dismissed_at, migration 0016). The page owns the wording and the links; this file says which steps are done.
//   teams       the guild has an active team (Create a guild makes one, so this step is done from the start; the page offers the rename)
//   roster      at least one person on the roster (any import, or added by hand)
//   attendance  the attendance rules were saved once (a guild-wide or a team row exists)
//   raid        at least one raid
//   officers    somebody besides the Guild Master holds a role, or a Discord role is mapped to one
//   loot        at least one loot award
import { isGranted } from './permissions.js';

export const ONBOARDING_STEPS = ['teams', 'roster', 'attendance', 'raid', 'officers', 'loot'];

// Who is shown the card, and who may dismiss it: whoever sets the guild up (the Guild Master and everyone who may manage teams).
export function sees(guildContext) {
  return guildContext.isGuildMaster || isGranted(guildContext.can['guild.teams']);
}

// The one statement that reads the flags (null when the viewer is not shown the card): GET /attention puts it in its own batch, so Home stays at
// four D1 calls. shapeOnboarding turns its result into the payload.
export function onboardingStatement(db, guildContext) {
  if (!sees(guildContext)) return null;
  return db.prepare(
    `SELECT g.onboarding_dismissed_at AS dismissed_at,
            (SELECT COUNT(*) FROM teams WHERE guild_id = g.id AND archived = 0) AS active_teams,
            EXISTS (SELECT 1 FROM players WHERE guild_id = g.id) AS has_people,
            EXISTS (SELECT 1 FROM attendance_policies WHERE guild_id = g.id) AS has_policy,
            EXISTS (SELECT 1 FROM raids WHERE guild_id = g.id) AS has_raid,
            EXISTS (SELECT 1 FROM effective_roles WHERE guild_id = g.id AND role_id != 'guild_master')
              OR EXISTS (SELECT 1 FROM discord_role_maps WHERE guild_id = g.id) AS has_staff,
            EXISTS (SELECT 1 FROM loot_awards WHERE guild_id = g.id) AS has_loot
       FROM guilds g WHERE g.id = ?1`,
  ).bind(guildContext.guild.id);
}

// -> null (not for this viewer, dismissed, or every step is done) or { steps: [{ id, done }], done, total }. result: the statement's D1 result, or undefined.
export function shapeOnboarding(result) {
  const row = result && result.results ? result.results[0] : null;
  if (!row || row.dismissed_at !== null) return null;
  const doneBy = {
    teams: row.active_teams > 0,
    roster: row.has_people === 1,
    attendance: row.has_policy === 1,
    raid: row.has_raid === 1,
    officers: row.has_staff === 1,
    loot: row.has_loot === 1,
  };
  const steps = ONBOARDING_STEPS.map((id) => ({ id, done: doneBy[id] }));
  const done = steps.filter((step) => step.done).length;
  return done === steps.length ? null : { steps, done, total: steps.length };
}
