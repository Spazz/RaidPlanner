// ── APP SHELL ───────────────────────────────────────────────────
// Guild rail, labelled sidebar (collapsible to an icon rail), top bar pieces, avatar menu, phone tabs and the phone
// drawer. Pure string builders: slots(ctx) returns the HTML for each slot of the page skeleton (#shell-rail,
// #shell-sidebar, #shell-topbar-lead, #shell-topbar-account, #shell-banner, #shell-tabs, #shell-drawer); app.js writes
// them into the page and wires the events. The planner and the static help pages draw the same shell.
//   ctx = { section, page, me, pending, signedOut, route, guildData, teamId, collapsed, whatsNewUnseen, personName, attentionCount }
//   attentionCount: the open-work count of the Home page (GET /attention total) for the guild in play; 0 until it is known.
//   section: 'guild' (default) | 'planner' | 'page' (faq / whats-new); page: 'app' | 'faq' | 'whats-new'
//   me: the /auth/me response (null = signed out); guildData: GET /api/guild/:gid (or null when no guild is in play).
(function (G) {
  'use strict';

  const ic = function (name, size) { return G.icons.icon(name, size); };

  const PAGE_NAMES = { faq: 'FAQ', 'whats-new': 'What\'s new' };

  // `can` maps an action to "guild" or a list of team IDs; an absent action (or an empty list) is not allowed.
  function hasAction(can, action) {
    if (!can || !Object.prototype.hasOwnProperty.call(can, action)) return false;
    const v = can[action];
    return v === 'guild' || (Array.isArray(v) && v.length > 0);
  }

  function canSeeSettings(can) {
    return hasAction(can, 'guild.teams') || hasAction(can, 'guild.access') || hasAction(can, 'guild.roles') || hasAction(can, 'attendance.policy') || hasAction(can, 'loot.policy') || hasAction(can, 'audit.view');
  }

  // Who sees Users in the nav and may open the page: the holders of guild.access (what the Users writes need; GET /users also lets guild.roles read it).
  function canSeeUsers(can) {
    return hasAction(can, 'guild.access');
  }

  // Who gets the officer Home (the needs-attention list): anyone who can act on one of its items. Everyone else gets the member Home (their next raid, attendance, loot).
  function canSeeAttention(can) {
    return hasAction(can, 'attendance.review') || hasAction(can, 'roster.edit') || hasAction(can, 'raids.edit') || hasAction(can, 'loot.edit');
  }

  // Whether `can` reaches this team for an action ('guild' = every team, or a list of team ids).
  function allowsTeam(can, action, teamId) {
    if (!can || !Object.prototype.hasOwnProperty.call(can, action)) return false;
    const v = can[action];
    return v === 'guild' || (Array.isArray(v) && !!teamId && v.indexOf(teamId) >= 0);
  }

  // The Guild settings pages, in the order of the five groups the list shows (design framework T3). A viewer sees a page when they hold ANY of its `needs`
  // actions (Accounts needs access or roles; Raid schedule is for whoever edits raids, and a Team Lead reaches it from the Raids page: canSeeSettings below,
  // and so the sidebar item, is unchanged). Every page here is a route tab in router.js and every action a Worker action: guild-structure-tests.js checks both.
  // `tab` is the address (#/g/:gid/settings/<tab>) and never changes with a label: 'people' is the page called Accounts. `purpose` is the one line under the
  // page's heading. General is the Guild Master's to edit (the Worker says 403 to anyone else); an officer who reaches Guild settings reads it.
  // Two pages are shown by something other than an action: `guildMasterOnly` (Guild data: the role) and `ownerReviewOnly` (Owner review: only the Owner, only while GET /api/guild/:gid
  // says owner.reviewOpen; settingsTabs' third argument is that `owner` block).
  const SETTINGS_GROUPS = ['Guild', 'People and access', 'Sharing', 'Raid rules', 'Connections and data'];
  const SETTINGS_TABS = [
    { tab: 'general', label: 'General', group: 'Guild', needs: ['guild.teams'], isNew: true,
      purpose: 'Your guild\'s name, realm and time zone. Raid times everywhere read in this zone.' },
    { tab: 'claimreview', label: 'Owner review', group: 'Guild', needs: [], ownerReviewOnly: true, isNew: true,
      purpose: 'What the previous Owner set up and left live.' },
    { tab: 'teams', label: 'Teams', group: 'Guild', needs: ['guild.teams'],
      purpose: 'The raid teams of the guild. Each character is locked to one team.' },
    { tab: 'schedule', label: 'Raid schedule', group: 'Guild', needs: ['raids.edit'],
      purpose: 'The days each team raids every week, and when sign-ups close.' },
    { tab: 'people', label: 'Accounts', group: 'People and access', needs: ['guild.access', 'guild.roles'],
      purpose: 'The accounts that have signed in to this guild, and the roles they hold.' },
    { tab: 'roles', label: 'Roles', group: 'People and access', needs: ['guild.roles'],
      purpose: 'What each role may see and do. Add your own roles, or reset a built-in one.' },
    { tab: 'discord', label: 'Discord roles', group: 'People and access', needs: ['guild.roles'],
      purpose: 'Which Raidsmith role each role of your Discord server gives.' },
    { tab: 'links', label: 'Links and keys', group: 'Sharing', needs: ['guild.access'], isNew: true,
      purpose: 'Every link and key that opens your guild\'s data without a sign-in, and who made it.' },
    { tab: 'public', label: 'Public page', group: 'Sharing', needs: ['guild.roles'],
      purpose: 'A page anyone with the address can read, and what it shows.' },
    { tab: 'attendance', label: 'Attendance', group: 'Raid rules', needs: ['attendance.policy'],
      purpose: 'What counts as attended, how late and bench are treated, and when someone is on the watch list.' },
    { tab: 'loot', label: 'Loot', group: 'Raid rules', needs: ['loot.policy'],
      purpose: 'Who sees loot and how the balance counts.' },
    { tab: 'notifications', label: 'Notifications', group: 'Raid rules', needs: ['guild.teams'],
      purpose: 'What Raidsmith posts to each team\'s Discord channel.' },
    { tab: 'applications', label: 'Applications', group: 'Raid rules', needs: ['guild.teams'],
      purpose: 'Whether people can apply to the guild, and the questions they answer.' },
    { tab: 'battlenet', label: 'Battle.net', group: 'Connections and data', needs: ['guild.teams'],
      purpose: 'What the Battle.net guild roster import needs to know about the guild.' },
    { tab: 'activity', label: 'Activity', group: 'Connections and data', needs: ['audit.view'],
      purpose: 'What people changed in this guild, newest first.' },
    // Export and delete: the Guild Master's alone (not an action a role can be given), so it is shown by role, not by `needs`.
    { tab: 'data', label: 'Guild data', group: 'Connections and data', needs: [], guildMasterOnly: true,
      purpose: 'Download a copy of the guild, or delete it.' },
  ];

  function isGuildMaster(roles) { return Array.isArray(roles) && roles.some(function (r) { return r && r.role === 'guild_master'; }); }

  // roles: the viewer's roles in this guild (guildData.me.roles); the Guild Master's tabs need it. owner: the guild payload's `owner` block (the Owner review tab needs owner.reviewOpen).
  function settingsTabs(can, roles, owner) {
    const master = isGuildMaster(roles);
    const reviewing = !!owner && owner.reviewOpen === true;
    return SETTINGS_TABS
      .filter(function (def) {
        if (def.guildMasterOnly) return master;
        if (def.ownerReviewOnly) return reviewing;
        return def.needs.some(function (action) { return hasAction(can, action); });
      })
      .map(function (def) { return { tab: def.tab, label: def.label, group: def.group, purpose: def.purpose, isNew: !!def.isNew }; });
  }

  // The same pages as the five groups of the list (a group with no page for this viewer is left out): [{ label, items: [{ tab, label, purpose, isNew }] }].
  function settingsGroups(can, roles, owner) {
    const tabs = settingsTabs(can, roles, owner);
    return SETTINGS_GROUPS.map(function (label) {
      return { label: label, items: tabs.filter(function (t) { return t.group === label; }) };
    }).filter(function (g) { return g.items.length > 0; });
  }

  function activeTeams(teams) {
    return (Array.isArray(teams) ? teams : []).filter(function (t) { return t && !t.archived; });
  }

  // base: '' on index.html (hash links stay #/...), '/' on the static pages (every shell link is absolute).
  function guildHref(gid, section, base) { return (base || '') + G.router.format({ name: 'section', gid: gid, section: section }); }

  function sectionOf(ctx) { return ctx && ctx.section ? ctx.section : 'guild'; }
  function baseOf(ctx) { return ctx && ctx.page && ctx.page !== 'app' ? '/' : ''; }
  function signedIn(ctx) { return !!(ctx && ctx.me && ctx.me.user); }
  function guildOf(ctx) { return ctx && ctx.guildData && ctx.guildData.guild ? ctx.guildData : null; }
  // A guest link, the guest view and a public page are standalone read-only pages: no guild rail, whoever is looking.
  function viewerPage(ctx) { return !!(ctx && G.router.isViewerRoute(ctx.route)); }

  // One flag count of a team out of a { teamId: n } map (rosterFlags, teamRequestFlags): a whole number, 0 when there is none.
  function flagOf(map, teamId) {
    const n = map && Object.prototype.hasOwnProperty.call(map, teamId) ? Number(map[teamId]) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // The Roster's two kinds of work for the selected team, for officers and team leads only (a member's guild payload carries none): trials to decide
  // (gd.rosterFlags) and team requests waiting (gd.teamRequestFlags).
  function rosterWork(gd, teamId) {
    if (!gd || !teamId || !hasAction(gd.me && gd.me.can, 'roster.edit')) return { trials: 0, requests: 0 };
    return { trials: flagOf(gd.rosterFlags, teamId), requests: flagOf(gd.teamRequestFlags, teamId) };
  }

  // The Roster badge is ONE number: the trials to decide and the team requests waiting (user 2026-10-26, decision 5).
  function rosterBadge(gd, teamId) {
    const w = rosterWork(gd, teamId);
    return w.trials + w.requests;
  }

  // Open attendance flags for the selected team (the same count the Review queue's header and the Attendance page's Review queue link show), for people
  // who can review them (a member's payload carries none).
  function attendanceBadge(gd, teamId) {
    if (!gd || !teamId || !hasAction(gd.me && gd.me.can, 'attendance.review')) return 0;
    const n = gd.attendanceFlags && Object.prototype.hasOwnProperty.call(gd.attendanceFlags, teamId) ? Number(gd.attendanceFlags[teamId]) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // Pending character claims ("This is me" asks) are counted on Home only (user 2026-10-26, board 9b): they are Home to-dos with Approve / Reject, and the Review
  // queue under Attendance still lists them, but the Attendance badge is the flags to review and nothing else.
  function badgesOf(gd, teamId) {
    const w = rosterWork(gd, teamId);
    return { roster: w.trials + w.requests, trials: w.trials, requests: w.requests, attendance: attendanceBadge(gd, teamId) };
  }

  // The Home count: open work across the viewer's teams (ctx.attentionCount, set from GET /attention), for attention viewers only.
  function homeBadge(ctx) {
    const gd = guildOf(ctx);
    if (!gd || !canSeeAttention(gd.me && gd.me.can)) return 0;
    const n = Number(ctx.attentionCount);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function homeItem(gid, count, base) {
    return { key: 'home', label: 'Home', short: 'Home', icon: 'home', href: guildHref(gid, 'home', base), badge: count,
      ariaLabel: count ? 'Home, ' + count + (count === 1 ? ' item needs' : ' items need') + ' attention' : 'Home' };
  }

  // A section head: a presentational list entry (never focusable); the collapsed sidebar draws it as a divider.
  function navHead(key, label) {
    return { key: 'head-' + key, head: true, label: label };
  }

  // The guild's Planner item: opens the plan of the current team's next upcoming raid (the 'open-team-planner' action), else the Raids list.
  function teamPlannerItem(gid, base) {
    return { key: 'planner', label: 'Planner', short: 'Planner', icon: 'planner', href: guildHref(gid, 'raids', base), action: 'open-team-planner' };
  }

  function plannerItem() {
    return { key: 'planner', label: 'Planner', short: 'Planner', icon: 'planner', href: '/', action: 'open-planner' };
  }

  // The Attendance item's label for a screen reader: the flags to review.
  function attendanceLabel(flags) {
    return flags ? 'Attendance, ' + flags + (flags === 1 ? ' flag' : ' flags') + ' to review' : 'Attendance';
  }

  // The Roster item's label for a screen reader: what the one number is made of ("2 trials and 1 team request to decide"). A bare total (no split) is trials.
  function rosterLabel(total, trials, requests) {
    if (!total) return 'Roster';
    const parts = [];
    if (!trials && !requests) parts.push(total + (total === 1 ? ' trial' : ' trials'));
    if (trials) parts.push(trials + (trials === 1 ? ' trial' : ' trials'));
    if (requests) parts.push(requests + (requests === 1 ? ' team request' : ' team requests'));
    return 'Roster, ' + parts.join(' and ') + ' to decide';
  }

  // badges: { roster, trials, requests, attendance } counts (a bare number is the Roster count; 0 = none). Roster is the trials to decide and the team requests
  // waiting as one number; Attendance is its flags to review. base: see guildHref.
  function navItems(gid, can, badges, base) {
    const bs = typeof badges === 'number' ? { roster: badges } : (badges || {});
    const n = bs.roster > 0 ? bs.roster : 0;
    const a = bs.attendance > 0 ? bs.attendance : 0;
    const b = base || '';
    const top = [
      { key: 'raids', label: 'Raids', short: 'Raids', icon: 'raids', href: guildHref(gid, 'raids', b) },
      { key: 'loot', label: 'Loot', short: 'Loot', icon: 'loot', href: guildHref(gid, 'loot', b) },
      { key: 'roster', label: 'Roster', short: 'Roster', icon: 'roster', href: guildHref(gid, 'roster', b), badge: n,
        ariaLabel: rosterLabel(n, bs.trials > 0 ? bs.trials : 0, bs.requests > 0 ? bs.requests : 0) },
      { key: 'attendance', label: 'Attendance', short: 'Attendance', icon: 'attendance', href: guildHref(gid, 'attendance', b), badge: a,
        ariaLabel: attendanceLabel(a) },
    ];
    // Team tools: the Planner, for those who hold raids.edit for at least one team. Guild admin: Users, then Guild settings. The bare settings address lets the app
    // open the first page on a wide screen and the list of pages on a phone.
    const teamTools = hasAction(can, 'raids.edit') ? [teamPlannerItem(gid, b)] : [];
    // Guild admin: Users (guild.access), then Guild settings.
    const admin = [];
    if (canSeeUsers(can)) admin.push({ key: 'users', label: 'Users', short: 'Users', icon: 'roster', href: b + G.router.format({ name: 'users', gid: gid, segment: null }) });
    if (canSeeSettings(can)) admin.push({ key: 'settings', label: 'Guild settings', short: 'Settings', icon: 'settings', href: b + G.router.format({ name: 'settings', gid: gid, tab: null }) });
    // A head shows only when more than one section is visible (a member sees the top items alone, with no heads).
    const showHeads = 1 + (teamTools.length ? 1 : 0) + (admin.length ? 1 : 0) > 1;
    const out = top.slice();
    if (teamTools.length) out.push.apply(out, (showHeads ? [navHead('team-tools', 'Team tools')] : []).concat(teamTools));
    if (admin.length) out.push.apply(out, (showHeads ? [navHead('guild-admin', 'Guild admin')] : []).concat(admin));
    return out;
  }

  // What's new, Future enhancements, How it works, FAQ: the four pages the single Help item of every sidebar opens.
  function helpItems(ctx) {
    const base = baseOf(ctx);
    const unseen = !!(ctx && ctx.whatsNewUnseen);
    return [
      { key: 'whats-new', label: 'What\'s new', short: 'What\'s new', icon: 'whatsnew', href: '/whats-new.html', isNew: unseen,
        ariaLabel: unseen ? 'What\'s new, new' : 'What\'s new' },
      { key: 'roadmap', label: 'Future enhancements', short: 'Roadmap', icon: 'roadmap', href: base + G.router.format({ name: 'roadmap' }) },
      { key: 'how-it-works', label: 'How it works', short: 'Guide', icon: 'guide', href: base + '#how-it-works', action: 'how-it-works' },
      { key: 'faq', label: 'FAQ', short: 'FAQ', icon: 'faq', href: '/faq.html' },
    ];
  }

  // The one "Help" sidebar item (separated, at the bottom): a fold that opens What's new, Future enhancements, How it works and FAQ. It carries the
  // neutral "New" mark while What's new is unseen, so the news is not hidden by the fold.
  function helpGroup(ctx) {
    const unseen = !!(ctx && ctx.whatsNewUnseen);
    return { key: 'help', label: 'Help', short: 'Help', icon: 'faq', separated: true, isNew: unseen, ariaLabel: unseen ? 'Help, new' : 'Help', children: helpItems(ctx) };
  }

  // The nav model, one function (tested as a matrix): the sidebar / drawer list for this viewer.
  // Signed out, or signed in with no guild (or its data not loaded yet): Planner, then the Help item.
  // With a guild: Home (the officer list or the member's own page), Raids, Loot, Roster, Attendance, then [Team tools: Planner] and [Guild admin: Users, Guild settings] under heads when more than one section shows, then the one Help item.
  // Phone tabs are tabItems (Home, Raids, Roster or Loot, Attendance, More); the drawer carries the whole list.
  function sidebarItems(ctx) {
    const gd = guildOf(ctx);
    const own = gd ? navItems(gd.guild.id, gd.me && gd.me.can, badgesOf(gd, ctx.teamId), baseOf(ctx)) : [plannerItem()];
    if (gd) own.unshift(homeItem(gd.guild.id, homeBadge(ctx), baseOf(ctx))); // every member has a Home; only the officer one counts items
    return own.concat([helpGroup(ctx)]);
  }

  // "More" opens the phone drawer, which holds everything the four tabs leave out (Planner, Guild settings, Help, and whichever of Roster / Loot is not a tab).
  function moreItem() {
    return { key: 'more', label: 'More', short: 'More', icon: 'menu', href: '#', action: 'open-drawer', ariaLabel: 'More: open the menu' };
  }

  // Phone tabs (design framework, Phones boards): guild sections of a viewer with a guild only. An officer (anyone with the Needs attention list) gets
  // Home, Raids, Roster, Attendance, More; a member gets Home, Raids, Attendance, Loot, More. Settings lives under More.
  function tabItems(ctx) {
    const gd = guildOf(ctx);
    if (!gd || !signedIn(ctx) || sectionOf(ctx) !== 'guild') return [];
    const nav = navItems(gd.guild.id, null, badgesOf(gd, ctx.teamId), baseOf(ctx));
    const pick = function (key) { return nav.filter(function (item) { return item.key === key; })[0]; };
    const officer = canSeeAttention(gd.me && gd.me.can);
    const home = homeItem(gd.guild.id, homeBadge(ctx), baseOf(ctx));
    return (officer ? [home, pick('raids'), pick('roster'), pick('attendance')] : [home, pick('raids'), pick('attendance'), pick('loot')]).concat([moreItem()]);
  }

  // Whether the viewer has any guild tile to show (a guild, or the add button).
  function hasTiles(me) {
    if (!me) return false;
    return (Array.isArray(me.guilds) && me.guilds.length > 0) || !!(me.create && me.create.allowed);
  }

  function isActiveItem(item, route) {
    if (!route) return false;
    if (item.key === 'settings') return route.name === 'settings' || route.name === 'setup';
    if (item.key === 'users') return route.name === 'users' || route.name === 'user';
    if (item.key === 'roadmap') return route.name === 'roadmap';
    if (item.key === 'roster' && (route.name === 'person' || route.name === 'import' || route.name === 'intent' || route.name === 'recruiting' || route.name === 'applications' || route.name === 'launch')) return true;
    if (item.key === 'raids' && (route.name === 'raidnew' || route.name === 'raid' || route.name === 'away')) return true;
    if (item.key === 'attendance' && (route.name === 'review' || route.name === 'backfill' || route.name === 'personatt')) return true;
    if (item.key === 'loot' && /^loot(person|standings|night|item|award|fix)$/.test(route.name)) return true;
    return route.name === 'section' && route.section === item.key; // Home included: its key is the 'home' section
  }

  // The current item: Planner on the planner section, FAQ / What's new on their pages, the section on guild pages.
  function isCurrentItem(item, ctx) {
    const section = sectionOf(ctx);
    if (section === 'planner') return item.key === 'planner';
    if (section === 'page') return item.key === ctx.page;
    return isActiveItem(item, ctx.route);
  }

  function navBadgeHtml(item) {
    return item.badge > 0 ? '<span class="gs-nav-badge" aria-hidden="true">' + esc(item.badge) + '</span>' : '';
  }

  function newMarkHtml(item) {
    return item.isNew ? '<span class="gs-new-pill" aria-hidden="true">NEW</span><span class="gs-new-dot" aria-hidden="true"></span>' : '';
  }

  function actionAttr(item) { return item.action ? ' data-action="' + esc(item.action) + '"' : ''; }

  function navLinkHtml(item, ctx) {
    const active = isCurrentItem(item, ctx);
    return '<li><a class="gs-nav-link' + (active ? ' is-active' : '') + '" href="' + esc(item.href) + '"' + actionAttr(item) + ' aria-label="' + esc(item.ariaLabel || item.label) + '"' + (active ? ' aria-current="page"' : '') + '>' +
      ic(item.icon, 20) + '<span class="gs-label-full">' + esc(item.label) + '</span><span class="gs-label-short" aria-hidden="true">' + esc(item.short) + '</span>' + navBadgeHtml(item) + newMarkHtml(item) + '</a></li>';
  }

  // The Help fold: a button that shows or hides its pages (data-action="help-toggle" in app.js). It is open while one of its pages is the current one.
  // listId keeps the ids unique when the sidebar and the phone drawer both draw it.
  // The user's own open/closed choice for a fold (sessionStorage, written by app.js help-toggle); null = no choice yet.
  const FOLD_KEY_PREFIX = 'raidsmith.shell.fold.';
  function foldChoice(key) {
    try {
      const v = window.sessionStorage.getItem(FOLD_KEY_PREFIX + key);
      return v === '1' ? true : v === '0' ? false : null;
    } catch (e) { return null; }
  }

  function foldHtml(item, ctx, listId) {
    const manual = foldChoice(item.key);
    const open = manual !== null ? manual : item.children.some(function (child) { return isCurrentItem(child, ctx); });
    const id = 'nav-fold-' + item.key + '-' + listId;
    return '<li class="gs-nav-fold' + (open ? ' is-open' : '') + '"><button type="button" class="gs-nav-link gs-nav-foldbtn" data-action="help-toggle" data-fold="' + esc(item.key) + '" data-key="' + esc(item.key) + '-toggle-' + esc(listId) + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="' + esc(id) + '" aria-label="' + esc(item.ariaLabel || item.label) + '">' +
      ic(item.icon, 20) + '<span class="gs-label-full">' + esc(item.label) + '</span><span class="gs-label-short" aria-hidden="true">' + esc(item.short) + '</span>' + newMarkHtml(item) + ic('chevronDown', 16) + '</button>' +
      '<ul class="gs-nav-sub" id="' + esc(id) + '"' + (open ? '' : ' hidden') + '>' + item.children.map(function (child) { return navLinkHtml(child, ctx); }).join('') + '</ul></li>';
  }

  function navListHtml(items, ctx, listId) {
    return '<ul class="gs-nav-list">' + items.map(function (item) {
      if (item.head) return '<li class="gs-nav-head" role="presentation"><span class="gs-nav-headtxt">' + esc(item.label) + '</span></li>';
      const sep = item.separated ? '<li class="gs-nav-sep" role="separator"></li>' : '';
      return sep + (item.children ? foldHtml(item, ctx, listId || 'side') : navLinkHtml(item, ctx));
    }).join('') + '</ul>';
  }

  function tilesHtml(me, activeGuildId, route, base) {
    const b = base || '';
    const guilds = me && Array.isArray(me.guilds) ? me.guilds : [];
    const canCreate = !!(me && me.create && me.create.allowed);
    const tiles = guilds.map(function (g) {
      const active = g.id === activeGuildId;
      return '<li><a class="gs-tile' + (active ? ' is-active' : '') + '" href="' + esc(guildHref(g.id, 'home', b)) + '" aria-label="' + esc(g.name) + '" title="' + esc(g.name) + '"' + (active ? ' aria-current="true"' : '') + '>' + esc(G.ui.initials(g.name)) + '</a></li>';
    });
    if (canCreate) {
      const onNew = route && route.name === 'new';
      tiles.push('<li><a class="gs-tile gs-tile-add' + (onNew ? ' is-active' : '') + '" href="' + esc(b + '#/new') + '" aria-label="Add a guild" title="Add a guild"' + (onNew ? ' aria-current="page"' : '') + '>' + ic('plus', 20) + '</a></li>');
    }
    return tiles.length ? '<ul class="gs-tiles">' + tiles.join('') + '</ul>' : '';
  }

  function teamSelectHtml(teams, teamId, id) {
    const active = activeTeams(teams);
    if (active.length < 2) return '';
    return '<label class="gs-sr" for="' + esc(id) + '">Team</label><span class="gs-select-wrap"><select class="gs-team-select" id="' + esc(id) + '" data-change="team-pick" data-key="team-pick">' +
      active.map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === teamId ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
      '</select>' + ic('chevronDown', 18) + '</span>';
  }

  function guildHeadHtml(ctx, selectId) {
    const g = ctx.guildData.guild;
    return '<div class="gs-side-head"><div class="gs-side-guild"><span class="gs-side-name">' + esc(g.name) + '</span><span class="gs-side-realm">' + esc(G.ui.realmLine(g)) + '</span></div>' +
      '<div><span class="gs-badge" data-version="' + esc(g.gameVersion) + '">' + esc(G.ui.gameVersionLabel(g.gameVersion)) + '</span></div>' +
      teamSelectHtml(ctx.guildData.teams, ctx.teamId, selectId) + '</div>';
  }

  // The sidebar head without a guild: the brand row (collapsed: just the mark in the top area).
  function brandHeadHtml() {
    return '<div class="gs-side-brand"><a class="gs-brand-row" href="/" data-action="open-planner" aria-label="Raidsmith planner">' + G.icons.logo + '<span class="gs-brand-name">Raidsmith</span></a></div>';
  }

  function headHtml(ctx, selectId) {
    return guildOf(ctx) ? guildHeadHtml(ctx, selectId) : brandHeadHtml();
  }

  // The phone header's team picker; a guild with no active team shows its name instead.
  function phonePickHtml(ctx) {
    const select = teamSelectHtml(ctx.guildData.teams, ctx.teamId, 'gs-team-select-phone');
    return '<div class="gs-phone-pick">' + (select || '<span class="gs-phone-guild">' + esc(ctx.guildData.guild.name) + '</span>') + '</div>';
  }

  function sidebarHtml(ctx) {
    const collapsed = !!ctx.collapsed;
    return '<aside class="gs-sidebar" aria-label="Main navigation">' + headHtml(ctx, 'gs-team-select') +
      '<nav aria-label="Main">' + navListHtml(sidebarItems(ctx), ctx, 'side') + '</nav>' +
      '<div class="gs-side-foot"><button type="button" class="gs-collapse" data-action="toggle-sidebar" data-key="toggle-sidebar" aria-expanded="' + (collapsed ? 'false' : 'true') + '" aria-label="' + (collapsed ? 'Expand sidebar' : 'Collapse sidebar') + '">' +
      ic(collapsed ? 'expand' : 'collapse', 20) + '<span class="gs-label-full">' + (collapsed ? 'Expand' : 'Collapse') + '</span></button></div></aside>';
  }

  function activeGid(ctx) { const gd = guildOf(ctx); return gd ? gd.guild.id : null; }

  // The guild rail: the logo (a Planner link) and one tile per guild. Nothing when the viewer has no tiles.
  function railHtml(ctx) {
    if (!signedIn(ctx) || !hasTiles(ctx.me) || viewerPage(ctx)) return '';
    return '<aside class="gs-rail" aria-label="Guilds"><a class="gs-rail-logo" href="/" data-action="open-planner" aria-label="Raidsmith planner">' + G.icons.logo + '</a><div class="gs-rail-line" aria-hidden="true"></div>' +
      tilesHtml(ctx.me, activeGid(ctx), ctx.route, baseOf(ctx)) + '</aside>';
  }

  // The phone drawer, for every viewer: rail tiles when there are any, the guild or brand head, the full sidebar list.
  function drawerHtml(ctx) {
    const tiles = signedIn(ctx) && hasTiles(ctx.me) && !viewerPage(ctx) ? tilesHtml(ctx.me, activeGid(ctx), ctx.route, baseOf(ctx)) : '';
    const rail = tiles ? '<div class="gs-drawer-rail">' + G.icons.logo + tiles + '</div>' : '';
    return '<dialog class="gs-drawer" id="gs-drawer" aria-label="Main menu">' + rail +
      '<div class="gs-drawer-panel"><div class="gs-drawer-top"><button type="button" class="gs-icon-btn" data-action="close-drawer" aria-label="Close menu">' + ic('close', 20) + '</button></div>' +
      headHtml(ctx, 'gs-team-select-drawer') +
      '<nav aria-label="Main">' + navListHtml(sidebarItems(ctx), ctx, 'drawer') + '</nav></div></dialog>';
  }

  function tabsHtml(ctx) {
    const items = tabItems(ctx);
    if (!items.length) return '';
    // More is the current tab when the page is none of the other four (Guild settings, Loot for an officer, Roster for a member, Away notices...).
    const onATab = items.some(function (item) { return item.key !== 'more' && isCurrentItem(item, ctx); });
    return '<nav class="gs-tabs" aria-label="Main"><ul class="gs-tabs-list">' + items.map(function (item) {
      if (item.key === 'more') {
        return '<li><button type="button" class="gs-tab' + (onATab ? '' : ' is-active') + '" data-action="open-drawer" data-key="tab-more" aria-haspopup="dialog" aria-controls="gs-drawer" aria-label="' + esc(item.ariaLabel) + '">' +
          ic(item.icon, 22) + '<span aria-hidden="true">' + esc(item.short) + '</span></button></li>';
      }
      const active = isCurrentItem(item, ctx);
      return '<li><a class="gs-tab' + (active ? ' is-active' : '') + '" href="' + esc(item.href) + '"' + actionAttr(item) + ' aria-label="' + esc(item.ariaLabel || item.label) + '"' + (active ? ' aria-current="page"' : '') + '>' +
        ic(item.icon, 22) + '<span aria-hidden="true">' + esc(item.short) + '</span>' + navBadgeHtml(item) + '</a></li>';
    }).join('') + '</ul></nav>';
  }

  // ── breadcrumb ──
  // The attendance and loot pages that hang under Raids, Attendance or Loot: their parent section and the crumb text.
  const ATT_LEAF = {
    raidnew: { parent: 'raids', parentLabel: 'Raids', label: 'New raid' },
    away: { parent: 'raids', parentLabel: 'Raids', label: 'Away notices' },
    raid: { parent: 'raids', parentLabel: 'Raids', label: 'Raid' },
    review: { parent: 'attendance', parentLabel: 'Attendance', label: 'Review queue' },
    backfill: { parent: 'attendance', parentLabel: 'Attendance', label: 'Backfill from Warcraft Logs' },
    personatt: { parent: 'attendance', parentLabel: 'Attendance', label: 'Person' },
    lootperson: { parent: 'loot', parentLabel: 'Loot', label: 'Person' },
    lootstandings: { parent: 'loot', parentLabel: 'Loot', label: 'Standings' },
    lootnight: { parent: 'loot', parentLabel: 'Loot', label: 'Night' },
    lootitem: { parent: 'loot', parentLabel: 'Loot', label: 'Item' },
    lootaward: { parent: 'loot', parentLabel: 'Loot', label: 'Award' },
    lootfix: { parent: 'loot', parentLabel: 'Loot', label: 'Needs fixing' },
    intent: { parent: 'roster', parentLabel: 'Roster', label: 'Spec poll' },
    recruiting: { parent: 'roster', parentLabel: 'Roster', label: 'Recruiting' },
    applications: { parent: 'roster', parentLabel: 'Roster', label: 'Recruiting' },
    launch: { parent: 'roster', parentLabel: 'Roster', label: 'Launch' },
  };
  const IMPORT_LABELS = { 'raid-helper': 'Import from Raid-Helper', wcl: 'Import from Warcraft Logs', bnet: 'Import from Battle.net', csv: 'Import from a CSV file' };
  // The Planner's trail (desktop top bar). The guild is the one the sidebar shows (ctx.plannerGuild, else the loaded guild data); none for a
  // signed-out visitor or an account on no guild. On a plan "Planner" links back to the landing (the same open-planner action as the nav item)
  // and the last crumb is the plan name, which follows the planner live (ctx.planner = { view, name }).
  function plannerCrumbs(ctx) {
    const gd = guildOf(ctx);
    const guild = ctx.plannerGuild || (gd ? { id: gd.guild.id, name: gd.guild.name } : null);
    const p = ctx.planner || {};
    const onPlan = p.view === 'app';
    const crumbs = [];
    if (guild) crumbs.push({ label: guild.name, href: guildHref(guild.id, 'roster', baseOf(ctx)) });
    crumbs.push(onPlan ? { label: 'Planner', href: '/', action: 'open-planner' } : { label: 'Planner' });
    if (onPlan && p.name) crumbs.push({ label: p.name });
    return crumbs;
  }

  function breadcrumbItems(ctx) {
    const r = ctx.route || {};
    const gd = ctx.guildData;
    const crumbs = [];
    if (ctx.section === 'planner') return plannerCrumbs(ctx);
    if (ctx.section === 'page') return [{ label: PAGE_NAMES[ctx.page] || 'Raidsmith' }];
    if (r.name === 'new') return [{ label: 'Create a guild' }];
    if (r.name === 'privacy') return [{ label: 'Privacy & my data' }];
    if (r.name === 'roadmap') return [{ label: 'Future enhancements' }];
    if (r.name === 'guest' || r.name === 'view') return [{ label: 'Guest view' }];
    if (r.name === 'public') return [{ label: 'Public page' }];
    if (r.name === 'apply') return [{ label: 'Apply' }];
    if (r.name === 'join') return [{ label: 'Join a raid' }];
    if (ctx.signedOut) return [{ label: 'Sign in' }];
    if (r.name === 'linked') return [{ label: 'Linked accounts' }];
    if (r.name === 'characters') return [{ label: 'My characters' }];
    if (r.name === 'fresh') {
      const title = G.pages && G.pages.fresh ? G.pages.fresh.titleOf(r) : 'Confirm it is you';
      return gd && gd.guild ? [{ label: gd.guild.name, href: guildHref(gd.guild.id, 'home', baseOf(ctx)) }, { label: title }] : [{ label: title }];
    }
    if (!gd || !gd.guild) return [{ label: 'Raidsmith' }];
    crumbs.push({ label: gd.guild.name, href: guildHref(gd.guild.id, 'roster', baseOf(ctx)) });
    if (r.name === 'section' || r.name === 'person' || r.name === 'import' || ATT_LEAF[r.name]) {
      const active = activeTeams(gd.teams);
      // The team shows with several active teams, and always on an archived team's roster (?team= in the hash). Home spans every team: no team crumb.
      const wanted = r.name === 'section' && r.section === 'roster' && r.team ? r.team : ctx.teamId;
      const all = Array.isArray(gd.teams) ? gd.teams : [];
      const onHome = r.name === 'section' && r.section === 'home';
      const team = !onHome && (active.length > 1 || (r.team && r.name === 'section')) ? all.filter(function (t) { return t.id === wanted; })[0] : null;
      if (team) crumbs.push({ label: team.name });
      if (r.name === 'section') {
        crumbs.push({ label: { home: 'Home', roster: 'Roster', raids: 'Raids', attendance: 'Attendance', loot: 'Loot' }[r.section] || 'Roster' });
      } else if (ATT_LEAF[r.name]) {
        const leaf = ATT_LEAF[r.name];
        crumbs.push({ label: leaf.parentLabel, href: guildHref(gd.guild.id, leaf.parent, baseOf(ctx)) });
        crumbs.push({ label: ctx.leafName || leaf.label });
      } else {
        crumbs.push({ label: 'Roster', href: guildHref(gd.guild.id, 'roster', baseOf(ctx)) });
        crumbs.push({ label: r.name === 'person' ? (ctx.personName || 'Person') : IMPORT_LABELS[r.source] || 'Import' });
      }
    } else if (r.name === 'settings') {
      const tabs = settingsTabs(gd.me && gd.me.can, gd.me && gd.me.roles, gd.owner);
      const first = tabs[0];
      crumbs.push({ label: 'Guild settings', href: baseOf(ctx) + G.router.format({ name: 'settings', gid: gd.guild.id, tab: first ? first.tab : null }) });
      const cur = tabs.filter(function (t) { return t.tab === r.tab; })[0];
      if (cur) crumbs.push({ label: cur.label });
    } else if (r.name === 'setup') {
      const tabs = settingsTabs(gd.me && gd.me.can, gd.me && gd.me.roles, gd.owner);
      crumbs.push({ label: 'Guild settings', href: baseOf(ctx) + G.router.format({ name: 'settings', gid: gd.guild.id, tab: tabs[0] ? tabs[0].tab : null }) });
      crumbs.push({ label: 'Guild setup' });
    } else if (r.name === 'users') {
      crumbs.push({ label: 'Users' });
    } else if (r.name === 'user') {
      crumbs.push({ label: 'Users', href: baseOf(ctx) + G.router.format({ name: 'users', gid: gd.guild.id, segment: null }) });
      crumbs.push({ label: ctx.leafName || 'User' });
    }
    return crumbs;
  }

  function breadcrumbHtml(crumbs) {
    return '<nav aria-label="Breadcrumb"><ol class="gs-crumbs">' + crumbs.map(function (c, i) {
      const last = i === crumbs.length - 1;
      const inner = c.href && !last ? '<a href="' + esc(c.href) + '"' + (c.action ? ' data-action="' + esc(c.action) + '"' : '') + '>' + esc(c.label) + '</a>' : esc(c.label);
      return (i ? '<li aria-hidden="true">/</li>' : '') + '<li' + (last ? ' aria-current="page" class="is-current"' : '') + '>' + inner + '</li>';
    }).join('') + '</ol></nav>';
  }

  // ── top bar ──
  // The back link on the person record, the import pages and Guild settings (phone top bar).
  function backLinkHtml(ctx) {
    const fixed = fixedBackLinkHtml(ctx);
    const prev = fixed && G.router.previous ? G.router.previous() : null;
    // The previous in-app page replaces the fixed parent (a plain click calls history.back()); a direct link has none.
    return prev ? '<a class="gs-back" href="' + esc(baseOf(ctx) + prev.hash) + '" data-action="back-prev" aria-label="Back to ' + esc(prev.name) + '">&lsaquo; ' + esc(prev.name) + '</a>' : fixed;
  }

  function fixedBackLinkHtml(ctx) {
    const gd = guildOf(ctx);
    const r = ctx.route || {};
    if (!gd || sectionOf(ctx) !== 'guild') return '';
    const leaf = ATT_LEAF[r.name];
    if (leaf) {
      return '<a class="gs-back" href="' + esc(guildHref(gd.guild.id, leaf.parent, baseOf(ctx))) + '" aria-label="Back to ' + esc(leaf.parentLabel) + '">&lsaquo; ' + esc(leaf.parentLabel) + '</a>';
    }
    if (r.name === 'settings') {
      // A settings page goes back to the list of pages; the list itself goes back to Home.
      const toList = !!r.tab;
      const label = toList ? 'Settings' : 'Home';
      const href = toList ? baseOf(ctx) + G.router.format({ name: 'settings', gid: gd.guild.id, tab: null }) : guildHref(gd.guild.id, 'home', baseOf(ctx));
      return '<a class="gs-back" href="' + esc(href) + '" aria-label="Back to ' + label + '">&lsaquo; ' + label + '</a>';
    }
    if (r.name === 'user') {
      return '<a class="gs-back" href="' + esc(baseOf(ctx) + G.router.format({ name: 'users', gid: gd.guild.id, segment: null })) + '" aria-label="Back to Users">&lsaquo; Users</a>';
    }
    if (r.name === 'setup') {
      return '<a class="gs-back" href="' + esc(baseOf(ctx) + G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'battlenet' })) + '" aria-label="Back to Battle.net">&lsaquo; Battle.net</a>';
    }
    if (r.name !== 'person' && r.name !== 'import') return '';
    return '<a class="gs-back" href="' + esc(guildHref(gd.guild.id, 'roster', baseOf(ctx))) + '" aria-label="Back to Roster">&lsaquo; Roster</a>';
  }

  // What follows the phone menu button: team picker / guild name, the back link, or the page name. Nothing on the planner.
  function phoneLeadHtml(ctx) {
    const section = sectionOf(ctx);
    if (section === 'planner') return '';
    if (section === 'page') return '<span class="gs-phone-title">' + esc(PAGE_NAMES[ctx.page] || 'Raidsmith') + '</span>';
    const back = backLinkHtml(ctx);
    if (back) return back;
    if (guildOf(ctx)) return phonePickHtml(ctx);
    const crumbs = breadcrumbItems(ctx);
    return '<span class="gs-phone-title">' + esc(crumbs[crumbs.length - 1].label) + '</span>';
  }

  // #shell-topbar-lead: the phone menu button (every page), the phone title area, the desktop breadcrumb.
  function leadHtml(ctx) {
    const menu = '<button type="button" class="gs-menu-btn" data-action="open-drawer" data-key="menu-btn" aria-haspopup="dialog" aria-controls="gs-drawer" aria-label="Open menu">' + ic('menu', 24) + '</button>';
    const phone = phoneLeadHtml(ctx);
    const crumbs = '<div class="gs-crumbs-wrap">' + breadcrumbHtml(breadcrumbItems(ctx)) + '</div>';
    return menu + (phone ? '<div class="gs-lead-phone">' + phone + '</div>' : '') + crumbs;
  }

  // ── avatar menu ──
  function accountMenuHtml(ctx) {
    const u = ctx.me.user;
    const gd = ctx.guildData;
    // A Discord username reads @name; an account made with Battle.net has only its BattleTag name.
    let sub = ctx.me.identities && !ctx.me.identities.discord ? u.username : '@' + u.username;
    if (gd && gd.guild) {
      const roles = G.peopleSort.roleLabels(gd.me && gd.me.roles, gd.teams);
      sub = roles[0].label + ' - ' + gd.guild.name;
    }
    // "My profile": the viewer's own person page in the guild in play (none while the account is on no roster).
    const profileHref = gd && gd.guild && gd.me && gd.me.personId ? baseOf(ctx) + G.router.format({ name: 'person', gid: gd.guild.id, pid: gd.me.personId }) : '';
    return '<div class="gs-account"><button type="button" class="gs-avatar-btn" data-action="toggle-menu" data-key="account-menu" aria-label="Account menu" aria-haspopup="menu" aria-expanded="false" aria-controls="gs-account-menu">' +
      G.ui.avatarHtml(u, 'gs-avatar-md') + ic('chevronDown', 16) + '</button>' +
      '<div class="gs-menu" id="gs-account-menu" role="menu" aria-label="Account" hidden>' +
      '<div class="gs-menu-head">' + G.ui.avatarHtml(u, 'gs-avatar-lg') + '<div class="gs-menu-who"><span class="gs-menu-name">' + esc(u.displayName) + '</span><span class="gs-menu-sub">' + esc(sub) + '</span></div></div>' +
      '<div class="gs-menu-sep" role="separator"></div>' +
      (profileHref ? '<a class="gs-menu-item" role="menuitem" href="' + esc(profileHref) + '">' + ic('roster', 20) + '<span>My profile</span></a>' : '') +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(baseOf(ctx) + '#/characters') + '">' + ic('roster', 20) + '<span>My characters</span></a>' +
      (gd && gd.guild ? '<a class="gs-menu-item" role="menuitem" href="' + esc(baseOf(ctx) + G.router.format({ name: 'away', gid: gd.guild.id })) + '">' + ic('raids', 20) + '<span>Away notices</span></a>' : '') +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(baseOf(ctx) + '#/linked') + '">' + ic('link', 20) + '<span>Linked accounts</span></a>' +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(baseOf(ctx) + '#/privacy') + '">' + ic('lock', 20) + '<span>Privacy &amp; my data</span></a>' +
      '<button type="button" class="gs-menu-item" role="menuitem" data-action="sign-out">' + ic('logout', 20) + '<span>Sign out</span></button>' +
      '</div></div>';
  }

  // Signed out: "Sign in or sign up" (desktop) / "Sign in" (phone). It opens the sign-in page, where Discord and Battle.net are offered. On the planner
  // (landing and board, where Load roster and Optimize are the primaries) it is a text link, and so it is on the pages that have a primary of their own (the sign-in
  // card, the guest sign-up, the application form): one orange button per screen. A guild page or a help page keeps the button.
  const OWN_PRIMARY_ROUTES = ['home', 'signin', 'join', 'apply'];
  function signinButtonHtml(ctx) {
    if (sectionOf(ctx) === 'planner' || (ctx.route && OWN_PRIMARY_ROUTES.indexOf(ctx.route.name) >= 0)) {
      return '<a class="gs-signin-link" href="' + esc(baseOf(ctx) + G.router.format({ name: 'signin' })) + '"><span class="gs-signin-full">Sign in or sign up</span><span class="gs-signin-short">Sign in</span></a>';
    }
    return '<a class="gs-btn gs-btn-molten gs-signin-btn" href="' + esc(baseOf(ctx) + G.router.format({ name: 'signin' })) + '">' + ic('login', 18) + '<span class="gs-signin-full">Sign in or sign up</span><span class="gs-signin-short">Sign in</span></a>';
  }

  // #shell-topbar-account: a divider on the planner section, then the avatar menu or the sign-in button.
  // While the session question is open (ctx.pending) nothing shows, so the bar does not flash the wrong state.
  function accountSlotHtml(ctx) {
    if (ctx.pending) return '';
    const divider = sectionOf(ctx) === 'planner' ? '<span class="gs-topbar-divider" aria-hidden="true"></span>' : '';
    return divider + (signedIn(ctx) ? accountMenuHtml(ctx) : signinButtonHtml(ctx));
  }

  // ── Guild settings frame (T3): the five groups on the left, one page at a time beside them ──
  // On a phone the list is the first screen (view 'list') and a page opens with a Back link (view 'detail'). innerHtml is the page's own content; a form page
  // puts its Save bar inside its form (ui.saveBarHtml). ctx.settingsSavedAt (ms) is when the open page was last saved, for the head's "Saved at 8:14 PM ET".
  function settingsFrameModel(ctx) {
    const gd = ctx.guildData;
    const can = gd.me && gd.me.can;
    const roles = gd.me && gd.me.roles;
    const gid = gd.guild.id;
    const base = baseOf(ctx);
    const groups = settingsGroups(can, roles, gd.owner);
    const total = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    return {
      groups: groups.map(function (g) {
        return { label: g.label, items: g.items.map(function (t) { return { key: t.tab, label: t.label, isNew: t.isNew, href: base + G.router.format({ name: 'settings', gid: gid, tab: t.tab }) }; }) };
      }),
      heading: 'Guild settings',
      subline: gd.guild.name + ' - ' + total + (total === 1 ? ' page' : ' pages') + ' in ' + groups.length + (groups.length === 1 ? ' group' : ' groups'),
      listHref: base + G.router.format({ name: 'settings', gid: gid, tab: null }),
    };
  }

  function settingsFrameHtml(ctx, activeTab, innerHtml) {
    const gd = ctx.guildData;
    const model = settingsFrameModel(ctx);
    const tabs = settingsTabs(gd.me && gd.me.can, gd.me && gd.me.roles, gd.owner);
    const cur = tabs.filter(function (t) { return t.tab === activeTab; })[0] || { label: 'Guild settings', purpose: '' };
    const saved = typeof ctx.settingsSavedAt === 'number' ? G.ui.savedStatusHtml('Saved at ' + G.ui.timeInZone(ctx.settingsSavedAt, gd.guild.timeZone)) : G.ui.savedStatusHtml('');
    return G.ui.settingsPageHtml({ groups: model.groups, activeKey: activeTab, view: 'detail', listHref: model.listHref, heading: model.heading, subline: model.subline,
      title: cur.label, purpose: cur.purpose, savedHtml: saved, bodyHtml: innerHtml });
  }

  // The phone's first screen (and the wide screen's, if the window is narrowed and widened again on the bare address): the list of pages alone.
  function settingsListHtml(ctx) {
    const model = settingsFrameModel(ctx);
    return G.ui.settingsPageHtml({ groups: model.groups, view: 'list', heading: model.heading, subline: model.subline, title: 'Guild settings',
      purpose: 'Choose a page from the list.', bodyHtml: '' });
  }

  // Shown at the top of a guild's pages when the viewer can claim it (/auth/me create.claimable lists it).
  function claimNoticeHtml(ctx) {
    const list = ctx.me && ctx.me.create && Array.isArray(ctx.me.create.claimable) ? ctx.me.create.claimable : [];
    const gid = ctx.guildData && ctx.guildData.guild ? ctx.guildData.guild.id : null;
    if (!gid || !list.some(function (c) { return c && c.guildId === gid; })) return '';
    return '<div class="gs-notice gs-claim-banner" role="status"><span>This guild has no Guild Master. You can claim it.</span><a href="' + esc(baseOf(ctx) + '#/new') + '">Claim it on Create guild</a></div>';
  }

  // Dev-only "View as" bar (GET /api/guild/:gid carries `dev` only for a real Guild Master on a local run with DEV_VIEW_AS=1). Blue "info" tones, never the
  // orange of the primary button. The live region says what the switch did; app.js keeps the sentence in ctx.devNotice across the redraw.
  function devBarHtml(ctx) {
    const gd = guildOf(ctx);
    if (!gd || !gd.dev || sectionOf(ctx) !== 'guild') return '';
    const dev = gd.dev;
    const cur = dev.viewAs || null;
    const roles = Array.isArray(dev.roles) ? dev.roles : [];
    const teams = Array.isArray(dev.teams) ? dev.teams : [];
    const def = cur ? roles.filter(function (r) { return r.id === cur.roleId; })[0] : null;
    const base = baseOf(ctx);
    const gid = gd.guild.id;
    const roleOptions = '<option value=""' + (cur ? '' : ' selected') + '>Guild Master (me)</option>' + roles.map(function (r) {
      return '<option value="' + esc(r.id) + '"' + (cur && cur.roleId === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>';
    }).join('');
    const teamField = def && def.teamScoped && teams.length
      ? '<label class="gs-devbar-field"><span>Team</span><select class="gs-devbar-select" id="devbar-team" data-change="devbar-team" data-key="devbar-team">' +
        teams.map(function (t) { return '<option value="' + esc(t.id) + '"' + (cur && cur.teamId === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</select></label>'
      : '';
    return '<section class="gs-devbar" role="region" aria-label="View as (development only)">' +
      '<span class="gs-devbar-tag">Dev</span>' +
      '<label class="gs-devbar-field"><span>Viewing as</span><select class="gs-devbar-select" id="devbar-role" data-change="devbar-role" data-key="devbar-role">' + roleOptions + '</select></label>' +
      teamField +
      (cur ? '<button type="button" class="gs-devbar-btn" data-action="devbar-reset" data-key="devbar-reset">Back to Guild Master</button>' : '') +
      '<span class="gs-devbar-links"><a href="' + esc(base + G.router.format({ name: 'devview', gid: gid, role: 'guest' })) + '">Guest link (preview)</a>' +
      '<a href="' + esc(base + G.router.format({ name: 'devview', gid: gid, role: 'public' })) + '">Public page (preview)</a></span>' +
      '<span class="gs-sr" id="devbar-live" role="status" aria-live="polite">' + esc(ctx.devNotice || '') + '</span>' +
      '</section>';
  }

  // The HTML for every slot of the page skeleton.
  function slots(ctx) {
    return {
      devbar: devBarHtml(ctx),
      rail: railHtml(ctx),
      sidebar: sidebarHtml(ctx),
      lead: leadHtml(ctx),
      account: accountSlotHtml(ctx),
      banner: sectionOf(ctx) === 'guild' && guildOf(ctx) ? claimNoticeHtml(ctx) : '',
      tabs: tabsHtml(ctx),
      drawer: drawerHtml(ctx),
    };
  }

  // "Skip to content": the first tab stop of every page. The static skeletons (index.html, faq.html, whats-new.html) carry the same link ahead of
  // the rail, so it is first before any script runs; app.js sends a click on it to the visible main area (no hash change: the hash is the router's).
  const SKIP_LINK_HTML = '<a class="gs-skip" href="#gs-main" data-skip-link>Skip to content</a>';

  // Every slot in page order plus the main HTML, as one string: for tests and previews (the page itself writes
  // each slot into its own element and never replaces the planner's markup).
  function render(ctx, mainHtml) {
    const s = slots(ctx);
    return SKIP_LINK_HTML + s.rail + s.sidebar + '<header class="gs-topbar">' + s.lead + s.account + '</header>' + s.banner +
      '<main class="gs-main" id="gs-main">' + (mainHtml || '') + '</main>' + s.tabs + s.drawer;
  }

  G.shell = {
    FOLD_KEY_PREFIX: FOLD_KEY_PREFIX,
    hasAction: hasAction,
    canSeeSettings: canSeeSettings,
    canSeeUsers: canSeeUsers,
    canSeeAttention: canSeeAttention,
    homeBadge: homeBadge,
    SETTINGS_TABS: SETTINGS_TABS,
    SETTINGS_GROUPS: SETTINGS_GROUPS,
    settingsTabs: settingsTabs,
    settingsGroups: settingsGroups,
    isGuildMaster: isGuildMaster,
    activeTeams: activeTeams,
    navItems: navItems,
    helpItems: helpItems,
    helpGroup: helpGroup,
    sidebarItems: sidebarItems,
    SKIP_LINK_HTML: SKIP_LINK_HTML,
    tabItems: tabItems,
    hasTiles: hasTiles,
    rosterBadge: rosterBadge,
    attendanceBadge: attendanceBadge,
    badgesOf: badgesOf,
    allowsTeam: allowsTeam,
    breadcrumbItems: breadcrumbItems,
    leadHtml: leadHtml,
    settingsFrameHtml: settingsFrameHtml,
    settingsListHtml: settingsListHtml,
    accountMenuHtml: accountMenuHtml,
    sidebarHtml: sidebarHtml,
    phonePickHtml: phonePickHtml,
    claimNoticeHtml: claimNoticeHtml,
    devBarHtml: devBarHtml,
    slots: slots,
    render: render,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
