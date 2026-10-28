// ── PAGE: GUILD SETUP (lane B8a-base stub; the setup lane fills it) ──
// #/g/:gid/setup is the in-game guild flow (template T5): In-game guild, Ranks, Preview, Switch over. It starts from Guild settings > Battle.net and sits under Guild settings
// (crumb "<guild> / Guild settings / Guild setup", shell.js). The Worker side is the pin, the rank map and the flip (worker/routes/bnet.js, worker/routes/flip.js); the pin and the switch
// want a fresh Battle.net sign-in (Guild.fresh, purposes pin and source_switch).
// What the lane fills:
//   G.pages.setup.load(r, gd)   reads what the flow needs      G.pages.setup.setupHtml({ guildData, route })   draws the page
// main(r, gd, ctx) is what app.js calls to draw the page; load(r, gd) its read (a promise, or anything: app.js waits for it).
(function (G) {
  'use strict';

  const STEPS = ['In-game guild', 'Ranks', 'Preview', 'Switch over'];

  function setupHtml(opts) {
    const gd = opts.guildData;
    return G.ui.flowPageHtml({
      pageClass: 'gs-setup-page gs-forge',
      head: { title: 'Guild setup', context: gd.guild.name, back: { href: G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'battlenet' }), label: 'Battle.net' } },
      steps: STEPS, current: 1, stepsLabel: 'Guild setup steps',
      bodyHtml: G.ui.emptyStateHtml({ kind: 'first', icon: 'link', title: 'Nothing to set up yet' }),
    });
  }

  G.pages.setup = {
    STEPS: STEPS,
    load: function () { return Promise.resolve(null); },
    main: function (r, gd) { return setupHtml({ guildData: gd, route: r }); },
    setupHtml: setupHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
