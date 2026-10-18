// -- PAGE: THE READ-ONLY VIEW (GUEST LINK AND PUBLIC PAGE) -------
// What a visitor with no account sees: a guild's roster, raids, attendance and loot, read-only, for the sections their one role (a guest link) or the
// public page allows. Three addresses lead here: #/guest/<token> (redeems the link, then moves to #/view so the token leaves the address bar and the
// history), #/view (the guest cookie's view) and #/public/<gid>. No sign-in, no account, nothing to change; the Worker sends only names, classes, dates,
// percentages and loot awards. GET /api/guest, GET /api/public/:gid, POST /auth/guest, DELETE /auth/guest.
(function (G) {
  'use strict';

  const SECTION_ORDER = ['roster', 'raids', 'attendance', 'loot'];
  const SECTION_TITLES = { roster: 'Roster', raids: 'Raids', attendance: 'Attendance', loot: 'Loot' };
  const ASK_NEW_LINK = 'Ask the officer who sent it for a new link.';
  const NOTHING = 'Nothing is shared here yet.';
  const BADGES = { guest: 'Read-only guest view', public: 'Public page' };

  function st() { return G.app.state; }
  function listOf(v) { return Array.isArray(v) ? v : []; }

  // -- error cards --
  // error: an ApiError, { status, code, message | text }, or a plain message. A guest link that no longer works (turned off, expired, never made) gets
  // the advice to ask for a new one, unless the server's own words already say so; a failed connection offers Try again.
  function errorParts(error, kind) {
    const e = typeof error === 'string' ? { message: error } : (error || {});
    const text = String(e.text || e.message || 'Something went wrong. Try again in a moment.');
    const status = typeof e.status === 'number' ? e.status : null;
    const network = status === 0 || e.code === 'network';
    const server = status !== null && status >= 500;
    const guestLink = kind === 'guest' && !network && !server;
    let title = 'Could not open this page';
    if (network) title = 'Could not reach Raidsmith';
    else if (guestLink) title = 'This guest link does not work';
    else if (kind === 'public' && status === 404) title = 'No public page here';
    const advice = guestLink && !/\bask\b[^.]*\bnew\b/i.test(text) ? ' ' + ASK_NEW_LINK : '';
    return { title: title, text: text + advice, retry: network || server };
  }

  function errorHtml(error, kind) {
    const p = errorParts(error, kind);
    return G.pages.signin.messageHtml(p.title, p.text, { retry: p.retry });
  }

  // -- page header --
  function whereText(guild) {
    const g = guild || {};
    const line = G.ui.realmLine(g);
    return (g.realmKind === 'ruleset' || !g.region ? line : line + ' (' + g.region + ')') + (g.gameVersion ? ' - ' + G.ui.gameVersionLabel(g.gameVersion) : '');
  }

  function guestMetaHtml(viewer) {
    const role = viewer.role && viewer.role.name ? viewer.role.name : 'Guest';
    const team = viewer.team && viewer.team.name ? viewer.team.name + ' only' : 'Whole guild';
    const until = typeof viewer.expiresAt === 'number' ? 'Link works until ' + G.ui.formatDate(viewer.expiresAt) : 'This link does not expire';
    return '<ul class="gs-view-meta" aria-label="About this link"><li>Role: ' + esc(role) + '</li><li>' + esc(team) + '</li><li>' + esc(until) + '</li></ul>';
  }

  function headHtml(data, kind) {
    const viewer = data.viewer || {};
    const guest = (viewer.kind || kind) === 'guest';
    return '<div class="gs-page-head gs-view-head"><div><h1 class="gs-h1" tabindex="-1">' + esc(data.guild && data.guild.name) + '</h1><p class="gs-sub">' + esc(whereText(data.guild)) + '</p></div>' +
      '<div class="gs-view-badges"><span class="gs-badge">' + esc(guest ? BADGES.guest : BADGES.public) + '</span>' +
      (guest ? '<button type="button" class="gs-btn gs-btn-sm" data-action="view-leave" data-key="view-leave">Leave</button>' : '') + '</div></div>' +
      (guest ? guestMetaHtml(viewer) + '<p class="gs-alert" id="view-alert" role="alert" hidden></p>' : '');
  }

  // -- sections --
  function tableHtml(label, columns, rows) {
    return '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-view" aria-label="' + esc(label) + '"><thead><tr>' +
      columns.map(function (c) { return '<th scope="col">' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }

  function teamName(entry) { return entry && entry.team && entry.team.name ? entry.team.name : 'Team'; }

  function rosterBlock(entry) {
    const people = listOf(entry.people);
    if (!people.length) return '<p class="gs-empty">No one on the roster yet.</p>';
    return tableHtml('Roster of ' + teamName(entry), ['Name', 'Class', 'Role'], people.map(function (p) {
      const role = G.ui.roleLabel(p.role);
      return '<tr><th scope="row" class="gs-cell-strong">' + G.ui.classNameHtml(p.name, p.class) + '</th><td data-label="Class">' + esc(G.ui.className(p.class)) + '</td>' +
        '<td data-label="Role">' + (role ? G.ui.roleDotHtml(p.role) + ' ' + esc(role) : '<span class="gs-muted">-</span>') + '</td></tr>';
    }));
  }

  function raidRows(raids) {
    return raids.map(function (r) {
      return '<tr><th scope="row" class="gs-cell-strong">' + esc(G.ui.weekdayDay(r.raidOn)) + '</th><td data-label="Zone">' + esc(r.zone) + '</td>' +
        '<td data-label="Title">' + (r.title ? esc(r.title) : '<span class="gs-muted">-</span>') + '</td></tr>';
    });
  }

  function raidsBlock(entry) {
    const upcoming = listOf(entry.upcoming);
    const recent = listOf(entry.recent);
    const part = function (heading, raids, none) {
      return '<h4 class="gs-view-sub">' + esc(heading) + '</h4>' +
        (raids.length ? tableHtml(heading + ' raids of ' + teamName(entry), ['Date', 'Zone', 'Title'], raidRows(raids)) : '<p class="gs-empty">' + esc(none) + '</p>');
    };
    return part('Upcoming', upcoming, 'No upcoming raids.') + part('Recent', recent, 'No recent raids.');
  }

  function windowText(win, raids) {
    const n = Number(raids) || 0;
    return (win === 'all' ? 'Counting all time' : 'Counting the last ' + G.ui.plural(Number(win) || 0, 'week', 'weeks')) + ' (' + G.ui.plural(n, 'raid', 'raids') + ').';
  }

  function attendanceBlock(entry) {
    const people = listOf(entry.people);
    return '<p class="gs-fine gs-view-window">' + esc(windowText(entry.window, entry.raids)) + '</p>' +
      (people.length
        ? tableHtml('Attendance of ' + teamName(entry), ['Name', 'Attendance', 'Raids counted'], people.map(function (p) {
          return '<tr><th scope="row" class="gs-cell-strong">' + G.ui.classNameHtml(p.name, p.class) + '</th><td data-label="Attendance" class="gs-num">' + esc(G.ui.percent(p.pct)) + '</td>' +
            '<td data-label="Raids counted">' + esc(G.ui.plural(Number(p.counted) || 0, 'raid', 'raids') + ' counted') + '</td></tr>';
        }))
        : '<p class="gs-empty">No attendance to show yet.</p>');
  }

  function qualityClass(q) { return typeof q === 'number' && q >= 0 && q <= 7 && Math.floor(q) === q ? ' gs-q-' + q : ''; }

  function lootBlock(entry) {
    const awards = listOf(entry.awards);
    if (!awards.length) return '<p class="gs-empty">No loot awarded yet.</p>';
    return tableHtml('Loot of ' + teamName(entry), ['Item', 'Winner', 'Awarded'], awards.map(function (a) {
      const winner = a.disenchanted ? '<span class="gs-muted">Disenchanted</span>' : (a.winner ? G.ui.classNameHtml(a.winner, a.winnerClass) : '<span class="gs-muted">-</span>');
      return '<tr><th scope="row" class="gs-cell-strong"><span class="gs-item' + qualityClass(a.quality) + '">' + esc(a.itemName) + '</span></th><td data-label="Winner">' + winner + '</td>' +
        '<td data-label="Awarded">' + esc(G.ui.formatDateTime(a.awardedAt)) + '</td></tr>';
    }));
  }

  const BLOCKS = { roster: rosterBlock, raids: raidsBlock, attendance: attendanceBlock, loot: lootBlock };

  function sectionHtml(key, entries) {
    const id = 'view-' + key + '-h';
    const list = listOf(entries);
    return '<section class="gs-section gs-view-section" aria-labelledby="' + id + '"><div class="gs-section-head"><h2 class="gs-h2" id="' + id + '">' + esc(SECTION_TITLES[key]) + '</h2></div>' +
      (list.length
        ? list.map(function (entry) { return '<div class="gs-view-team"><h3 class="gs-h3">' + esc(teamName(entry)) + '</h3>' + BLOCKS[key](entry) + '</div>'; }).join('')
        : '<p class="gs-empty">Nothing to show here yet.</p>') + '</section>';
  }

  // opts: { data (GET /api/guest or /api/public/:gid, or null while loading), kind ('guest' | 'public'), error }
  function viewHtml(opts) {
    const o = opts || {};
    const kind = o.kind || (o.data && o.data.viewer && o.data.viewer.kind) || 'guest';
    if (o.error) return errorHtml(o.error, kind);
    if (!o.data) return G.pages.signin.loadingHtml();
    const data = o.data;
    const sections = data.sections && typeof data.sections === 'object' ? data.sections : {};
    const shown = SECTION_ORDER.filter(function (k) { return Object.prototype.hasOwnProperty.call(sections, k); });
    return '<div class="gs-page gs-view">' + headHtml(data, kind) +
      (shown.length ? shown.map(function (k) { return sectionHtml(k, sections[k]); }).join('') : '<p class="gs-empty" id="view-empty">' + esc(NOTHING) + '</p>') + '</div>';
  }

  // Moves a redeemed link's address to #/view: the token leaves the address bar and the history entry (replaceState, no new entry).
  function dropToken() {
    try {
      if (typeof window !== 'undefined' && window.history && window.history.replaceState && window.location) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + G.router.format({ name: 'view' }));
      }
    } catch (e) { /* the address keeps the token; the cookie is set either way */ }
  }

  // route: { name: 'guest', token } | { name: 'view' } | { name: 'public', gid }. Always resolves with the state it stored in G.app.state.view:
  // { kind, gid, data, error } - the answer, or the error as { status, code, message } for viewHtml to word.
  function load(route) {
    const r = route || {};
    const kind = r.name === 'public' ? 'public' : 'guest';
    const done = function (data, err) {
      const view = { kind: kind, gid: r.name === 'public' ? r.gid : null, data: data, error: err ? { status: err.status, code: err.code, message: err.message } : null };
      st().view = view;
      return view;
    };
    let call;
    if (r.name === 'guest') {
      call = G.api.guests.redeem(r.token).then(function () {
        dropToken();
        return G.api.guests.view();
      });
    } else if (r.name === 'public') {
      call = G.api.publicPage.view(r.gid);
    } else {
      call = G.api.guests.view();
    }
    return call.then(function (data) { return done(data, null); }, function (err) { return done(null, err); });
  }

  G.handlers.click['view-leave'] = function (el) {
    el.disabled = true;
    G.api.guests.leave().then(function () {
      st().view = null;
      G.app.go(G.router.format({ name: 'home' }));
    }, function (err) {
      el.disabled = false;
      G.ui.setText('view-alert', G.api.classify(err).text);
    });
  };

  G.pages.view = { ASK_NEW_LINK: ASK_NEW_LINK, NOTHING: NOTHING, errorParts: errorParts, viewHtml: viewHtml, load: load };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
