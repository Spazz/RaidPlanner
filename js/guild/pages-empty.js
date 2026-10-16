// ── PAGES: RAID NIGHTS, ATTENDANCE, LOOT (coming next) ──
// These three share one empty-page pattern; the copy says in plain words what each will bring.
// The Roster page is real as of Phase 2 (pages-roster.js), so it has no stub here.
(function (G) {
  'use strict';

  const PAGES = {
    nights: {
      title: 'Raid nights',
      icon: 'nights',
      heading: 'Raid nights come next',
      lead: 'Soon this page shows each raid night:',
      items: [
        'The Raid-Helper sign-ups for the night',
        'The Warcraft Logs report for the night',
        'The raid plan for the night',
      ],
    },
    attendance: {
      title: 'Attendance',
      icon: 'attendance',
      heading: 'Attendance comes next',
      lead: 'Soon this page tracks who showed up:',
      items: [
        'Attendance for each person',
        'Attendance for each team',
      ],
    },
    loot: {
      title: 'Loot',
      icon: 'loot',
      heading: 'Loot tracking comes next',
      lead: 'Soon this page brings your loot into one place:',
      items: [
        'Gargul award history, imported after each raid',
        'ThatsMyBIS prio and wishlists for the guild',
        'softres.it reserves for pugs on the same night',
        'Loot per player, per raid night, per item, and loot balance',
      ],
    },
  };

  function emptyHtml(section) {
    const key = Object.prototype.hasOwnProperty.call(PAGES, section) ? section : 'nights';
    const p = PAGES[key];
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">' + esc(p.title) + '</h1></div>' +
      '<section class="gs-empty-card" aria-labelledby="empty-heading-' + key + '"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon(p.icon, 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="empty-heading-' + key + '">' + esc(p.heading) + '</h2><p class="gs-lead gs-lead-sm">' + esc(p.lead) + '</p>' +
      '<ul class="gs-bullets">' + p.items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>' +
      '<p class="gs-fine">Nothing to set up yet.</p></section></div>';
  }

  G.pages.empty = { PAGES: PAGES, emptyHtml: emptyHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
