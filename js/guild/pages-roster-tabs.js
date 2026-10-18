// ── PAGE PIECE: THE ROSTER'S TABS ───────────────────────────────
// The strip under the Roster heading: Roster (the list), Spec poll (the class and spec poll; everyone), Launch (the launch funnel; a Forever guild or a
// launch team), Recruiting needs (the role gaps) and Applications (the inbox), the last two for people who can edit a roster. Each tab is a route of its own (router.js ROSTER_TABS).
(function (G) {
  'use strict';

  const LABELS = { roster: 'Roster', intent: 'Spec poll', recruiting: 'Recruiting needs', applications: 'Applications', launch: 'Launch' };

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

  // The head of every Roster page (design framework T1): the page head ("Roster", the team and the tab's name) and the tab strip under it.
  function headHtml(gd, active, teamName, extra) {
    const label = active === 'roster' ? '' : LABELS[active] || '';
    return G.ui.pageHeadHtml(Object.assign({ title: 'Roster', context: [teamName, label].filter(Boolean).join(' - ') }, extra || {})) + html(gd, active, 0);
  }

  G.pages.rosterTabs = { LABELS: LABELS, tabsFor: tabsFor, html: html, headHtml: headHtml, hrefOf: hrefOf };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
