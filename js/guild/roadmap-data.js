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
    updated: '2026-10-18',
    items: [
      // ── In progress ──

      // ── Next up ──
      {
        id: 'raids-ux-refresh',
        title: 'Raids tab layout refresh',
        summary: 'Your idea: the boxes at the top of the Raids pages are uneven and take too much room, so their actions move into a compact header with an action menu, and the player lists get class colours and clearer columns. Mockup: claude.ai/artifact/Ro2RNXguBRMq3UXQMQ7NBx (A: source strip + Actions menu, B: tabs). Default A unless you pick B; built right after the sign-up lifecycle wave.',
        area: 'raids', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'open-to-other-guilds',
        title: 'Open Raidsmith to other guilds',
        summary: 'Any Discord server owner, Administrator or Manage Server holder can create a guild (the creator allowlist still overrides when set). New guilds get a six-step setup checklist on Home. Guild Masters can export the guild data (never other members\' private data) or delete the guild. Limits: 10 active teams, 5,000 characters, 5 guilds per account. A test walks every route to prove no guild can read or change another.',
        area: 'guilds', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-18',
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
        area: 'planner', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'forever-team-sizes',
        title: 'WoW Forever 10, 20 and 40-player teams',
        summary: 'Teams in a WoW Forever guild can be 10, 20 or 40 players.',
        why: 'Teams are fixed at 25 players today.',
        area: 'guilds', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'pre-raid-loot-board',
        title: 'Pre-raid loot board',
        summary: 'Before the raid, see the ThatsMyBIS prio and softres.it reserves for the raid\'s roster in one place. Paste a TMB or softres export to load them.',
        area: 'loot', status: 'idea', source: 'backlog', added: '2026-10-17',
      },
      {
        id: 'loot-without-gargul-export',
        title: 'Loot for items without a Gargul export',
        summary: 'Officers add a loot award by hand when there is no Gargul export for it: pick the raid, the item, the winner and the tag.',
        why: 'Loot only gets into Raidsmith through a Gargul export today, so a drop awarded outside Gargul is missing from the history and the balance.',
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
      {
        id: 'pending-claims-badge',
        title: 'Badge for pending character claims',
        summary: 'Officers see a badge on the Review queue in the navigation when members have character claims waiting.',
        why: 'Officers get no nav badge for claims today, so a claim waits until someone opens the Review queue.',
        area: 'battlenet', status: 'idea', source: 'backlog', added: '2026-10-17',
      },

      // ── Product Manager proposals (in the PM's priority order) ──
      {
        id: 'away-notices',
        title: 'Away and late notices',
        summary: 'Raiders post dates they are away, a recurring weekly day off, or \'late, arriving 8:30\' / \'leaving at 10\'. Officers see who is away, and attendance tags it \'with notice\' automatically.',
        why: 'Today an absence exists only as a per-raid sign-up, so planned weeks have gaps nobody sees. Inspired by: oxm.gg Absence Calendar; Raid-Helper Absence status.',
        area: 'signups', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'planner-away-warnings',
        title: 'Warn in the Planner about away and double-booked players',
        summary: 'When you open a raid in the Planner, anyone who is away or already in another overlapping raid gets a marker, and Optimize leaves them out unless you drag them in.',
        why: 'Stops officers building a plan around people who cannot come. Needs away notices. Inspired by: oxm.gg officer conflict view; Raidify conflicts toggle.',
        area: 'planner', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'roster-confirm',
        title: 'Publish the roster and ask raiders to confirm',
        summary: 'After the plan is done, officers press Publish. Raiders see their group and role on the raid page and press Confirm or Can\'t make it. Unconfirmed names stay highlighted.',
        why: 'Closes the loop between the plan and the raid itself. Inspired by: oxm.gg Accept/Decline and \'You\'re rostered\' notices.',
        area: 'raids', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'fair-bench',
        title: 'Fair bench suggestions in the Planner',
        summary: 'When more people sign up than there are seats, the Planner shows who sat out most recently and prefers them when the buff plan allows it, with the reason shown per seat.',
        why: 'Bench calls are the most argued decision in a 25-man, and Raidsmith already holds the bench history. Inspired by: oxm.gg Auto Split; Raidify Standby.',
        area: 'planner', status: 'idea', source: 'pm', added: '2026-10-17',
      },
      {
        id: 'recruitment-needs',
        title: 'Recruitment needs from the buff plan',
        summary: 'A roster page shows which buffs and roles the active roster covers and what is missing. One button copies a recruiting post listing the open classes.',
        why: 'Only a tool with buff rules can say what to recruit. Inspired by: CODEX sheet composition targets; GuildOS recruiting line; oxm.gg Launch HQ.',
        area: 'roster', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'class-intent-board',
        title: 'Class and spec intent board',
        summary: 'Members state the class, spec and role they plan to play for a date or new version. Officers see the totals against the buff plan.',
        why: 'WoW Forever launches 4 Nov 2026 with first raids 9 Dec; officers need this before then. Inspired by: oxm.gg Interest board.',
        area: 'roster', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'no-reply-reminders',
        title: 'Reminders to people who have not answered',
        summary: 'Before a raid, the Discord bot pings or DMs team members who have not signed up, at times officers set, with a per-person opt-out.',
        why: 'Free in Raid-Helper and expected by raiders. Inspired by: Raid-Helper; WoWAudit reminders; Sesh.',
        area: 'discord', status: 'idea', source: 'pm', added: '2026-10-17',
      },
      {
        id: 'applications-inbox',
        title: 'Applications inbox that ends in a Trial',
        summary: 'A public apply link with questions officers choose. Applications land in an inbox, and Accept creates a person with status Trial and trial dates.',
        why: 'Recruiting is the next officer chore after rosters and attendance. Inspired by: oxm.gg; Raidify; Guild Order; WoWAudit.',
        area: 'roster', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'csv-roster-import',
        title: 'Roster import from a TMB or spreadsheet CSV',
        summary: 'Upload a TMB characters export or a spreadsheet CSV to create people, Mains, Alts and teams in one go, with a preview and the usual link-or-add questions.',
        why: 'Lowest-friction onboarding for other guilds. Inspired by: Raidify ThatsMyBis importer; CODEX sheet.',
        area: 'roster', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'signup-deadline',
        title: 'Sign-up deadline with auto-lock',
        summary: 'A raid can close sign-ups automatically a set number of hours before the start, so the plan works from a stable list.',
        why: 'Phase 6 has manual lock and unlock only. Inspired by: oxm.gg sign-up deadlines; softres.it auto-lock.',
        area: 'signups', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'standby-volunteer',
        title: 'Volunteer standby',
        summary: 'A raider can mark \'happy to sit if someone needs the spot\'. Officers see them first when choosing the bench.',
        why: 'Lets raiders offer up a seat fairly. Inspired by: Raidify Standby.',
        area: 'signups', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'standing-signups',
        title: 'Standing sign-ups for weekly raids',
        summary: 'A raider says \'I am in every Tuesday and Thursday until I say otherwise\', and new raids from the schedule start with that sign-up.',
        why: 'Removes weekly clicking for the core group. Inspired by: Sesh Auto Join Next; Raid-Helper repeating events.',
        area: 'signups', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'discord-channel-posts',
        title: 'Post loot awards and rosters to a Discord channel',
        summary: 'Officers paste a channel webhook URL. Raidsmith posts the finished roster and loot awards to that channel.',
        why: 'Gets results where raiders already look; webhooks need no bot permissions. Inspired by: LootList+ award posts; oxm.gg announcements; Raidify.',
        area: 'discord', status: 'idea', source: 'pm', added: '2026-10-17',
      },
      {
        id: 'team-progress-board',
        title: 'Team progress board',
        summary: 'Per team and phase: which bosses are dead, first-kill dates, wipes before kill and clear time per night.',
        why: 'Shows progress to the guild and recruits from data already fetched (check Warcraft Logs terms first). Inspired by: WowUtils clear speed; oxm.gg progress; GuildOS.',
        area: 'raids', status: 'idea', source: 'pm', added: '2026-10-17',
      },
      {
        id: 'api-keys-csv-exports',
        title: 'Read-only API keys and CSV links',
        summary: 'Officers create read-only keys or CSV links for attendance, roster and loot so Google Sheets and bots can read live data.',
        why: 'Guilds keep spreadsheets; this lets them keep their reports. Inspired by: Raidify API keys; WoWAudit API; TMB CSV exports.',
        area: 'platform', status: 'idea', source: 'pm', added: '2026-10-17',
      },

      {
        id: 'passkey-email-signin',
        title: 'Passkey or email sign-in',
        summary: 'Sign in to Raidsmith with a passkey or an emailed link, as another way into the same account next to Discord and Battle.net.',
        why: 'Accounts hold Discord and Battle.net today; there is no password or email service yet.',
        area: 'platform', status: 'idea', source: 'backlog', added: '2026-10-17',
      },

      {
        id: 'standby-stronger',
        title: 'Standby players benched first',
        summary: 'The Planner holds volunteer standby players out of its first pass, but its value trade can still seat one. Make standby a stronger preference so they sit before anyone who did not volunteer.',
        area: 'planner', status: 'idea', source: 'backlog', added: '2026-10-18',
      },
      {
        id: 'version-default-team-size',
        title: 'Team size follows the game version',
        summary: 'New teams start at 25 players. A WoW Forever guild would start at its common raid size instead, and Classic at 40.',
        area: 'raids', status: 'done', source: 'backlog', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'date-only-deadline',
        title: 'Sign-up deadline for raids without a start time',
        summary: 'A raid created with only a date closes sign-ups at 12:00 UTC. Ask for a start time or use the team schedule time instead.',
        area: 'signups', status: 'idea', source: 'backlog', added: '2026-10-18',
      },
      {
        id: 'away-cap-ended',
        title: 'Ended away notices stop counting toward the limit',
        summary: 'A person can keep 30 away notices; ended ones still count. Only current and future notices should.',
        area: 'signups', status: 'idea', source: 'backlog', added: '2026-10-18',
      },
      {
        id: 'roster-confirm-reminder',
        title: 'Remind raiders who have not confirmed their seat',
        summary: 'After a roster is published, unconfirmed raiders get a reminder (Discord bot or on their next visit) before the raid.',
        area: 'raids', status: 'idea', source: 'backlog', added: '2026-10-18',
      },
      // ── Shipped ──
      {
        id: 'activity-log-page',
        title: 'Activity log page',
        summary: 'Guild settings > Activity lists who changed what and when, newest first, with filters for the kind of change, the person and a date range, a plain sentence for each change and a Details toggle with the before and after. Download CSV exports up to 5,000 rows of the filtered list. Only the Guild Master can open it, and officer notes are never shown.',
        area: 'platform', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'attendance-watch-list',
        title: 'Attendance watch list',
        summary: 'The team attendance page has a Watch list card above the grid: people whose rolling attendance is below a line officers set (75% by default) or fell by 15 points or more against the previous window of the same length, with their missed and missed-with-notice counts. Both lines are set per guild or team in Attendance settings, and either can be turned off.',
        area: 'attendance', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'needs-attention-home',
        title: '\'Needs attention\' home for officers',
        summary: 'Officers and team leads land on a Home page that lists open work in one place: raids to review, unmatched loot winners and sign-ups, character claims, trials ending within 7 days, people on the watch list, raids with no loot import, upcoming raids with fewer sign-ups than the team\'s raid size, and sign-ups still open an hour before the start. A badge on Home counts it; members still open on Roster.',
        area: 'platform', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'trial-review',
        title: 'Trial review card',
        summary: 'A trial\'s person page shows a Trial review card: attendance since the trial started (raids, percent, missed, missed with notice, late and left early), loot received, fill-ins and an excerpt of the officer notes, with Promote to Raider, Extend trial (14 days by default) and End trial buttons.',
        area: 'roster', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'calendar-feed',
        title: 'Calendar feed for raids',
        summary: 'Raids has Subscribe in your calendar: a private link per person and team that adds the team\'s raids (30 days back, 60 ahead) to Google, Apple or Outlook Calendar, with the sign-up counts and your own sign-up in each event. The link is shown once, can be replaced or turned off, stops working when you leave the guild or lose access, and is deleted with your data.',
        area: 'raids', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'discord-roles-guest-links',
        title: 'Discord role mapping, role editor, guest links and the public page',
        summary: 'Officers add a silent Raidsmith bot (it asks for no permissions) and map Discord roles to Officer, Team Lead of a team or their own roles; the mapping applies at every sign-in and with Sync now, and a role set by hand always wins. The Guild Master edits roles, officers make revocable read-only guest links, and a public page (off by default) can show roster, raids, attendance and loot, never notes or Discord names.',
        why: 'Roles should follow Discord without trusting it blindly, and people without an account should be able to look.',
        area: 'discord', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'event-move-updates-raid-date',
        title: 'Moving a raid\'s event to another day updates its date',
        summary: 'When you link, replace or refresh the Raid-Helper event of a raid that has no log, and the event is on another day than the raid, Raidsmith asks "Move the raid to that day?" first. Move raid sets both the date and the start time; Cancel changes nothing. A day the team already has a raid on is refused, and a raid with a log keeps its date.',
        area: 'raids', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'native-signups',
        title: 'Native Raidsmith sign-ups',
        summary: 'Raiders sign up for upcoming raids in Raidsmith as signed, late, tentative or can\'t come, with their character, spec and a note, until the raid starts or an officer closes sign-ups. Officers edit any sign-up. A weekly schedule per team creates the upcoming raids. A sign-up here replaces the person\'s Raid-Helper one, so nobody is counted twice.',
        area: 'signups', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'platform-accounts',
        title: 'Raidsmith accounts with linked sign-ins',
        summary: 'Sign in or sign up with Discord or Battle.net, connect the other on Linked accounts, and pick the name your account shows. A member is someone in the guild\'s Discord server or whose account an officer linked to a roster person, so Battle.net-only people can use a guild. Decisions (open to change): accounts are never merged, the last sign-in cannot be disconnected, and only the Battle.net character list follows the 30-day rule.',
        why: 'Not everyone has Discord, and a sign-in should not decide who you are in the guild.',
        area: 'platform', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'battlenet-link-roster-import',
        title: 'Battle.net character link and guild roster import',
        summary: 'Members link Battle.net from the avatar menu, see their characters per guild and claim the ones that are theirs. Officers approve claims in the Review queue and can import the guild roster from Battle.net after a preview. Data follows the 30-day rule and Disconnect deletes it at once. WoW Forever has no Battle.net character data yet; it turns on when Blizzard publishes a namespace.',
        area: 'battlenet', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
      {
        id: 'loot-history',
        title: 'Loot history (Phase 4)',
        summary: 'Import the Gargul Detailed JSON export for each raid, disenchanted items included, then see loot per player, per raid and per item, plus a loot balance (main-spec items per raid attended). Officers tag each drop (MS, OS, DE or Bank), and Loot settings choose who sees loot and how the balance counts.',
        area: 'loot', status: 'done', source: 'user', added: '2026-10-17', shipped: '2026-10-17',
      },
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
