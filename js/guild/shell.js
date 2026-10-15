// ── APP SHELL ───────────────────────────────────────────────────
// Guild rail, labelled sidebar (collapsible to an icon rail), breadcrumb, avatar menu, phone bottom tabs and
// the More drawer. Pure string builders: render(ctx, mainHtml) returns the whole page; app.js wires the events.
//   ctx = { me, route, guildData, teamId, collapsed }
//   me: the /auth/me response; guildData: the GET /api/guild/:gid response (or null outside a guild).
(function (G) {
  'use strict';

  const ic = function (name, size) { return G.icons.icon(name, size); };

  // `can` maps an action to "guild" or a list of team IDs; an absent action (or an empty list) is not allowed.
  function hasAction(can, action) {
    if (!can || !Object.prototype.hasOwnProperty.call(can, action)) return false;
    const v = can[action];
    return v === 'guild' || (Array.isArray(v) && v.length > 0);
  }

  function canSeeSettings(can) {
    return hasAction(can, 'guild.teams') || hasAction(can, 'guild.access') || hasAction(can, 'guild.roles');
  }

  // The Guild settings tabs this viewer may open (People and roles needs access or roles).
  function settingsTabs(can) {
    const tabs = [];
    if (hasAction(can, 'guild.teams')) tabs.push({ tab: 'teams', label: 'Teams' });
    if (hasAction(can, 'guild.access') || hasAction(can, 'guild.roles')) tabs.push({ tab: 'people', label: 'People and roles' });
    return tabs;
  }

  function activeTeams(teams) {
    return (Array.isArray(teams) ? teams : []).filter(function (t) { return t && !t.archived; });
  }

  function guildHref(gid, section) { return G.router.format({ name: 'section', gid: gid, section: section }); }

  function navItems(gid, can) {
    const items = [
      { key: 'roster', label: 'Roster', short: 'Roster', icon: 'roster', href: guildHref(gid, 'roster') },
      { key: 'nights', label: 'Raid nights', short: 'Nights', icon: 'nights', href: guildHref(gid, 'nights') },
      { key: 'attendance', label: 'Attendance', short: 'Attendance', icon: 'attendance', href: guildHref(gid, 'attendance') },
      { key: 'loot', label: 'Loot', short: 'Loot', icon: 'loot', href: guildHref(gid, 'loot') },
      { key: 'planner', label: 'Planner', short: 'Planner', icon: 'planner', href: '/' },
    ];
    if (canSeeSettings(can)) {
      const first = settingsTabs(can)[0];
      items.push({ key: 'settings', label: 'Guild settings', short: 'Settings', icon: 'settings', separated: true,
        href: G.router.format({ name: 'settings', gid: gid, tab: first ? first.tab : null }) });
    }
    return items;
  }

  function isActiveItem(item, route) {
    if (!route) return false;
    if (item.key === 'settings') return route.name === 'settings';
    return route.name === 'section' && route.section === item.key;
  }

  function navListHtml(items, route) {
    return '<ul class="gs-nav-list">' + items.map(function (item) {
      const active = isActiveItem(item, route);
      const sep = item.separated ? '<li class="gs-nav-sep" role="separator"></li>' : '';
      return sep + '<li><a class="gs-nav-link' + (active ? ' is-active' : '') + '" href="' + esc(item.href) + '" aria-label="' + esc(item.label) + '"' + (active ? ' aria-current="page"' : '') + '>' +
        ic(item.icon, 20) + '<span class="gs-label-full">' + esc(item.label) + '</span><span class="gs-label-short" aria-hidden="true">' + esc(item.short) + '</span></a></li>';
    }).join('') + '</ul>';
  }

  function tilesHtml(me, activeGid, route) {
    const guilds = me && Array.isArray(me.guilds) ? me.guilds : [];
    const canCreate = !!(me && me.create && me.create.allowed);
    const tiles = guilds.map(function (g) {
      const active = g.id === activeGid;
      return '<li><a class="gs-tile' + (active ? ' is-active' : '') + '" href="' + esc(guildHref(g.id, 'roster')) + '" aria-label="' + esc(g.name) + '" title="' + esc(g.name) + '"' + (active ? ' aria-current="true"' : '') + '>' + esc(G.ui.initials(g.name)) + '</a></li>';
    });
    if (canCreate) {
      const onNew = route && route.name === 'new';
      tiles.push('<li><a class="gs-tile gs-tile-add' + (onNew ? ' is-active' : '') + '" href="#/new" aria-label="Add a guild" title="Add a guild"' + (onNew ? ' aria-current="page"' : '') + '>' + ic('plus', 20) + '</a></li>');
    }
    return tiles.length ? '<ul class="gs-tiles">' + tiles.join('') + '</ul>' : '';
  }

  function teamSelectHtml(teams, teamId, id) {
    const active = activeTeams(teams);
    if (!active.length) return '';
    return '<label class="gs-sr" for="' + esc(id) + '">Team</label><span class="gs-select-wrap"><select class="gs-team-select" id="' + esc(id) + '" data-change="team-pick" data-key="team-pick">' +
      active.map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === teamId ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
      '</select>' + ic('chevronDown', 18) + '</span>';
  }

  function guildHeadHtml(ctx, selectId) {
    const g = ctx.guildData.guild;
    return '<div class="gs-side-head"><div class="gs-side-guild"><span class="gs-side-name">' + esc(g.name) + '</span><span class="gs-side-realm">' + esc(g.realm) + '</span></div>' +
      '<div><span class="gs-badge">' + esc(G.ui.gameVersionLabel(g.gameVersion)) + '</span></div>' +
      teamSelectHtml(ctx.guildData.teams, ctx.teamId, selectId) + '</div>';
  }

  // The phone header's team picker; a guild with no active team shows its name instead.
  function phonePickHtml(ctx) {
    const select = teamSelectHtml(ctx.guildData.teams, ctx.teamId, 'gs-team-select-phone');
    return '<div class="gs-phone-pick">' + (select || '<span class="gs-phone-guild">' + esc(ctx.guildData.guild.name) + '</span>') + '</div>';
  }

  function sidebarHtml(ctx) {
    const gd = ctx.guildData;
    const collapsed = !!ctx.collapsed;
    return '<aside class="gs-sidebar" aria-label="Guild navigation">' + guildHeadHtml(ctx, 'gs-team-select') +
      '<nav aria-label="Main">' + navListHtml(navItems(gd.guild.id, gd.me && gd.me.can), ctx.route) + '</nav>' +
      '<div class="gs-side-foot"><button type="button" class="gs-collapse" data-action="toggle-sidebar" data-key="toggle-sidebar" aria-expanded="' + (collapsed ? 'false' : 'true') + '" aria-label="' + (collapsed ? 'Expand sidebar' : 'Collapse sidebar') + '">' +
      ic(collapsed ? 'expand' : 'collapse', 20) + '<span class="gs-label-full">' + (collapsed ? 'Expand' : 'Collapse') + '</span></button></div></aside>';
  }

  function drawerHtml(ctx) {
    const gd = ctx.guildData;
    return '<dialog class="gs-drawer" id="gs-drawer" aria-label="Main menu"><div class="gs-drawer-rail">' + G.icons.logo + tilesHtml(ctx.me, gd.guild.id, ctx.route) + '</div>' +
      '<div class="gs-drawer-panel"><div class="gs-drawer-top"><button type="button" class="gs-icon-btn" data-action="close-drawer" aria-label="Close menu">' + ic('close', 20) + '</button></div>' +
      guildHeadHtml(ctx, 'gs-team-select-drawer') +
      '<nav aria-label="Main">' + navListHtml(navItems(gd.guild.id, gd.me && gd.me.can), ctx.route) + '</nav></div></dialog>';
  }

  function tabsHtml(ctx) {
    const gid = ctx.guildData.guild.id;
    const items = navItems(gid, null).filter(function (i) { return i.key !== 'planner'; });
    return '<nav class="gs-tabs" aria-label="Main"><ul class="gs-tabs-list">' + items.map(function (item) {
      const active = isActiveItem(item, ctx.route);
      return '<li><a class="gs-tab' + (active ? ' is-active' : '') + '" href="' + esc(item.href) + '" aria-label="' + esc(item.label) + '"' + (active ? ' aria-current="page"' : '') + '>' +
        ic(item.icon, 22) + '<span aria-hidden="true">' + esc(item.short) + '</span></a></li>';
    }).join('') + '<li><button type="button" class="gs-tab" data-action="open-drawer" data-key="more-tab" aria-haspopup="dialog" aria-label="More">' + ic('more', 22) + '<span aria-hidden="true">More</span></button></li></ul></nav>';
  }

  // ── breadcrumb ──
  function breadcrumbItems(ctx) {
    const r = ctx.route || {};
    const gd = ctx.guildData;
    const crumbs = [];
    if (r.name === 'new') return [{ label: 'Create a guild' }];
    if (r.name === 'privacy') return [{ label: 'Privacy & my data' }];
    if (!gd || !gd.guild) return [{ label: 'Raidsmith' }];
    crumbs.push({ label: gd.guild.name, href: guildHref(gd.guild.id, 'roster') });
    if (r.name === 'section') {
      const team = activeTeams(gd.teams).filter(function (t) { return t.id === ctx.teamId; })[0];
      if (team) crumbs.push({ label: team.name });
      crumbs.push({ label: { roster: 'Roster', nights: 'Raid nights', attendance: 'Attendance', loot: 'Loot' }[r.section] || 'Roster' });
    } else if (r.name === 'settings') {
      const tabs = settingsTabs(gd.me && gd.me.can);
      const first = tabs[0];
      crumbs.push({ label: 'Guild settings', href: G.router.format({ name: 'settings', gid: gd.guild.id, tab: first ? first.tab : null }) });
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
      '<a class="gs-menu-item" role="menuitem" href="#/privacy">' + ic('lock', 20) + '<span>Privacy &amp; my data</span></a>' +
      '<a class="gs-menu-item" role="menuitem" href="/">' + ic('planner', 20) + '<span>Open the planner</span></a>' +
      '<button type="button" class="gs-menu-item" role="menuitem" data-action="sign-out">' + ic('logout', 20) + '<span>Sign out</span></button>' +
      '</div></div>';
  }

  // The header shown to signed-out visitors (Sign in board).
  function publicHeaderHtml() {
    return '<header class="gs-public-head"><a class="gs-brand" href="#/">' + G.icons.logo + '<span class="gs-brand-name">Raidsmith</span></a>' +
      '<div class="gs-public-links"><a class="gs-planner-link" href="/">Planner</a>' +
      '<a class="gs-btn gs-btn-molten" href="/auth/login">' + ic('login', 18) + '<span>Sign in with Discord</span></a></div></header>';
  }

  // ── Guild settings frame: title, tab strip, then the tab's content ──
  function settingsFrameHtml(ctx, activeTab, innerHtml) {
    const gd = ctx.guildData;
    const tabs = settingsTabs(gd.me && gd.me.can);
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Guild settings</h1><p class="gs-sub">' + esc(gd.guild.name) + ' - ' + esc(gd.guild.realm) + '</p></div>' +
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
    return '<div class="gs-notice gs-claim-banner" role="status"><span>This guild has no Guild Master. You can claim it.</span><a href="#/new">Claim it on Create guild</a></div>';
  }

  // The whole signed-in page. A guild context (ctx.guildData) adds the sidebar, phone tabs and drawer.
  function render(ctx, mainHtml) {
    const hasGuild = !!(ctx.guildData && ctx.guildData.guild);
    const crumbs = breadcrumbItems(ctx);
    // Phone header follows board B-Phone: logo, team picker, avatar menu. More (bottom tab) opens the drawer.
    const phoneTitle = '<span class="gs-phone-brand">' + G.icons.logo + '</span>' + (hasGuild ? phonePickHtml(ctx) : '');
    return '<div class="gs-app' + (ctx.collapsed && hasGuild ? ' is-collapsed' : '') + (hasGuild ? ' has-guild' : '') + '">' +
      '<aside class="gs-rail" aria-label="Guilds"><div class="gs-rail-logo">' + G.icons.logo + '</div><div class="gs-rail-line" aria-hidden="true"></div>' + tilesHtml(ctx.me, hasGuild ? ctx.guildData.guild.id : null, ctx.route) + '</aside>' +
      (hasGuild ? sidebarHtml(ctx) : '') +
      '<div class="gs-col"><header class="gs-topbar">' + phoneTitle + '<div class="gs-crumbs-wrap">' + breadcrumbHtml(crumbs) + '</div>' + accountMenuHtml(ctx) + '</header>' +
      '<main class="gs-main" id="gs-main">' + (hasGuild ? claimNoticeHtml(ctx) : '') + mainHtml + '</main></div>' +
      (hasGuild ? tabsHtml(ctx) + drawerHtml(ctx) : '') + '</div>';
  }

  G.shell = {
    hasAction: hasAction,
    canSeeSettings: canSeeSettings,
    settingsTabs: settingsTabs,
    activeTeams: activeTeams,
    navItems: navItems,
    breadcrumbItems: breadcrumbItems,
    publicHeaderHtml: publicHeaderHtml,
    settingsFrameHtml: settingsFrameHtml,
    accountMenuHtml: accountMenuHtml,
    sidebarHtml: sidebarHtml,
    phonePickHtml: phonePickHtml,
    claimNoticeHtml: claimNoticeHtml,
    render: render,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
