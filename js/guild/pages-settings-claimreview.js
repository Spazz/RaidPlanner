// ── PAGE: GUILD SETTINGS > OWNER REVIEW (lane B8a-base stub; the Owner lane fills it) ──
// The new Owner's page after a Guild Master claim (template T3): what the previous Owner set up and left live. The tab is shown only to the Owner while GET /api/guild/:gid says
// owner.reviewOpen (shell.js settingsTabs); the Home item claim_review links here. The Worker side: GET /api/guild/:gid/claim-review (worker/routes/claim-review.js) and the
// dismissal of the Home item (POST /attention/dismissals, item id claim_review).
// What the lane fills:
//   G.pages.settingsClaimReview.load(r, gd)   reads the review      G.pages.settingsClaimReview.settingsHtml({ guildData })   draws the page body
// main(r, gd, ctx) is what app.js calls to draw the page; load(r, gd) its read (a promise, or anything: app.js waits for it).
(function (G) {
  'use strict';

  function settingsHtml() {
    return '<section class="gs-section" aria-labelledby="settings-title">' + G.ui.emptyStateHtml({ kind: 'first', icon: 'check', title: 'Nothing to review' }) + '</section>';
  }

  G.pages.settingsClaimReview = {
    load: function () { return Promise.resolve(null); },
    main: function (r, gd, ctx) { return G.shell.settingsFrameHtml(ctx, 'claimreview', settingsHtml({ guildData: gd })); },
    settingsHtml: settingsHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
