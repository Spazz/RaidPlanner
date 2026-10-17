// ── APP SHELL ───────────────────────────────────────────────────
// Guild rail, labelled sidebar (collapsible to an icon rail), top bar pieces, avatar menu, phone tabs and the phone
// drawer. Pure string builders: slots(ctx) returns the HTML for each slot of the page skeleton (#shell-rail,
// #shell-sidebar, #shell-topbar-lead, #shell-topbar-account, #shell-banner, #shell-tabs, #shell-drawer); app.js writes
// them into the page and wires the events. The planner and the static help pages draw the same shell.
//   ctx = { section, page, me, pending, signedOut, route, guildData, teamId, collapsed, whatsNewUnseen, personName }
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
    return hasAction(can, 'guild.teams') || hasAction(can, 'guild.access') || hasAction(can, 'guild.roles') || hasAction(can, 'attendance.policy') || hasAction(can, 'loot.policy');
  }

  // Whether `can` reaches this team for an action ('guild' = every team, or a list of team ids).
  function allowsTeam(can, action, teamId) {
    if (!can || !Object.prototype.hasOwnProperty.call(can, action)) return false;
    const v = can[action];
    return v === 'guild' || (Array.isArray(v) && !!teamId && v.indexOf(teamId) >= 0);
  }

  // The Guild settings tabs this viewer may open (People and roles needs access or roles).
  function settingsTabs(can) {
    const tabs = [];
    if (hasAction(can, 'guild.teams')) tabs.push({ tab: 'teams', label: 'Teams' });
    if (hasAction(can, 'guild.access') || hasAction(can, 'guild.roles')) tabs.push({ tab: 'people', label: 'People and roles' });
    if (hasAction(can, 'attendance.policy')) tabs.push({ tab: 'attendance', label: 'Attendance' });
    if (hasAction(can, 'loot.policy')) tabs.push({ tab: 'loot', label: 'Loot' });
    if (hasAction(can, 'guild.teams')) tabs.push({ tab: 'battlenet', label: 'Battle.net' });
    return tabs;
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

  // Flagged trials for the selected team, for officers and team leads only (a member's guild payload carries none).
  function rosterBadge(gd, teamId) {
    if (!gd || !teamId || !hasAction(gd.me && gd.me.can, 'roster.edit')) return 0;
    const n = gd.rosterFlags && Object.prototype.hasOwnProperty.call(gd.rosterFlags, teamId) ? Number(gd.rosterFlags[teamId]) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // Raids with open flags for the selected team, for people who can review them (a member's payload carries none).
  function attendanceBadge(gd, teamId) {
    if (!gd || !teamId || !hasAction(gd.me && gd.me.can, 'attendance.review')) return 0;
    const n = gd.attendanceFlags && Object.prototype.hasOwnProperty.call(gd.attendanceFlags, teamId) ? Number(gd.attendanceFlags[teamId]) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function badgesOf(gd, teamId) { return { roster: rosterBadge(gd, teamId), attendance: attendanceBadge(gd, teamId) }; }

  function plannerItem() {
    return { key: 'planner', label: 'Planner', short: 'Planner', icon: 'planner', href: '/', action: 'open-planner' };
  }

  // badges: { roster, attendance } counts (a bare number is the Roster count; 0 = none). base: see guildHref.
  function navItems(gid, can, badges, base) {
    const bs = typeof badges === 'number' ? { roster: badges } : (badges || {});
    const n = bs.roster > 0 ? bs.roster : 0;
    const a = bs.attendance > 0 ? bs.attendance : 0;
    const b = base || '';
    const items = [
      { key: 'roster', label: 'Roster', short: 'Roster', icon: 'roster', href: guildHref(gid, 'roster', b), badge: n,
        ariaLabel: n ? 'Roster, ' + n + (n === 1 ? ' trial' : ' trials') + ' to decide' : 'Roster' },
      { key: 'raids', label: 'Raids', short: 'Raids', icon: 'raids', href: guildHref(gid, 'raids', b) },
      { key: 'attendance', label: 'Attendance', short: 'Attendance', icon: 'attendance', href: guildHref(gid, 'attendance', b), badge: a,
        ariaLabel: a ? 'Attendance, ' + a + (a === 1 ? ' raid' : ' raids') + ' to review' : 'Attendance' },
      { key: 'loot', label: 'Loot', short: 'Loot', icon: 'loot', href: guildHref(gid, 'loot', b) },
      plannerItem(),
    ];
    if (canSeeSettings(can)) {
      const first = settingsTabs(can)[0];
      items.push({ key: 'settings', label: 'Guild settings', short: 'Settings', icon: 'settings', separated: true,
        href: b + G.router.format({ name: 'settings', gid: gid, tab: first ? first.tab : null }) });
    }
    return items;
  }

  // What's new, Future enhancements, How it works, FAQ: at the bottom of every sidebar. The first one starts the separated help group.
  function helpItems(ctx) {
    const base = baseOf(ctx);
    const unseen = !!(ctx && ctx.whatsNewUnseen);
    return [
      { key: 'whats-new', label: 'What\'s new', short: 'What\'s new', icon: 'whatsnew', href: '/whats-new.html', separated: true, isNew: unseen,
        ariaLabel: unseen ? 'What\'s new, new' : 'What\'s new' },
      { key: 'roadmap', label: 'Future enhancements', short: 'Roadmap', icon: 'roadmap', href: base + G.router.format({ name: 'roadmap' }) },
      { key: 'how-it-works', label: 'How it works', short: 'Guide', icon: 'guide', href: base + '#how-it-works', action: 'how-it-works' },
      { key: 'faq', label: 'FAQ', short: 'FAQ', icon: 'faq', href: '/faq.html' },
    ];
  }

  // The nav model, one function (tested as a matrix): the sidebar / drawer list for this viewer.
  // Signed out, or signed in with no guild (or its data not loaded yet): Planner, then the help group.
  // With a guild: Roster, Raids, Attendance, Loot, Planner, [Guild settings], then the help group.
  function sidebarItems(ctx) {
    const gd = guildOf(ctx);
    const own = gd ? navItems(gd.guild.id, gd.me && gd.me.can, badgesOf(gd, ctx.teamId), baseOf(ctx)) : [plannerItem()];
    return own.concat(helpItems(ctx));
  }

  // Phone tabs: guild sections of a viewer with a guild only. Roster, Raids, Attendance, Loot, Planner.
  function tabItems(ctx) {
    const gd = guildOf(ctx);
    if (!gd || !signedIn(ctx) || sectionOf(ctx) !== 'guild') return [];
    return navItems(gd.guild.id, null, badgesOf(gd, ctx.teamId), baseOf(ctx));
  }

  // Whether the viewer has any guild tile to show (a guild, or the add button).
  function hasTiles(me) {
    if (!me) return false;
    return (Array.isArray(me.guilds) && me.guilds.length > 0) || !!(me.create && me.create.allowed);
  }

  function isActiveItem(item, route) {
    if (!route) return false;
    if (item.key === 'settings') return route.name === 'settings';
    if (item.key === 'roadmap') return route.name === 'roadmap';
    if (item.key === 'roster' && (route.name === 'person' || route.name === 'import')) return true;
    if (item.key === 'raids' && (route.name === 'raidnew' || route.name === 'raid')) return true;
    if (item.key === 'attendance' && (route.name === 'review' || route.name === 'backfill' || route.name === 'personatt')) return true;
    if (item.key === 'loot' && route.name === 'lootperson') return true;
    return route.name === 'section' && route.section === item.key;
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

  function navListHtml(items, ctx) {
    return '<ul class="gs-nav-list">' + items.map(function (item) {
      const active = isCurrentItem(item, ctx);
      const sep = item.separated ? '<li class="gs-nav-sep" role="separator"></li>' : '';
      return sep + '<li><a class="gs-nav-link' + (active ? ' is-active' : '') + '" href="' + esc(item.href) + '"' + actionAttr(item) + ' aria-label="' + esc(item.ariaLabel || item.label) + '"' + (active ? ' aria-current="page"' : '') + '>' +
        ic(item.icon, 20) + '<span class="gs-label-full">' + esc(item.label) + '</span><span class="gs-label-short" aria-hidden="true">' + esc(item.short) + '</span>' + navBadgeHtml(item) + newMarkHtml(item) + '</a></li>';
    }).join('') + '</ul>';
  }

  function tilesHtml(me, activeGuildId, route, base) {
    const b = base || '';
    const guilds = me && Array.isArray(me.guilds) ? me.guilds : [];
    const canCreate = !!(me && me.create && me.create.allowed);
    const tiles = guilds.map(function (g) {
      const active = g.id === activeGuildId;
      return '<li><a class="gs-tile' + (active ? ' is-active' : '') + '" href="' + esc(guildHref(g.id, 'roster', b)) + '" aria-label="' + esc(g.name) + '" title="' + esc(g.name) + '"' + (active ? ' aria-current="true"' : '') + '>' + esc(G.ui.initials(g.name)) + '</a></li>';
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
      '<div><span class="gs-badge">' + esc(G.ui.gameVersionLabel(g.gameVersion)) + '</span></div>' +
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
      '<nav aria-label="Main">' + navListHtml(sidebarItems(ctx), ctx) + '</nav>' +
      '<div class="gs-side-foot"><button type="button" class="gs-collapse" data-action="toggle-sidebar" data-key="toggle-sidebar" aria-expanded="' + (collapsed ? 'false' : 'true') + '" aria-label="' + (collapsed ? 'Expand sidebar' : 'Collapse sidebar') + '">' +
      ic(collapsed ? 'expand' : 'collapse', 20) + '<span class="gs-label-full">' + (collapsed ? 'Expand' : 'Collapse') + '</span></button></div></aside>';
  }

  function activeGid(ctx) { const gd = guildOf(ctx); return gd ? gd.guild.id : null; }

  // The guild rail: the logo (a Planner link) and one tile per guild. Nothing when the viewer has no tiles.
  function railHtml(ctx) {
    if (!signedIn(ctx) || !hasTiles(ctx.me)) return '';
    return '<aside class="gs-rail" aria-label="Guilds"><a class="gs-rail-logo" href="/" data-action="open-planner" aria-label="Raidsmith planner">' + G.icons.logo + '</a><div class="gs-rail-line" aria-hidden="true"></div>' +
      tilesHtml(ctx.me, activeGid(ctx), ctx.route, baseOf(ctx)) + '</aside>';
  }

  // The phone drawer, for every viewer: rail tiles when there are any, the guild or brand head, the full sidebar list.
  function drawerHtml(ctx) {
    const tiles = signedIn(ctx) && hasTiles(ctx.me) ? tilesHtml(ctx.me, activeGid(ctx), ctx.route, baseOf(ctx)) : '';
    const rail = tiles ? '<div class="gs-drawer-rail">' + G.icons.logo + tiles + '</div>' : '';
    return '<dialog class="gs-drawer" id="gs-drawer" aria-label="Main menu">' + rail +
      '<div class="gs-drawer-panel"><div class="gs-drawer-top"><button type="button" class="gs-icon-btn" data-action="close-drawer" aria-label="Close menu">' + ic('close', 20) + '</button></div>' +
      headHtml(ctx, 'gs-team-select-drawer') +
      '<nav aria-label="Main">' + navListHtml(sidebarItems(ctx), ctx) + '</nav></div></dialog>';
  }

  function tabsHtml(ctx) {
    const items = tabItems(ctx);
    if (!items.length) return '';
    return '<nav class="gs-tabs" aria-label="Main"><ul class="gs-tabs-list">' + items.map(function (item) {
      const active = isCurrentItem(item, ctx);
      return '<li><a class="gs-tab' + (active ? ' is-active' : '') + '" href="' + esc(item.href) + '"' + actionAttr(item) + ' aria-label="' + esc(item.ariaLabel || item.label) + '"' + (active ? ' aria-current="page"' : '') + '>' +
        ic(item.icon, 22) + '<span aria-hidden="true">' + esc(item.short) + '</span>' + navBadgeHtml(item) + '</a></li>';
    }).join('') + '</ul></nav>';
  }

  // ── breadcrumb ──
  // The attendance and loot pages that hang under Raids, Attendance or Loot: their parent section and the crumb text.
  const ATT_LEAF = {
    raidnew: { parent: 'raids', parentLabel: 'Raids', label: 'New raid' },
    raid: { parent: 'raids', parentLabel: 'Raids', label: 'Raid' },
    review: { parent: 'attendance', parentLabel: 'Attendance', label: 'Review queue' },
    backfill: { parent: 'attendance', parentLabel: 'Attendance', label: 'Backfill from Warcraft Logs' },
    personatt: { parent: 'attendance', parentLabel: 'Attendance', label: 'Person' },
    lootperson: { parent: 'loot', parentLabel: 'Loot', label: 'Person' },
  };
  const IMPORT_LABELS = { 'raid-helper': 'Import from Raid-Helper', wcl: 'Import from Warcraft Logs', bnet: 'Import from Battle.net' };
  function breadcrumbItems(ctx) {
    const r = ctx.route || {};
    const gd = ctx.guildData;
    const crumbs = [];
    if (ctx.section === 'page') return [{ label: PAGE_NAMES[ctx.page] || 'Raidsmith' }];
    if (r.name === 'new') return [{ label: 'Create a guild' }];
    if (r.name === 'privacy') return [{ label: 'Privacy & my data' }];
    if (r.name === 'roadmap') return [{ label: 'Future enhancements' }];
    if (ctx.signedOut) return [{ label: 'Sign in' }];
    if (r.name === 'linked') return [{ label: 'Linked accounts' }];
    if (r.name === 'characters') return [{ label: 'My characters' }];
    if (!gd || !gd.guild) return [{ label: 'Raidsmith' }];
    crumbs.push({ label: gd.guild.name, href: guildHref(gd.guild.id, 'roster', baseOf(ctx)) });
    if (r.name === 'section' || r.name === 'person' || r.name === 'import' || ATT_LEAF[r.name]) {
      const active = activeTeams(gd.teams);
      // The team shows with several active teams, and always on an archived team's roster (?team= in the hash).
      const wanted = r.name === 'section' && r.section === 'roster' && r.team ? r.team : ctx.teamId;
      const all = Array.isArray(gd.teams) ? gd.teams : [];
      const team = active.length > 1 || (r.team && r.name === 'section') ? all.filter(function (t) { return t.id === wanted; })[0] : null;
      if (team) crumbs.push({ label: team.name });
      if (r.name === 'section') {
        crumbs.push({ label: { roster: 'Roster', raids: 'Raids', attendance: 'Attendance', loot: 'Loot' }[r.section] || 'Roster' });
      } else if (ATT_LEAF[r.name]) {
        const leaf = ATT_LEAF[r.name];
        crumbs.push({ label: leaf.parentLabel, href: guildHref(gd.guild.id, leaf.parent, baseOf(ctx)) });
        crumbs.push({ label: ctx.leafName || leaf.label });
      } else {
        crumbs.push({ label: 'Roster', href: guildHref(gd.guild.id, 'roster', baseOf(ctx)) });
        crumbs.push({ label: r.name === 'person' ? (ctx.personName || 'Person') : IMPORT_LABELS[r.source] || 'Import' });
      }
    } else if (r.name === 'settings') {
      const tabs = settingsTabs(gd.me && gd.me.can);
      const first = tabs[0];
      crumbs.push({ label: 'Guild settings', href: baseOf(ctx) + G.router.format({ name: 'settings', gid: gd.guild.id, tab: first ? first.tab : null }) });
      const cur = tabs.filter(function (t) { return t.tab === r.tab; })[0];
      if (cur) crumbs.push({ label: cur.label });
    }
    return crumbs;
  }

  function breadcrumbHtml(crumbs) {
    return '<nav aria-label="Breadcrumb"><ol class="gs-crumbs">' + crumbs.map(function (c, i) {
      const last = i === crumbs.length - 1;
      const inner = c.href && !last ? '<a href="' + esc(c.href) + '">' + esc(c.label) + '</a>' : esc(c.label);
      return (i ? '<li aria-hidden="true">/</li>' : '') + '<li' + (last ? ' aria-current="page" class="is-current"' : '') + '>' + inner + '</li>';
    }).join('') + '</ol></nav>';
  }

  // ── top bar ──
  // The back link on the person record, the import pages and Guild settings (phone top bar).
  function backLinkHtml(ctx) {
    const gd = guildOf(ctx);
    const r = ctx.route || {};
    if (!gd || sectionOf(ctx) !== 'guild') return '';
    const leaf = ATT_LEAF[r.name];
    if (leaf) {
      return '<a class="gs-back" href="' + esc(guildHref(gd.guild.id, leaf.parent, baseOf(ctx))) + '" aria-label="Back to ' + esc(leaf.parentLabel) + '">&lsaquo; ' + esc(leaf.parentLabel) + '</a>';
    }
    if (r.name !== 'person' && r.name !== 'import' && r.name !== 'settings') return '';
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
    const section = sectionOf(ctx);
    const menu = '<button type="button" class="gs-menu-btn" data-action="open-drawer" data-key="menu-btn" aria-haspopup="dialog" aria-controls="gs-drawer" aria-label="Open menu">' + ic('menu', 24) + '</button>';
    const phone = phoneLeadHtml(ctx);
    const crumbs = section === 'planner' ? '' : '<div class="gs-crumbs-wrap">' + breadcrumbHtml(breadcrumbItems(ctx)) + '</div>';
    return menu + (phone ? '<div class="gs-lead-phone">' + phone + '</div>' : '') + crumbs;
  }

  // ── avatar menu ──
  function accountMenuHtml(ctx) {
    const u = ctx.me.user;
    const gd = ctx.guildData;
    let sub = '@' + u.username;
    if (gd && gd.guild) {
      const roles = G.peopleSort.roleLabels(gd.me && gd.me.roles, gd.teams);
      sub = roles[0].label + ' - ' + gd.guild.name;
    }
    return '<div class="gs-account"><button type="button" class="gs-avatar-btn" data-action="toggle-menu" data-key="account-menu" aria-label="Account menu" aria-haspopup="menu" aria-expanded="false" aria-controls="gs-account-menu">' +
      G.ui.avatarHtml(u, 'gs-avatar-md') + ic('chevronDown', 16) + '</button>' +
      '<div class="gs-menu" id="gs-account-menu" role="menu" aria-label="Account" hidden>' +
      '<div class="gs-menu-head">' + G.ui.avatarHtml(u, 'gs-avatar-lg') + '<div class="gs-menu-who"><span class="gs-menu-name">' + esc(u.displayName) + '</span><span class="gs-menu-sub">' + esc(sub) + '</span></div></div>' +
      '<div class="gs-menu-sep" role="separator"></div>' +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(baseOf(ctx) + '#/characters') + '">' + ic('roster', 20) + '<span>My characters</span></a>' +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(baseOf(ctx) + '#/linked') + '">' + ic('link', 20) + '<span>Linked accounts</span></a>' +
      '<a class="gs-menu-item" role="menuitem" href="' + esc(baseOf(ctx) + '#/privacy') + '">' + ic('lock', 20) + '<span>Privacy &amp; my data</span></a>' +
      '<button type="button" class="gs-menu-item" role="menuitem" data-action="sign-out">' + ic('logout', 20) + '<span>Sign out</span></button>' +
      '</div></div>';
  }

  // Signed out: "Sign in with Discord" (desktop) / "Sign in" (phone), both /auth/login.
  function signinButtonHtml() {
    return '<a class="gs-btn gs-btn-molten gs-signin-btn" href="/auth/login">' + ic('login', 18) + '<span class="gs-signin-full">Sign in with Discord</span><span class="gs-signin-short">Sign in</span></a>';
  }

  // #shell-topbar-account: a divider on the planner section, then the avatar menu or the sign-in button.
  // While the session question is open (ctx.pending) nothing shows, so the bar does not flash the wrong state.
  function accountSlotHtml(ctx) {
    if (ctx.pending) return '';
    const divider = sectionOf(ctx) === 'planner' ? '<span class="gs-topbar-divider" aria-hidden="true"></span>' : '';
    return divider + (signedIn(ctx) ? accountMenuHtml(ctx) : signinButtonHtml());
  }

  // ── Guild settings frame: title, tab strip, then the tab's content ──
  function settingsFrameHtml(ctx, activeTab, innerHtml) {
    const gd = ctx.guildData;
    const tabs = settingsTabs(gd.me && gd.me.can);
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Guild settings</h1><p class="gs-sub">' + esc(gd.guild.name) + ' - ' + esc(G.ui.realmLine(gd.guild)) + '</p></div>' +
      '<nav aria-label="Guild settings sections"><ul class="gs-subtabs">' + tabs.map(function (t) {
        const active = t.tab === activeTab;
        return '<li><a class="gs-subtab' + (active ? ' is-active' : '') + '" href="' + esc(G.router.format({ name: 'settings', gid: gd.guild.id, tab: t.tab })) + '"' + (active ? ' aria-current="page"' : '') + '>' + esc(t.label) + '</a></li>';
      }).join('') + '</ul></nav>' + innerHtml + '</div>';
  }

  // Shown at the top of a guild's pages when the viewer can claim it (/auth/me create.claimable lists it).
  function claimNoticeHtml(ctx) {
    const list = ctx.me && ctx.me.create && Array.isArray(ctx.me.create.claimable) ? ctx.me.create.claimable : [];
    const gid = ctx.guildData && ctx.guildData.guild ? ctx.guildData.guild.id : null;
    if (!gid || !list.some(function (c) { return c && c.guildId === gid; })) return '';
    return '<div class="gs-notice gs-claim-banner" role="status"><span>This guild has no Guild Master. You can claim it.</span><a href="' + esc(baseOf(ctx) + '#/new') + '">Claim it on Create guild</a></div>';
  }

  // The HTML for every slot of the page skeleton.
  function slots(ctx) {
    return {
      rail: railHtml(ctx),
      sidebar: sidebarHtml(ctx),
      lead: leadHtml(ctx),
      account: accountSlotHtml(ctx),
      banner: sectionOf(ctx) === 'guild' && guildOf(ctx) ? claimNoticeHtml(ctx) : '',
      tabs: tabsHtml(ctx),
      drawer: drawerHtml(ctx),
    };
  }

  // Every slot in page order plus the main HTML, as one string: for tests and previews (the page itself writes
  // each slot into its own element and never replaces the planner's markup).
  function render(ctx, mainHtml) {
    const s = slots(ctx);
    return s.rail + s.sidebar + '<header class="gs-topbar">' + s.lead + s.account + '</header>' + s.banner +
      '<main class="gs-main" id="gs-main">' + (mainHtml || '') + '</main>' + s.tabs + s.drawer;
  }

  G.shell = {
    hasAction: hasAction,
    canSeeSettings: canSeeSettings,
    settingsTabs: settingsTabs,
    activeTeams: activeTeams,
    navItems: navItems,
    helpItems: helpItems,
    sidebarItems: sidebarItems,
    tabItems: tabItems,
    hasTiles: hasTiles,
    rosterBadge: rosterBadge,
    attendanceBadge: attendanceBadge,
    allowsTeam: allowsTeam,
    breadcrumbItems: breadcrumbItems,
    settingsFrameHtml: settingsFrameHtml,
    accountMenuHtml: accountMenuHtml,
    sidebarHtml: sidebarHtml,
    phonePickHtml: phonePickHtml,
    claimNoticeHtml: claimNoticeHtml,
    slots: slots,
    render: render,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
