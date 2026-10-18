// ── GUILD SCRIPT MANIFEST ───────────────────────────────────────
// The guild shell's scripts in load order: the ONE list. js/guild/load.js injects them in the browser (index.html, faq.html and
// whats-new.html carry that single loader tag); tests/guild-scripts.js reads it under Node, so no page or suite repeats it.
//   A new page script is one line here, placed next to the page it builds on (not at the end: two branches that both add a
//   line right before app.js collide on merge). It must come after ui.js and before app.js.
(function (root) {
  'use strict';

  const SCRIPTS = [
    '/js/guild/icons.js',
    '/js/guild/api.js',
    '/js/guild/router.js',
    '/js/guild/people-sort.js',
    '/js/guild/roster-sort.js',
    '/js/guild/ui.js',
    '/js/guild/shell.js',
    '/js/guild/pages-signin.js',
    '/js/guild/pages-create.js',
    '/js/guild/pages-settings-teams.js',
    '/js/guild/pages-settings-people.js',
    '/js/guild/pages-settings-roles.js',
    '/js/guild/pages-settings-discord.js',
    '/js/guild/pages-settings-guests.js',
    '/js/guild/pages-settings-public.js',
    '/js/guild/pages-settings-applications.js',
    '/js/guild/pages-view.js',
    '/js/guild/pages-apply.js',
    '/js/guild/coverage.js',
    '/js/guild/pages-roster-tabs.js',
    '/js/guild/pages-roster.js',
    '/js/guild/pages-person.js',
    '/js/guild/pages-intent.js',
    '/js/guild/pages-recruiting.js',
    '/js/guild/pages-applications.js',
    '/js/guild/pages-import.js',
    '/js/guild/pages-import-bnet.js',
    '/js/guild/pages-import-csv.js',
    '/js/guild/plan-source.js',
    '/js/guild/gargul.js',
    '/js/guild/pages-attendance.js',
    '/js/guild/pages-person-attendance.js',
    '/js/guild/pages-loot.js',
    '/js/guild/pages-person-loot.js',
    '/js/guild/pages-person-trial.js',
    '/js/guild/pages-raids.js',
    '/js/guild/pages-calendar.js',
    '/js/guild/pages-raid.js',
    '/js/guild/pages-raid-loot.js',
    '/js/guild/pages-raid-signups.js',
    '/js/guild/pages-away.js',
    '/js/guild/pages-standing.js',
    '/js/guild/pages-raid-roster.js',
    '/js/guild/pages-review.js',
    '/js/guild/pages-settings-attendance.js',
    '/js/guild/pages-settings-loot.js',
    '/js/guild/pages-settings-bnet.js',
    '/js/guild/pages-settings-schedule.js',
    '/js/guild/pages-settings-activity.js',
    '/js/guild/pages-settings-data.js',
    '/js/guild/pages-attention.js',
    '/js/guild/pages-backfill.js',
    '/js/guild/pages-privacy.js',
    '/js/guild/pages-accounts.js',
    '/js/guild/pages-bnet.js',
    '/js/guild/roadmap-data.js',
    '/js/guild/pages-roadmap.js',
    '/js/guild/app.js',
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = SCRIPTS;
  else (root.Guild = root.Guild || {}).manifest = SCRIPTS;
})(typeof window !== 'undefined' ? window : globalThis);
