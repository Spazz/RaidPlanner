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
    updated: '2026-10-19',
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
        area: 'signups', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
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
        area: 'loot', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'loot-without-gargul-export',
        title: 'Loot for items without a Gargul export',
        summary: 'Officers add a loot award by hand when there is no Gargul export for it: pick the raid, the item, the winner and the tag.',
        why: 'Loot only gets into Raidsmith through a Gargul export today, so a drop awarded outside Gargul is missing from the history and the balance.',
        area: 'loot', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'rank-progression',
        title: 'Rank progression',
        summary: 'An optional policy module that moves people up a ladder (for example Member, Raider, Core) based on their attendance.',
        area: 'attendance', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'bolder-suggestion-stacks',
        title: 'Bolder suggestion stacks in the Planner',
        summary: 'The runner-up cards behind a suggested Open slot get easier to see.',
        why: 'They are faint today.',
        area: 'planner', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'pending-claims-badge',
        title: 'Badge for pending character claims',
        summary: 'Officers see a badge on the Review queue in the navigation when members have character claims waiting.',
        why: 'Officers get no nav badge for claims today, so a claim waits until someone opens the Review queue.',
        area: 'battlenet', status: 'done', source: 'backlog', added: '2026-10-17', shipped: '2026-10-18',
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
        area: 'planner', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
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
        area: 'discord', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
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
        area: 'discord', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'team-progress-board',
        title: 'Team progress board',
        summary: 'Per team and phase: which bosses are dead, first-kill dates, wipes before kill and clear time per night.',
        why: 'Shows progress to the guild and recruits from data already fetched (check Warcraft Logs terms first). Inspired by: WowUtils clear speed; oxm.gg progress; GuildOS.',
        area: 'raids', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
      },
      {
        id: 'api-keys-csv-exports',
        title: 'Read-only API keys and CSV links',
        summary: 'Officers create read-only keys or CSV links for attendance, roster and loot so Google Sheets and bots can read live data.',
        why: 'Guilds keep spreadsheets; this lets them keep their reports. Inspired by: Raidify API keys; WoWAudit API; TMB CSV exports.',
        area: 'platform', status: 'done', source: 'pm', added: '2026-10-17', shipped: '2026-10-18',
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
        area: 'planner', status: 'done', source: 'backlog', added: '2026-10-18', shipped: '2026-10-18',
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
        area: 'signups', status: 'done', source: 'backlog', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'away-cap-ended',
        title: 'Ended away notices stop counting toward the limit',
        summary: 'A person can keep 30 away notices; ended ones still count. Only current and future notices should.',
        area: 'signups', status: 'done', source: 'backlog', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'roster-confirm-reminder',
        title: 'Remind raiders who have not confirmed their seat',
        summary: 'After a roster is published, unconfirmed raiders get a reminder (Discord bot or on their next visit) before the raid.',
        area: 'raids', status: 'done', source: 'backlog', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'webhook-test-post',
        title: 'Send a test post to a Discord webhook',
        summary: 'A button on Guild settings > Notifications that posts a short test message, so officers know the webhook works before the first real post.',
        area: 'discord', status: 'done', source: 'backlog', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'discord-dm-reminders',
        title: 'Reminders by Discord direct message',
        summary: 'Send sign-up and roster reminders as direct messages instead of a channel post. Works through the existing Raidsmith bot token over Discord REST (no always-on bot connection needed); members must share a server with the bot.',
        area: 'discord', status: 'idea', source: 'backlog', added: '2026-10-18',
      },
      {
        id: 'forever-two-part-names',
        title: 'Forever two-part character names',
        summary: 'WoW Forever characters have a first name and a surname. Raidsmith accepts, matches and shows both parts wherever a name is typed, imported or compared.',
        why: 'Blizzard says every Forever character has two names, and the roster name check takes one word of 2 to 12 letters, so Forever imports and sign-ups could be refused or mismatched before Dec 9. Inspired by: Blizzard naming article; Guild Order Forever recruiting wiki.',
        area: 'roster', status: 'done', source: 'pm', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'raid-duties-log-nudge',
        title: 'Raid-night duties and a missing-log nudge',
        summary: 'Each raid names who leads, who records loot and who uploads the log, and these can rotate. If a raid ends with no log and no manual attendance, the duty holder and officers see it on Home.',
        why: 'Attendance, the review queue and loot all start from a log or an export, so one forgotten upload stalls the whole night. Inspired by: Guild Order raid leading guide; Guild Order Forever launch checklist.',
        area: 'raids', status: 'done', source: 'pm', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'multi-version-discord-server',
        title: 'Run TBC and Forever from one Discord server',
        summary: 'One Discord server can host more than one guild, one per game version or ruleset. A new guild can copy people, ranks and settings from an existing one, never the history.',
        why: 'Today each Discord server gets exactly one guild and each guild one game version, so a community that keeps its TBC guild and starts a Forever team cannot do both. Inspired by: Guild Order Forever launch checklist (move, split or stay).',
        area: 'guilds', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'launch-readiness-funnel',
        title: 'Launch readiness funnel for a new version',
        summary: 'Members mark where they are: name reserved, leveling, level 60, geared, raid ready, plus the nights they can raid. Officers see counts per class and role, week over week, against the team\'s raid size.',
        why: 'Hype overstates real commitment by about double, and the class intent board shows what people plan to play, not how many will be there on Dec 9. Inspired by: Guild Order Forever launch officer checklist.',
        area: 'roster', status: 'done', source: 'pm', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'guest-signup-link',
        title: 'Guest sign-up link for fill-ins and allied guilds',
        summary: 'Officers share a link for one raid. Anyone can sign up with character name, class and spec, and officers approve them into the Planner as guests that never join the roster.',
        why: 'Forever opens with a 40-player Onyxia while small guilds compete for the same players, and today pugs are added by hand in the Planner. Inspired by: Raidify pug raids; oxm.gg PUG browser; Guild Order Forever recruiting wiki.',
        area: 'signups', status: 'done', source: 'pm', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'availability-grid',
        title: 'Raid-night availability grid',
        summary: 'Members tick the evenings and hours they can raid on a weekly grid. Officers see the overlap per evening and use it to pick raid days.',
        why: 'A new Forever team has to choose nights before anyone has signed up for a raid, and away notices only cover exceptions. Inspired by: Guild Order Forever launch checklist; Blizzard forum recruiting posts that poll raid schedules.',
        area: 'signups', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'boss-assignment-board',
        title: 'Boss assignment board',
        summary: 'Per boss, officers fill named jobs (main tank, off tank, kick order, crowd control, cube clickers, decurse, healer-to-tank) from the seated roster, with class-aware suggestions. Raiders see their own job on the raid page, and officers copy the sheet as text for Discord or an MRT note.',
        why: 'At least seven TBC Anniversary addons exist for this, and under Forever\'s reported limits a static note stays allowed while addons that instruct players do not. Inspired by: MooRaid; NKAssign; RaidHelper_TBC; oxm.gg boss assignment sheets; Mk. Ultra sheet.',
        area: 'planner', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'discord-signup-buttons',
        title: 'Sign-up buttons on the Discord raid post',
        summary: 'The raid post in Discord has Sign up, Tentative and Can\'t buttons that write Raidsmith sign-ups, plus /raids and /signup commands, so raiders do not have to open the site.',
        why: 'Raid-Helper\'s draw is signing up inside Discord, and Discord can deliver button clicks to a web address, so no always-on bot connection is needed. Inspired by: Raid-Helper; Raidify /signup command; Discord interactions documentation.',
        area: 'discord', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'no-log-attendance-paste',
        title: 'Attendance from a pasted raid roster',
        summary: 'For a raid with no Warcraft Logs report, paste the in-game raid roster at the start and at the end. Raidsmith matches the names, marks late and left early, and fills the manual attendance.',
        why: 'Forever log support is unconfirmed, and the fallback Guild Order suggests is one officer marking the roster at pull and at the last boss. Inspired by: Guild Order Forever addon compatibility guide.',
        area: 'attendance', status: 'done', source: 'pm', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'loot-award-reasons',
        title: 'Reason line on loot awards',
        summary: 'When an officer or the council awards an item they can add one line of reason. Members see it in their loot history.',
        why: 'Perceived favoritism is the top source of loot drama, and Raidsmith keeps the log of who got what but not why. Inspired by: Guild Order loot systems wiki; RCLootCouncil Council Rotation plugin.',
        area: 'loot', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'raid-briefing',
        title: 'Raid briefing with consumables and strategy links',
        summary: 'Each team keeps a briefing template: flask, food and potion list, boss and video links, required addons, meet-up and summon notes. It shows on the raid page and goes out with the Discord post.',
        why: 'The manual fallback for consumable checks in Forever is to publish the expected list, and Raidsmith has no place for one. Inspired by: Guild Order Forever addon compatibility guide; consumable checker addons.',
        area: 'raids', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'attunement-tracker',
        title: 'Attunement and key tracker',
        summary: 'Raiders tick the attunements and keys they have and officers confirm. The Planner warns about unattuned players for raids that need one.',
        why: 'Addon trackers need installs and online players, and Battle.net attunement data is unconfirmed. Inspired by: TarotClub; FOCUS; Guild OS; Guild Heroics; Mk. Ultra sheet.',
        area: 'roster', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'raid-postmortem-notes',
        title: 'Raid post-mortem notes that carry forward',
        summary: 'After a raid, officers record what failed and what to change. The next raid in the same zone shows those notes at the top.',
        why: 'Reviewing which assignments failed each week is how the same mistakes stop repeating. Inspired by: Guild Order raid leading guide; Guild Order social calendar guide.',
        area: 'raids', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'guild-rules-page',
        title: 'Guild rules and loot policy page',
        summary: 'One page holds raid rules, loot rules and rank structure. Members acknowledge each version, and officers see who has not.',
        why: 'A new guild should start from a written document, and loot drama grows when rules are applied at the leader\'s whim. Inspired by: Guild Order Forever launch checklist; Engadget Officers\' Quarters columns.',
        area: 'guilds', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'loot-import-formats',
        title: 'More loot import formats',
        summary: 'Import loot from an RCLootCouncil CSV or a plain pasted list (player, item, date) as well as the Gargul export.',
        why: 'Raidsmith loads Gargul JSON only, and officers still need a way in if Gargul or other loot addons do not load in Forever. Inspired by: oxm.gg loot imports; Guild Order Forever addon compatibility table.',
        area: 'loot', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'guild-health-trends',
        title: 'Guild health trends',
        summary: 'A page shows trial conversion, who left and why, how long people stay, sign-up response rate and roster size against raid size, week by week.',
        why: 'The data is already recorded, and quiet departures and pre-launch attendance dips are the launch risks officers name. Inspired by: Guild Order Forever launch checklist; CODEX guild sheet dashboard.',
        area: 'roster', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'pwa-push-notifications',
        title: 'Install as an app and push alerts',
        summary: 'Raidsmith installs as a phone app and can send push alerts for reminders, roster publishes and plan changes, without a Discord DM.',
        why: 'Discord says DMs should follow a user action and bulk DM opening gets rate-limited, so push is a second reminder channel that does not depend on it. Inspired by: Guild Order phone push notifications; Discord create-DM guidance.',
        area: 'platform', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'seed-roster-from-discord-role',
        title: 'Seed the roster from a Discord role',
        summary: 'Pick a Discord role (for example Raider) and create a person for everyone who has it. Members then claim their characters on first sign-in.',
        why: 'It is the cheapest way to start a roster before any spreadsheet or CSV exists. Inspired by: Raidify Move in claim flow.',
        area: 'roster', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'guild-polls',
        title: 'Quick polls for guild decisions',
        summary: 'Officers ask members a question with a few options and a closing time (raid days, move or split, faction), with named or anonymous answers.',
        why: 'The move, split or stay decision should be recorded early, and some guilds poll every major decision. Inspired by: Raid-Helper polls; Guild Order Forever launch checklist.',
        area: 'other', status: 'idea', source: 'pm', added: '2026-10-18',
      },
      {
        id: 'prep-check-from-logs',
        title: 'Flask and food check from logs',
        summary: 'From the same Warcraft Logs report used for attendance, show who had flask, food and potions on the first pull, as a prep column next to attendance. Needs the Warcraft Logs terms read before any build.',
        why: 'In-game consumable checkers depend on other players\' buffs, which Forever\'s addon limits may block, so the log side is the fallback. Inspired by: RaidTracker Buff Monitor; Consumables Checker; Guild Order Forever addon compatibility guide.',
        area: 'raids', status: 'idea', source: 'pm', added: '2026-10-18',
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
        id: 'officer-home-week',
        title: 'Officer Home: the raid week',
        summary: 'Officer Home shows the raid week: a 7-day strip with one status per raid, the selected raid\'s sign-ups and line-up in one sentence, and its to-dos; guild to-dos sit beside it. A phone leads with the next raid. To-dos can be hidden for all officers or snoozed, with Undo and a Hidden list. The watch list moved to Attendance with Reviewed: a person comes back after a further 5-point drop or a missed raid.',
        area: 'platform', status: 'done', source: 'user', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'officer-home-raid-art-roles',
        title: 'Officer Home: raid art, sign-ups by role, reset week',
        summary: 'Each raid on officer Home shows its raid art with the initials on top, and the selected raid lists who signed up by role (Tanks, Healers, Melee, Ranged) with confirmed, no answer, late and Can\'t come marks and the open seats. The week follows the guild\'s raid reset, with Previous and Next, and moves to next week by itself when this week has no raid left.',
        area: 'platform', status: 'done', source: 'user', added: '2026-10-18', shipped: '2026-10-18',
      },
      {
        id: 'roster-redesign',
        title: 'Roster redesign: team sheet, record page, Recruiting',
        summary: 'The Roster opens on the team\'s shape: role tiles against the targets, who needs a decision, and Tank, Healer, Melee and Ranged columns with spec icons; phones get a searchable list. A person\'s page leads with the trial decision and shows one Account line. Applications, recruiting needs and the post share one Recruiting tab; Launch readiness sits on Spec poll. Each team sets its trial length (14 days by default).',
        area: 'roster', status: 'done', source: 'user', added: '2026-10-19', shipped: '2026-10-19',
      },
      {
        id: 'discord-optional',
        title: 'Run a guild without Discord',
        summary: 'A guild can use Raidsmith on its own, with no Discord server: create the guild, invite and sign in members, plan and track raids. Connecting Discord stays optional and unlocks the extras: sign-ups in Discord, reminders and DMs, channel posts and role sync.',
        area: 'platform', status: 'next', source: 'user', added: '2026-10-18',
      },
      {
        id: 'trial-review',
        title: 'Trial review card',
        summary: 'A trial\'s person page shows a Trial review card: attendance since the trial started (raids, percent, missed, missed with notice, late and left early), loot received, fill-ins and an excerpt of the officer notes, with Promote to Raider, Extend trial (the team\'s trial length by default) and End trial buttons.',
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
