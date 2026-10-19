// ── PAGE PIECE: THE ROSTER'S TABS ───────────────────────────────
// The strip under the Roster heading: Roster (the list), Spec poll (the class and spec poll; everyone) and Recruiting (applications and the role gaps; people who can
// edit a roster, with the number of New applications beside it). Each is a route of its own (router.js ROSTER_TABS). The Applications route is the old name of
// the Recruiting tab and highlights it; the Launch list is a page of its own opened from the Spec poll (its back link says so), not a tab.
(function (G) {
  'use strict';

  const LABELS = { roster: 'Roster', intent: 'Spec poll', recruiting: 'Recruiting', applications: 'Recruiting', launch: 'Launch' };
  // The route a page belongs to for the strip: old and sub-pages light up the tab they hang under.
  const TAB_OF = { applications: 'recruiting', launch: 'intent' };

  // -> [{ tab, label }] for this viewer (gd.me.can), in the order the strip shows them.
  function tabsFor(gd) {
    const edits = G.shell.hasAction(gd && gd.me && gd.me.can, 'roster.edit');
    return ['roster', 'intent'].concat(edits ? ['recruiting'] : []).map(function (tab) { return { tab: tab, label: LABELS[tab] }; });
  }

  function hrefOf(gid, tab) {
    return tab === 'roster' ? G.router.format({ name: 'section', gid: gid, section: 'roster' }) : G.router.format({ name: tab, gid: gid });
  }

  // The New applications waiting for the team on screen (gd.applicationFlags, sent to people who can edit that team's roster).
  function applicationCount(gd) {
    const flags = gd && gd.applicationFlags;
    if (!flags || typeof flags !== 'object') return 0;
    const teamId = G.app && G.app.teamFor ? G.app.teamFor(gd) : null;
    const n = teamId && Object.prototype.hasOwnProperty.call(flags, teamId) ? Number(flags[teamId]) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // active: 'roster' | 'intent' | 'recruiting' | 'applications' | 'launch'. count: the New applications beside the Recruiting tab; left out, it is read from the guild data.
  function html(gd, active, count) {
    const gid = gd.guild.id;
    const given = Number(count);
    const n = count === undefined || count === null ? applicationCount(gd) : (given > 0 ? Math.floor(given) : 0);
    const current = TAB_OF[active] || active;
    return '<nav aria-label="Roster sections"><ul class="gs-subtabs gs-roster-tabs">' + tabsFor(gd).map(function (t) {
      const on = t.tab === current;
      const badge = t.tab === 'recruiting' && n ? ' <span class="gs-tab-count" aria-label="' + esc(n + (n === 1 ? ' new application' : ' new applications')) + '">' + esc(n) + '</span>' : '';
      return '<li><a class="gs-subtab' + (on ? ' is-active' : '') + '" href="' + esc(hrefOf(gid, t.tab)) + '"' + (on ? ' aria-current="page"' : '') + '>' + esc(t.label) + badge + '</a></li>';
    }).join('') + '</ul></nav>';
  }

  // The head of every Roster page (design framework T1): the page head ("Roster", the team and the tab's name) and the tab strip under it.
  function headHtml(gd, active, teamName, extra) {
    const label = active === 'roster' ? '' : LABELS[active] || '';
    // The Spec poll and Recruiting heads carry the Roster's one More menu (the imports) for people who can edit the roster.
    const more = (active === 'intent' || active === 'recruiting') && G.shell.hasAction(gd && gd.me && gd.me.can, 'roster.edit') && G.pages.roster && G.pages.roster.importItems
      ? { id: 'roster-more', key: 'roster-more', items: G.pages.roster.importItems(gd.guild.id) } : null;
    return G.ui.pageHeadHtml(Object.assign({ title: 'Roster', context: [teamName, label].filter(Boolean).join(' - '), more: more }, extra || {})) + html(gd, active);
  }

  G.pages.rosterTabs = { LABELS: LABELS, tabsFor: tabsFor, html: html, headHtml: headHtml, hrefOf: hrefOf, applicationCount: applicationCount };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
