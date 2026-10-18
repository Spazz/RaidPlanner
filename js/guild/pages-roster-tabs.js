// ── PAGE PIECE: THE ROSTER'S TABS ───────────────────────────────
// The strip under the Roster heading: Roster (the list), Intent (the class and spec intent board; everyone), Launch (the launch funnel; a Forever guild or a
// launch team), Recruiting (recruitment needs) and Applications (the inbox), the last two for people who can edit a roster. Each tab is a route of its own (router.js ROSTER_TABS).
(function (G) {
  'use strict';

  const LABELS = { roster: 'Roster', intent: 'Intent', recruiting: 'Recruiting', applications: 'Applications', launch: 'Launch' };

  // -> [{ tab, label }] for this viewer (gd.me.can), in the order the strip shows them.
  function tabsFor(gd) {
    const edits = G.shell.hasAction(gd && gd.me && gd.me.can, 'roster.edit');
    // Launch (wave 8): a WoW Forever guild, or a team marked as a launch team (G.pages.launch.offered).
    const launch = G.pages.launch && G.pages.launch.offered(gd) ? ['launch'] : [];
    return ['roster', 'intent'].concat(launch, edits ? ['recruiting', 'applications'] : []).map(function (tab) { return { tab: tab, label: LABELS[tab] }; });
  }

  function hrefOf(gid, tab) {
    return tab === 'roster' ? G.router.format({ name: 'section', gid: gid, section: 'roster' }) : G.router.format({ name: tab, gid: gid });
  }

  // active: 'roster' | 'intent' | 'recruiting' | 'applications'. count: the New applications waiting (a number beside the Applications tab), 0 = none.
  function html(gd, active, count) {
    const gid = gd.guild.id;
    const n = Number(count) > 0 ? Math.floor(Number(count)) : 0;
    return '<nav aria-label="Roster sections"><ul class="gs-subtabs gs-roster-tabs">' + tabsFor(gd).map(function (t) {
      const on = t.tab === active;
      const badge = t.tab === 'applications' && n ? ' <span class="gs-tab-count" aria-label="' + esc(n + (n === 1 ? ' new application' : ' new applications')) + '">' + esc(n) + '</span>' : '';
      return '<li><a class="gs-subtab' + (on ? ' is-active' : '') + '" href="' + esc(hrefOf(gid, t.tab)) + '"' + (on ? ' aria-current="page"' : '') + '>' + esc(t.label) + badge + '</a></li>';
    }).join('') + '</ul></nav>';
  }

  G.pages.rosterTabs = { LABELS: LABELS, tabsFor: tabsFor, html: html, hrefOf: hrefOf };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
