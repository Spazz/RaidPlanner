// ── PAGE: LOOT (coming next) ──
// The empty-page pattern; the copy says in plain words what the page will bring.
// Roster (Phase 2) and Raids / Attendance (Phase 3) are real pages with their own modules, so they have no stub here.
(function (G) {
  'use strict';

  const PAGES = {
    loot: {
      title: 'Loot',
      icon: 'loot',
      heading: 'Loot tracking comes next',
      lead: 'Soon this page brings your loot into one place:',
      items: [
        'Gargul award history, imported after each raid',
        'ThatsMyBIS prio and wishlists for the guild',
        'softres.it reserves for pugs on the same night',
        'Loot per player, per raid, per item, and loot balance',
      ],
    },
  };

  function emptyHtml(section) {
    const key = Object.prototype.hasOwnProperty.call(PAGES, section) ? section : 'loot';
    const p = PAGES[key];
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">' + esc(p.title) + '</h1></div>' +
      '<section class="gs-empty-card" aria-labelledby="empty-heading-' + key + '"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon(p.icon, 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="empty-heading-' + key + '">' + esc(p.heading) + '</h2><p class="gs-lead gs-lead-sm">' + esc(p.lead) + '</p>' +
      '<ul class="gs-bullets">' + p.items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>' +
      '<p class="gs-fine">Nothing to set up yet.</p></section></div>';
  }

  G.pages.empty = { PAGES: PAGES, emptyHtml: emptyHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
