// ── PAGES: USERS (lane B8a-base stub; the Users lane fills it) ──
// #/g/:gid/users[/<segment>] is the Users list (template T1) and #/g/:gid/users/u/:key one user (template T2), for whoever holds guild.access (shell.js canSeeUsers; app.js checks it
// before the page loads). The Worker side is GET /api/guild/:gid/users and /users/:ukey (worker/routes/users.js).
// What the lane fills:
//   G.pages.users.load(r, gd)   reads the list for r.segment (null = the default segment)       G.pages.users.listHtml({ guildData, route })   draws it
//   G.pages.user.load(r, gd)    reads the user r.key                                              G.pages.user.userHtml({ guildData, route })    draws it
// main(r, gd, ctx) is what app.js calls to draw the page; load(r, gd) its read (a promise, or anything: app.js waits for it).
(function (G) {
  'use strict';

  function listHtml(opts) {
    const gd = opts.guildData;
    return G.ui.listPageHtml({
      pageClass: 'gs-users-page gs-forge',
      head: { title: 'Users', context: gd.guild.name },
      bodyHtml: G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: 'No users to show' }),
    });
  }

  function userHtml(opts) {
    const gd = opts.guildData;
    return G.ui.objectPageHtml({
      pageClass: 'gs-user-page gs-forge',
      head: { title: 'User', context: gd.guild.name, back: { href: G.router.format({ name: 'users', gid: gd.guild.id }), label: 'Users' } },
      sections: [{ id: 'user-empty', bare: true, bodyHtml: G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: 'Nothing to show for this user' }) }],
    });
  }

  G.pages.users = {
    load: function () { return Promise.resolve(null); },
    main: function (r, gd) { return listHtml({ guildData: gd, route: r }); },
    listHtml: listHtml,
  };
  G.pages.user = {
    load: function () { return Promise.resolve(null); },
    main: function (r, gd) { return userHtml({ guildData: gd, route: r }); },
    userHtml: userHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
