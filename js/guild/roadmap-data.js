// ── ROADMAP DATA (Future enhancements page) ─────────────────────
// The one place to add an enhancement: append an object to `items` below and bump `updated`. js/guild/pages-roadmap.js draws
// it (#/roadmap), and guild-roadmap-tests.js checks the shape. Plain data, no code. Order inside a status is the order shown;
// Shipped is sorted by `shipped`, newest first. Plain ASCII only (no Unicode symbols).
//   id       kebab-case, unique, never reused (ideas in the idea box point at it with roadmap_id)
//   title    short name           summary  one or two plain sentences for a guild officer
//   area     loot | roster | raids | attendance | signups | planner | discord | battlenet | platform | guilds | other
//   status   in_progress (being built) | next (agreed, not started) | idea (under review) | done (shipped)
//   source   user (the user asked for it) | backlog (agreed earlier) | pm (proposed by the Product Manager agent)
//   added    YYYY-MM-DD the day it entered this list
//   shipped  YYYY-MM-DD, done items only (required there)
//   why      optional: one muted line on what it fixes
// To ship an item: set status 'done', add `shipped`, bump `updated`. To turn an idea-box idea into an item: add the item,
// then `node tools/roadmap-ideas.js mark <ideaId> added --roadmap <id>`.
(function (G) {
  'use strict';

  G.roadmap = {
    updated: '2026-10-17',
    items: [
      // ── In progress ──
      {
        id: 'loot-history',
        title: 'Loot history (Phase 4)',
        summary: 'Import the Gargul Detailed JSON export for each raid, then see loot per player, per raid and per item, plus a loot balance (main-spec items per raid attended). Officers tag each drop (MS, OS, DE or Bank), and Loot settings choose who sees loot and how the balance counts.',
        area: 'loot', status: 'in_progress', source: 'user', added: '2026-10-17',
      },

      // ── Next up ──
      {
        id: 'battlenet-link-roster-import',
        title: 'Battle.net character link and guild roster import',
        summary: 'A Battle.net sign-in link imports a member\'s characters, and officers can import the guild roster. Imported data follows the 30-day data rule.',
        area: 'battlenet', status: 'next', source: 'user', added: '2026-10-17',
      },
      {
        id: 'native-signups',
        title: 'Native Raidsmith sign-ups',
        summary: 'Raiders sign up for upcoming raids in Raidsmith itself. The Raid-Helper import stays for guilds that use it.',
        area: 'signups', status: 'next', source: 'user', added: '2026-10-17',
      },
      {
        id: 'discord-roles-guest-links',
        title: 'Discord role mapping, role editor and guest links',
        summary: 'Discord server roles map to Raidsmith roles through a silent bot, officers edit roles in Raidsmith, and guest and public links are added.',
        area: 'discord', status: 'next', source: 'user', added: '2026-10-17',
      },
      {
        id: 'open-to-other-guilds',
        title: 'Open Raidsmith to other guilds',
        summary: 'Let other guilds create their own guild in Raidsmith. Today only people on an allowlist can create one.',
        area: 'guilds', status: 'next', source: 'user', added: '2026-10-17',
      },
      {
        id: 'move-to-cloudflare',
        title: 'Move to Cloudflare',
        summary: 'The live site moves to Cloudflare Workers once everything works on localhost. Old links redirect to the new address.',
        area: 'platform', status: 'next', source: 'user', added: '2026-10-17',
      },

      // ── Ideas ──
      {
        id: 'auto-refresh-signups',
        title: 'Refresh sign-ups automatically',
        summary: 'Sign-ups refresh when a page loads or on a schedule, instead of waiting for the Refresh button.',
        why: 'Today an officer has to press Refresh to see new sign-ups.',
        area: 'signups', status: 'idea', source: 'backlog', added: '2026-10-17',
      },
      {
        id: 'raid-zone-sets-planner-size',
        title: 'Raid zone sets the Planner\'s raid size',
        summary: 'The zone chosen for a raid sets the raid size in the Planner, so nobody has to switch it by hand.',
        area: 'planner', status: 'idea', source: 'backlog', added: '2026-10-17',
      },
      {
        id: 'event-move-updates-raid-date',
        title: 'Moving a raid\'s event to another day updates its date',
        summary: 'When the Raid-Helper event of a raid moves to another day, the raid\'s date follows it.',
        area: 'raids', status: 'idea', source: 'backlog', added: '2026-10-17',
      },
      {
        id: 'forever-team-sizes',
        title: 'WoW Forever 10, 20 and 40-player teams',
        summary: 'Teams in a WoW Forever guild can be 10, 20 or 40 players.',
        why: 'Teams are fixed at 25 players today.',
        area: 'guilds', status: 'idea', source: 'backlog', added: '2026-10-17',
      },
      {
        id: 'pre-raid-loot-board',
        title: 'Pre-raid loot board',
        summary: 'Before the raid, see the ThatsMyBIS prio and softres.it reserves for the raid\'s roster in one place. Paste a TMB or softres export to load them.',
        area: 'loot', status: 'idea', source: 'backlog', added: '2026-10-17',
      },
      {
        id: 'rank-progression',
        title: 'Rank progression',
        summary: 'An optional policy module that moves people up a ladder (for example Member, Raider, Core) based on their attendance.',
        area: 'attendance', status: 'idea', source: 'backlog', added: '2026-10-17',
      },
      {
        id: 'bolder-suggestion-stacks',
        title: 'Bolder suggestion stacks in the Planner',
        summary: 'The runner-up cards behind a suggested Open slot get easier to see.',
        why: 'They are faint today.',
        area: 'planner', status: 'idea', source: 'backlog', added: '2026-10-17',
      },

      // ── Shipped ──
      {
        id: 'future-raids-planner-link',
        title: 'Future raids and the Planner link',
        summary: 'Raids has Upcoming and Past tabs. Officers create or import a future raid from its Raid-Helper event, and the raid page and the Planner link to each other.',
        area: 'raids', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'open-slots-top-3-specs',
        title: 'Open slots suggest the top 3 specs',
        summary: 'An Open slot in the Planner shows the three best specs to fill it, as stacked cards.',
        area: 'planner', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'review-queue-new-person',
        title: 'Review queue: add as new person / make Main',
        summary: 'In the attendance review queue, an unmatched character can be added as a new person, or linked to a person and made their Main.',
        area: 'attendance', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'inactive-reason-left-on',
        title: 'Inactive reason and left-on date',
        summary: 'When a person goes Inactive, the roster records why they left and the day they left.',
        area: 'roster', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'attendance-phase-3',
        title: 'Attendance (Phase 3)',
        summary: 'Raids and attendance from Warcraft Logs and Raid-Helper sign-ups, with a review queue, a per-person history and an attendance policy per guild and team.',
        area: 'attendance', status: 'done', source: 'user', added: '2026-10-16', shipped: '2026-10-16',
      },
      {
        id: 'roster-phase-2',
        title: 'Roster (Phase 2)',
        summary: 'The guild roster: people, characters, specs, statuses, trials, officer notes and the Raid-Helper and Warcraft Logs imports.',
        area: 'roster', status: 'done', source: 'user', added: '2026-10-15', shipped: '2026-10-15',
      },
      {
        id: 'planner-in-app-shell',
        title: 'Planner inside the app shell',
        summary: 'The raid Planner opens inside the same app shell as the guild pages, with one sidebar and one top bar.',
        area: 'planner', status: 'done', source: 'user', added: '2026-10-15', shipped: '2026-10-15',
      },
      {
        id: 'discord-signin-roles-shell',
        title: 'Discord sign-in, roles and app shell (Phase 1)',
        summary: 'Sign in with Discord, create a guild, and give people the Guild Master, Officer, Team Lead and Member roles.',
        area: 'discord', status: 'done', source: 'user', added: '2026-10-14', shipped: '2026-10-14',
      },
    ],
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
