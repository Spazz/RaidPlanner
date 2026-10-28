// ── PAGE: GUILD SETTINGS > LINKS AND KEYS (lane B8a-base stub; the Links lane fills it) ──
// One settings page (template T3) for API keys, guest links and raid join links; it replaces Guest links and Data access (the Links lane retires those two). For whoever holds
// guild.access. The Worker side: /api/guild/:gid/api-keys, /guest-links, /join-links.
// What the lane fills:
//   G.pages.settingsLinks.load(r, gd)   reads the three lists      G.pages.settingsLinks.settingsHtml({ guildData })   draws the page body
// main(r, gd, ctx) is what app.js calls to draw the page; load(r, gd) its read (a promise, or anything: app.js waits for it).
(function (G) {
  'use strict';

  function settingsHtml() {
    return '<section class="gs-section" aria-labelledby="settings-title">' + G.ui.emptyStateHtml({ kind: 'first', icon: 'link', title: 'No links or keys yet' }) + '</section>';
  }

  G.pages.settingsLinks = {
    load: function () { return Promise.resolve(null); },
    main: function (r, gd, ctx) { return G.shell.settingsFrameHtml(ctx, 'links', settingsHtml({ guildData: gd })); },
    settingsHtml: settingsHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
