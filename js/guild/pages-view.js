// -- PAGE: THE READ-ONLY VIEW (GUEST LINK AND PUBLIC PAGE; T1 / T4 with no actions) -------
// What a visitor with no account sees: a guild's roster, raids, attendance and loot, read-only, for the sections their one role (a guest link) or the
// public page allows. Three addresses lead here: #/guest/<token> (redeems the link, then moves to #/view so the token leaves the address bar and the
// history), #/view (the guest cookie's view) and #/public/<gid>. No sign-in, no account, nothing to change; the Worker sends only names, classes, dates,
// percentages, boss kills and loot awards. The page carries the Read-only chip, the guild's zone on every time, and nothing to change (a guest's only action,
// Leave, is in the More menu). GET /api/guest, GET /api/public/:gid, POST /auth/guest, DELETE /auth/guest.
(function (G) {
  'use strict';

  const SECTION_ORDER = ['roster', 'raids', 'progress', 'attendance', 'loot'];
  const SECTION_TITLES = { roster: 'Roster', raids: 'Raids', progress: 'Progress', attendance: 'Attendance', loot: 'Loot' };
  const ASK_NEW_LINK = 'Ask the officer who sent it for a new link.';
  const NOTHING = 'Nothing is shared here yet.';
  const BADGES = { guest: 'Guest link', public: 'Public page' };

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

  // The dev "View as" preview: what the guest link / the public page shows, drawn for the Guild Master. Nothing here is a real link or page.
  function previewNoticeHtml(viewer, data, gid) {
    const kind = viewer.kind === 'public' ? 'the public page' : 'a guest link (the Guest role)';
    const off = viewer.kind === 'public' && data.publicEnabled === false ? ' The public page is switched off, so visitors see nothing yet; this shows what it would show.' : '';
    const back = gid ? '<a href="' + esc(G.router.format({ name: 'section', gid: gid, section: 'home' })) + '">Back to the guild</a>' : '';
    return '<div class="gs-notice gs-preview-banner" role="status"><span>Preview: this is what ' + kind + ' shows.' + esc(off) + '</span>' + back + '</div>';
  }

  // The head: the guild, where it plays, the Read-only chip and what kind of page this is; a guest's Leave is behind More.
  function headOf(data, kind) {
    const viewer = data.viewer || {};
    const guest = (viewer.kind || kind) === 'guest';
    return {
      title: data.guild && data.guild.name, contextHtml: esc(whereText(data.guild)),
      chipsHtml: '<span class="gs-sumchips">' + G.ui.readOnlyChipHtml() + G.ui.tagHtml(guest ? BADGES.guest : BADGES.public) + '</span>',
      more: guest && !viewer.preview ? { id: 'view-actions', label: 'More', key: 'view-actions', items: [{ label: 'Leave this link', key: 'view-leave', data: { action: 'view-leave' } }] } : null,
    };
  }

  // -- sections --
  // Every table is the data table (cards on a phone); a read-only page shows all its rows.
  function tableHtml(label, columns, rows, noun) {
    return G.ui.dataTableHtml({ label: label, columns: columns, rows: rows, showAll: true, noun: noun || 'rows' });
  }

  function teamName(entry) { return entry && entry.team && entry.team.name ? entry.team.name : 'Team'; }

  function rosterBlock(entry) {
    const people = listOf(entry.people);
    if (!people.length) return '<p class="gs-empty">No one on the roster yet.</p>';
    return tableHtml('Roster of ' + teamName(entry), [{ key: 'name', label: 'Name', primary: true }, { key: 'class', label: 'Class' }, { key: 'role', label: 'Role' }], people.map(function (p) {
      const role = G.ui.roleLabel(p.role);
      return { mark: p.class, cells: { name: G.ui.classNameHtml(p.name, p.class), class: esc(G.ui.className(p.class)), role: role ? esc(role) : '<span class="gs-muted gs-dash">-</span>' } };
    }), 'people');
  }

  function raidRows(raids) {
    return raids.map(function (r) {
      return { cells: { date: esc(G.ui.weekdayDay(r.raidOn)), zone: esc(r.zone), title: r.title ? esc(r.title) : '<span class="gs-muted gs-dash">-</span>' } };
    });
  }

  function raidsBlock(entry) {
    const upcoming = listOf(entry.upcoming);
    const recent = listOf(entry.recent);
    const columns = [{ key: 'date', label: 'Date', primary: true }, { key: 'zone', label: 'Zone' }, { key: 'title', label: 'Title' }];
    const part = function (heading, raids, none) {
      return '<h4 class="gs-view-sub">' + esc(heading) + '</h4>' +
        (raids.length ? tableHtml(heading + ' raids of ' + teamName(entry), columns, raidRows(raids), 'raids') : '<p class="gs-empty">' + esc(none) + '</p>');
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
        ? tableHtml('Attendance of ' + teamName(entry), [{ key: 'name', label: 'Name', primary: true }, { key: 'pct', label: 'Attendance', align: 'right' }, { key: 'counted', label: 'Raids counted' }], people.map(function (p) {
          return { mark: p.class, cells: { name: G.ui.classNameHtml(p.name, p.class), pct: esc(G.ui.percent(p.pct)), counted: esc(G.ui.plural(Number(p.counted) || 0, 'raid', 'raids') + ' counted') } };
        }), 'people')
        : '<p class="gs-empty">No attendance to show yet.</p>');
  }

  // The award time is written in the guild's zone ("Wed Oct 14, 8:12 PM ET"): the public payload carries guild.timeZone.
  // Each item is a Wowhead link for the guild's game version (G.ui.itemLinkHtml).
  function lootBlock(entry, zone, gameVersion) {
    const awards = listOf(entry.awards);
    if (!awards.length) return '<p class="gs-empty">No loot awarded yet.</p>';
    return tableHtml('Loot of ' + teamName(entry), [{ key: 'item', label: 'Item', primary: true }, { key: 'winner', label: 'Winner' }, { key: 'awarded', label: 'Awarded' }], awards.map(function (a) {
      const winner = a.disenchanted ? '<span class="gs-muted">Disenchanted</span>' : (a.winner ? G.ui.classNameHtml(a.winner, a.winnerClass) : '<span class="gs-muted gs-dash">-</span>');
      return { cells: { item: G.ui.itemLinkHtml({ itemId: a.itemId, itemName: a.itemName, quality: a.quality }, gameVersion), winner: winner, awarded: esc(G.ui.formatDateTime(a.awardedAt, zone)) } };
    }), 'awards');
  }

  // PM wave 7: the team's boss board (pages-progress.js), the public page's optional Progress section.
  function progressBlock(entry) {
    return G.pages.progress ? G.pages.progress.blockHtml(entry, 'vprog-' + String(entry && entry.team && entry.team.id || '')) : '';
  }

  const BLOCKS = { roster: rosterBlock, raids: raidsBlock, progress: progressBlock, attendance: attendanceBlock, loot: lootBlock };

  function sectionOf(key, entries, zone, gameVersion) {
    const list = listOf(entries);
    return { id: 'view-' + key, title: SECTION_TITLES[key], bodyHtml: list.length
      ? list.map(function (entry) { return '<div class="gs-view-team"><h3 class="gs-h3">' + esc(teamName(entry)) + '</h3>' + BLOCKS[key](entry, zone, gameVersion) + '</div>'; }).join('')
      : '<p class="gs-empty">Nothing to show here yet.</p>' };
  }

  // opts: { data (GET /api/guest or /api/public/:gid, or null while loading), kind ('guest' | 'public'), error, gid (the dev preview's guild) }
  function viewHtml(opts) {
    const o = opts || {};
    const kind = o.kind || (o.data && o.data.viewer && o.data.viewer.kind) || 'guest';
    if (o.error) return errorHtml(o.error, kind);
    if (!o.data) return G.pages.signin.loadingHtml();
    const data = o.data;
    const sections = data.sections && typeof data.sections === 'object' ? data.sections : {};
    const shown = SECTION_ORDER.filter(function (k) { return Object.prototype.hasOwnProperty.call(sections, k); });
    const viewer = data.viewer || {};
    const guest = (viewer.kind || kind) === 'guest';
    const zone = data.guild && data.guild.timeZone ? data.guild.timeZone : '';
    const gameVersion = data.guild ? data.guild.gameVersion : null;
    // T1 / T4 with no actions: the list page's header and sections, a Read-only chip, and a foot line that says what this is.
    return G.ui.listPageHtml({
      pageClass: 'gs-view',
      head: headOf(data, kind),
      noticesHtml: viewer.preview ? previewNoticeHtml(viewer, data, o.gid) : guest ? guestMetaHtml(viewer) + '<p class="gs-alert" id="view-alert" role="alert" hidden></p>' : '',
      bodyHtml: shown.length ? shown.map(function (k) { return G.ui.objectSectionHtml(sectionOf(k, sections[k], zone, gameVersion)); }).join('') : '<p class="gs-empty" id="view-empty">' + esc(NOTHING) + '</p>',
      footHtml: 'A read-only copy: nothing on this page can be changed.' + (zone ? ' Times are in ' + esc(G.ui.zoneLabel(zone)) + ', the guild\'s zone.' : ''),
    });
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
    const kind = r.name === 'public' || (r.name === 'devview' && r.role === 'public') ? 'public' : 'guest';
    const done = function (data, err) {
      const view = { kind: kind, gid: r.name === 'public' || r.name === 'devview' ? r.gid : null, data: data, error: err ? { status: err.status, code: err.code, message: err.message } : null };
      st().view = view;
      return view;
    };
    let call;
    if (r.name === 'guest') {
      call = G.api.guests.redeem(r.token).then(function () {
        dropToken();
        return G.api.guests.view();
      });
    } else if (r.name === 'devview') {
      call = G.api.dev.viewerPreview(r.gid, r.role);
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
