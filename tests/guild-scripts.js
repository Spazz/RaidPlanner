// The guild shell's scripts in load order (step 2b). index.html, faq.html and whats-new.html load them after their own
// scripts (minus /js/util.js, which each page already loads first); the page and guild suites check against this list.
const GUILD_SCRIPTS = ['/js/util.js'].concat(['icons', 'api', 'router', 'people-sort', 'roster-sort', 'ui', 'shell',
  'pages-signin', 'pages-create', 'pages-settings-teams', 'pages-settings-people', 'pages-settings-roles', 'pages-settings-discord', 'pages-settings-guests', 'pages-settings-public', 'pages-view', 'pages-roster',
  'pages-person', 'pages-import', 'pages-import-bnet', 'plan-source', 'gargul', 'pages-attendance', 'pages-person-attendance', 'pages-loot', 'pages-person-loot', 'pages-person-trial', 'pages-raids', 'pages-calendar',
  'pages-raid', 'pages-raid-loot', 'pages-raid-signups', 'pages-away', 'pages-standing', 'pages-raid-roster', 'pages-review', 'pages-settings-attendance', 'pages-settings-loot', 'pages-settings-bnet', 'pages-settings-schedule', 'pages-settings-activity', 'pages-attention', 'pages-backfill', 'pages-privacy', 'pages-accounts', 'pages-bnet', 'roadmap-data', 'pages-roadmap', 'app'].map(function (n) { return '/js/guild/' + n + '.js'; }));

module.exports = { GUILD_SCRIPTS: GUILD_SCRIPTS };
