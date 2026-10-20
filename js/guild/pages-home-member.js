// ── PAGE: HOME, MEMBER VARIANT (T4: what a raider lands on) ─────
// Everyone who cannot act on the officer Home's items lands here (pages-attention.js picks the variant). "You" first: the next raid with the viewer's own line-up
// seat and Confirm / Can't come right there (or Sign up), then their attendance (the rolling-window percentage and the last 8 raids), their last loot awards,
// their away notices and the calendar link. Nothing here is new data: every card reads an existing route for the viewer's own person (gd.me.personId, set by
// GET /api/guild/:gid):
//   GET /raids?team=            the selected team's raids: upcoming[0] carries the viewer's sign-up and seat (`mine`), the sign-up counts and window
//   GET /raids/:rid/roster      the seat's spec and class, and when the line-up was published (a member sees only their own seat)
//   GET /attendance/person/:pid the rolling-window percentage and the cells          GET /loot/person/:pid   the awards, newest first
//   GET /away/mine              the viewer's own notices
// The raids read decides the page; a card whose read fails (or the viewer may not see) says so and the rest still draws.
(function (G) {
  'use strict';

  const CELLS = 8;
  const LOOT_ROWS = 3;
  const AWAY_ROWS = 3;
  const LATE_TYPES = ['late', 'left_early', 'late_left'];
  const ABSENT_TYPES = ['missed', 'missed_notice'];

  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function A() { return G.pages.attendance; }

  // ── data ──
  function apiBase(gid) { return '/api/guild/' + encodeURIComponent(gid); }

  // A card's read: { data } on success, { denied } when the viewer may not see it, { error } otherwise. A lost session is not a card's problem: it rejects.
  function card(promise) {
    return promise.then(function (data) { return { data: data }; }, function (err) {
      const c = G.api.classify(err);
      if (c.view === 'signin') throw err;
      if (err && (err.status === 403 || err.status === 404)) return { denied: true };
      return { error: c.text };
    });
  }

  // The selected team's upcoming raids, and, when the viewer has a seat on the first one, the seat's details. Rejects when the raids cannot be read.
  function readNext(gid, teamId) {
    if (!teamId) return Promise.resolve({ raids: null, seat: null });
    return G.api.get(apiBase(gid) + '/raids?team=' + encodeURIComponent(teamId)).then(function (raids) {
      const next = raids && Array.isArray(raids.upcoming) ? raids.upcoming[0] : null;
      if (!next || !next.mine || !next.mine.roster) return { raids: raids, seat: null };
      return card(G.api.raidRoster.get(gid, next.id)).then(function (seat) { return { raids: raids, seat: seat.data || null }; });
    });
  }

  // The member's own team: the team of their Main, else the first team (in the guild's order) that has one of their characters. A viewer on no active
  // team keeps the shell's selected team, so the page is never empty for someone who can see the guild.
  function ownTeamOf(gd) {
    const me = gd && gd.me ? gd.me : {};
    const active = G.shell.activeTeams(gd && gd.teams);
    if (me.mainTeamId && active.some(function (t) { return t.id === me.mainTeamId; })) return me.mainTeamId;
    const ids = Array.isArray(me.teamIds) ? me.teamIds : [];
    const first = active.filter(function (t) { return ids.indexOf(t.id) >= 0; })[0];
    return first ? first.id : G.app.teamFor(gd);
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const pid = gd.me && gd.me.personId ? gd.me.personId : null;
    const teamId = ownTeamOf(gd);
    const own = function (path) { return pid ? card(G.api.get(apiBase(gid) + path + encodeURIComponent(pid))) : Promise.resolve(null); };
    return Promise.all([
      readNext(gid, teamId),
      own('/attendance/person/'),
      own('/loot/person/'),
      pid ? card(G.api.away.mine(gid)) : Promise.resolve(null),
    ]).then(function (res) {
      a().homeMember = { gid: gid, teamId: teamId, pid: pid, data: res[0].raids, seat: res[0].seat, attendance: res[1], loot: res[2], away: res[3], busy: false, error: '' };
      return null;
    });
  }

  // Re-reads the raid card after an answer (Confirm, Can't come, Sign up), leaving the other cards as they were.
  function reloadNext() {
    const x = a().homeMember;
    if (!x) return Promise.resolve(null);
    return readNext(x.gid, x.teamId).then(function (res) {
      x.data = res.raids;
      x.seat = res.seat;
      x.error = '';
      G.app.render();
      return null;
    }, function (err) {
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return null; }
      x.error = c.text;
      G.app.render();
      return null;
    });
  }

  // ── the next raid ──
  // "today", "tomorrow", "in 3 days" from the guild's date to the raid's.
  function inText(today, raidOn) {
    const days = Math.round((Date.parse(raidOn + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
    if (!isFinite(days)) return '';
    return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days';
  }

  function signupChipHtml(m) {
    if (!m || !m.kind) return '';
    if (m.source === 'away') return G.ui.chipHtml({ tone: 'neutral', label: 'Away notice' });
    const kind = m.kind === 'absence' ? 'cant_come' : m.kind;
    if (G.ui.SIGNUP_CHIPS[kind]) return G.ui.signupChipHtml(kind);
    return G.ui.chipHtml({ tone: 'neutral', label: A().KIND_LABELS[m.kind] || m.kind });
  }

  function dateOnlyNote(r) { return r.timeKnown === false ? ' <span class="gs-muted gs-time-unset">time not set</span>' : ''; }

  // The viewer's line in the card, the status and the buttons. seat: the line-up reply for this raid or null. The buttons are the card's answer;
  // Confirm is the one primary while the seat waits.
  function youHtml(gd, x, r, canSignUp) {
    const m = r.mine;
    const ro = m && m.roster ? m.roster : null;
    const btn = function (label, action, variant) {
      return G.ui.buttonHtml({ label: label, variant: variant, disabled: !!x.busy, attrs: { 'data-action': action, 'data-rid': r.id, 'data-key': action } });
    };
    if (ro) {
      const seat = x.seat && x.seat.published && x.seat.mine ? x.seat.mine : { group: ro.group, status: ro.status };
      const published = x.seat && x.seat.published && x.seat.publishedAt ? '<p class="gs-fine">Line-up published ' + esc(G.pages.raids.momentText(x.seat.publishedAt, gd)) + '.</p>' : '';
      const status = ro.status === 'confirmed' ? G.ui.chipHtml({ tone: 'success', label: 'Confirmed' }) : ro.status === 'declined' ? G.ui.chipHtml({ tone: 'danger', label: 'Can\'t come' }) : G.ui.chipHtml({ tone: 'warning', label: 'Waiting for you' });
      const actions = ro.status === 'declined' ? btn('Confirm after all', 'home-confirm', 'primary')
        : ro.status === 'confirmed' ? btn('Can\'t come', 'home-decline', 'secondary')
        : btn('Confirm', 'home-confirm', 'primary') + btn('Can\'t come', 'home-decline', 'secondary');
      const said = ro.status === 'declined' ? '<p class="gs-fine">You told the officers you can\'t come.</p>' : ro.status === 'confirmed' ? '<p class="gs-fine">You told the officers you\'re coming.</p>' : '';
      return '<p class="gs-mnext-you">' + esc(G.pages.raidRoster.seatText(seat)) + '.</p><p class="gs-mnext-status">' + status + '</p>' + said + '<div class="gs-mnext-actions">' + actions + '</div>' + published;
    }
    if (m && m.kind) {
      return '<p class="gs-mnext-you">You\'re signed up.</p><p class="gs-mnext-status">' + signupChipHtml(m) + (m.characterName ? ' <span class="gs-fine">' + esc(m.characterName) + '</span>' : '') + '</p>' +
        '<p class="gs-fine">Change it on the <a href="' + esc(G.router.format({ name: 'section', gid: gd.guild.id, section: 'raids' })) + '">Raids page</a>.</p>';
    }
    if (!canSignUp) return '<p class="gs-fine">Sign-ups are for the people on the roster.</p>';
    if (!r.signupsOpen) return '<p class="gs-mnext-you">You\'re not signed up.</p><p class="gs-fine">Sign-ups are closed.</p>';
    return '<p class="gs-mnext-you">You\'re not signed up yet.</p><div class="gs-mnext-actions">' + btn('Sign up', 'home-signup', 'primary') + '</div>' +
      G.pages.raids.deadlineHtml(r, gd);
  }

  function nextRaidHtml(gd, x) {
    const raids = x.data;
    const r = raids && Array.isArray(raids.upcoming) ? raids.upcoming[0] : null;
    if (!r) {
      return '<section class="gs-hcard gs-mnext" id="home-next" aria-labelledby="home-next-h"><h2 class="gs-h2" id="home-next-h">Next raid</h2>' +
        '<p class="gs-fine">' + esc(x.teamId ? 'No upcoming raid is scheduled for your team.' : 'You are not on a team yet.') + ' See the <a href="' + esc(G.router.format({ name: 'section', gid: gd.guild.id, section: 'raids' })) + '">Raids page</a>.</p></section>';
    }
    const canSignUp = !!(raids.can && raids.can.signup);
    const where = [r.title, r.zone].filter(function (s, i, all) { return s && all.indexOf(s) === i; }).join(' - ');
    const team = G.shell.activeTeams(gd.teams).length > 1 ? G.pages.attendance.teamOf(gd, x.teamId) : null;
    const rel = inText(raids.today, r.raidOn);
    return '<section class="gs-hcard gs-mnext" id="home-next" aria-labelledby="home-next-h"><h2 class="gs-h2" id="home-next-h">Next raid' + (rel ? '<span class="gs-mnext-rel"> - ' + esc(rel) + '</span>' : '') + '</h2>' +
      '<p class="gs-mnext-when"><a href="' + esc(G.router.format({ name: 'raid', gid: gd.guild.id, rid: r.id })) + '">' + esc(G.pages.raids.whenText(r, gd)) + '</a>' + dateOnlyNote(r) + '</p>' +
      (where || team ? '<p class="gs-fine">' + esc([where, team ? team.name : ''].filter(Boolean).join(' - ')) + '</p>' : '') +
      youHtml(gd, x, r, canSignUp) + '<p class="gs-alert" id="home-next-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p></section>';
  }

  // ── my attendance ──
  function cardOf(id, title, bodyHtml) {
    return '<section class="gs-hcard" id="' + id + '" aria-labelledby="' + id + '-h"><h2 class="gs-h2" id="' + id + '-h">' + esc(title) + '</h2><div class="gs-hcard-body">' + bodyHtml + '</div></section>';
  }

  function dateOfCell(c) { return c && c.raid && typeof c.raid === 'object' ? c.raid.raidOn || '' : ''; }

  // The team block the card draws: the selected team's, else the first the viewer may see.
  function teamBlockOf(data, teamId) {
    const teams = data && Array.isArray(data.teams) ? data.teams : [];
    return teams.filter(function (t) { return t.team && t.team.id === teamId; })[0] || teams[0] || null;
  }

  // "6 on time, 1 late, 1 absent in the last 8 raids." from the cells shown.
  function summaryText(cells) {
    const present = cells.filter(function (c) { return c.outcome === 'present' || c.outcome === 'fill_in'; }).length;
    const late = cells.filter(function (c) { return LATE_TYPES.indexOf(c.outcome) >= 0; }).length;
    const absent = cells.filter(function (c) { return ABSENT_TYPES.indexOf(c.outcome) >= 0; }).length;
    const parts = [];
    if (present) parts.push(present + ' on time');
    if (late) parts.push(late + ' late');
    if (absent) parts.push(absent + ' absent');
    return parts.length ? parts.join(', ') + ' in the last ' + plural(cells.length, 'raid', 'raids') + '.' : '';
  }

  function attendanceHtml(gd, x) {
    const s = x.attendance;
    const link = x.pid ? '<a href="' + esc(G.router.format({ name: 'personatt', gid: gd.guild.id, pid: x.pid })) + '">See my record</a>' : '';
    let body;
    if (!x.pid) body = '<p class="gs-fine">Your attendance shows here once an officer links your account to a roster person.</p>';
    else if (!s || s.denied) body = '<p class="gs-fine">Your attendance is not shared with you in this guild.</p>';
    else if (s.error) body = '<p class="gs-fine">' + esc(s.error) + '</p>';
    else {
      const block = teamBlockOf(s.data, x.teamId);
      const cells = block && Array.isArray(block.cells) ? block.cells.filter(function (c) { return !c.preStart && c.outcome; }).slice(0, CELLS) : [];
      if (!block || !cells.length) body = '<p class="gs-fine">Your attendance shows here after the first raid.</p>';
      else {
        const m = block.metrics || {};
        const label = typeof block.window === 'number' ? block.window + '-week attendance' : 'Recent attendance';
        const strip = cells.slice().reverse().map(function (c) { return A().cellHtml(c, dateOfCell(c)); }).join('');
        body = '<p class="gs-mstat"><strong>' + esc(G.ui.percent(m.pct)) + '</strong> <span class="gs-fine">' + esc(label) + '</span></p><div class="gs-att-strip">' + strip + '</div>' +
          '<p class="gs-fine">' + esc(summaryText(cells)) + '</p><p class="gs-fine">Attendance is visible to the members of your team.</p>' + link;
      }
    }
    return cardOf('home-attendance', 'My attendance', body);
  }

  // ── my loot ──
  function lootHtml(gd, x) {
    const s = x.loot;
    const link = x.pid ? '<a href="' + esc(G.router.format({ name: 'lootperson', gid: gd.guild.id, pid: x.pid })) + '">See my loot</a>' : '';
    let body;
    if (!x.pid) body = '<p class="gs-fine">Your loot shows here once an officer links your account to a roster person.</p>';
    else if (!s || s.denied) body = '<p class="gs-fine">Your loot is not shared with you in this guild.</p>';
    else if (s.error) body = '<p class="gs-fine">' + esc(s.error) + '</p>';
    else {
      const all = Array.isArray(s.data && s.data.awards) ? s.data.awards : [];
      const nightKey = function (w) { return w.raidId ? 'r:' + w.raidId : 'd:' + (w.raidOn || ''); };
      const nights = [];
      all.slice(0, LOOT_ROWS).forEach(function (w) {
        const key = nightKey(w);
        let n = nights.find(function (x) { return x.key === key; });
        if (!n) { n = { key: key, raidId: w.raidId || null, raidOn: w.raidOn, rows: [] }; nights.push(n); }
        n.rows.push(w);
      });
      body = nights.length ? '<div class="gs-mloot-nights">' + nights.map(function (n) {
        const day = G.ui.weekdayDay(n.raidOn) || n.raidOn || 'Raid';
        const total = all.filter(function (w) { return nightKey(w) === n.key; }).length;
        const title = n.raidId ? '<a class="gs-fg-ght" href="' + esc(G.router.format({ name: 'lootnight', gid: gd.guild.id, rid: n.raidId })) + '">' + esc(day) + '</a>' : '<span class="gs-fg-ght">' + esc(day) + '</span>';
        return '<div class="gs-mloot-night"><h3 class="gs-fg-gh">' + title + '<span class="gs-fg-ghn">' + plural(total, 'item', 'items') + '</span></h3><ul class="gs-mlist" aria-label="' + esc('My loot on ' + day) + '">' +
          n.rows.map(function (w) {
            return '<li><span class="gs-mlist-main">' + G.pages.loot.itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + '</span></li>';
          }).join('') + '</ul></div>';
      }).join('') + '</div>' + link : '<p class="gs-fine">No loot yet. Awards show here after a raid.</p>';
    }
    return cardOf('home-loot', 'My loot', body);
  }

  // ── away and calendar ──
  function awayHtml(gd, x) {
    const s = x.away;
    const gid = gd.guild.id;
    let notices = '';
    if (!x.pid) notices = '<p class="gs-fine">Away notices are for the people on the roster.</p>';
    else if (!s || s.denied) notices = '<p class="gs-fine">Your away notices are not available.</p>';
    else if (s.error) notices = '<p class="gs-fine">' + esc(s.error) + '</p>';
    else {
      const current = G.pages.away.split(s.data && s.data.notices, s.data && s.data.today).current;
      notices = current.length ? '<ul class="gs-mlist">' + current.slice(0, AWAY_ROWS).map(function (n) { return '<li><span class="gs-mlist-main">' + esc(G.pages.away.noticeText(n, s.data.today)) + '</span></li>'; }).join('') + '</ul>' +
        (current.length > AWAY_ROWS ? '<p class="gs-fine">' + esc('and ' + (current.length - AWAY_ROWS) + ' more') + '</p>' : '') : '<p class="gs-fine">No away notices.</p>';
    }
    const add = x.pid ? G.ui.buttonHtml({ label: 'Add away notice', href: G.router.format({ name: 'away', gid: gid }) }) : '';
    const cal = x.teamId && G.pages.calendar ? '<div class="gs-mcal"><button type="button" class="gs-linkbtn" data-action="home-cal" data-key="home-cal">Subscribe in your calendar</button>' +
      '<p class="gs-fine">A private link. It shows your team\'s raids.</p></div>' : '';
    return cardOf('home-away', 'Away and calendar', notices + add + cal);
  }

  // opts: { guildData, state (a().homeMember), me (the session's user) }
  function homeHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const user = opts.me && opts.me.user ? opts.me.user : null;
    const name = (x.attendance && x.attendance.data && x.attendance.data.person && x.attendance.data.person.name) || (user && user.displayName) || '';
    const team = x.teamId && G.shell.activeTeams(gd.teams).length > 1 ? G.pages.attendance.teamOf(gd, x.teamId) : null;
    const context = (name ? 'Welcome back, ' + name : 'Welcome back') + ' - ' + (team ? team.name : gd.guild.name);
    const grid = '<div class="gs-mgrid">' + attendanceHtml(gd, x) + lootHtml(gd, x) + awayHtml(gd, x) + '</div>';
    return G.ui.homePageHtml({
      head: { title: 'Home', context: context }, pageClass: 'gs-home-member',
      noticesHtml: '<p class="gs-sr" id="home-status" role="status"></p>',
      cards: [{ html: nextRaidHtml(gd, x) }, { html: grid }],
    });
  }

  function main(r, gd) {
    const x = a().homeMember;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return homeHtml({ guildData: gd, state: x, me: st().me });
  }

  // ── handlers ──
  function say(text) { G.ui.announce('home-status', text); }

  // An answer to the line-up (Confirm / Can't come) or the sign-up: one call, then the raid card is read again.
  function answer(call, done) {
    const x = a().homeMember;
    if (!x || x.busy) return null;
    x.busy = true;
    x.error = '';
    G.app.render();
    return call(x).then(function () { x.busy = false; say(done); return reloadNext(); }, function (err) {
      x.busy = false;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return null; }
      // The raid started or the line-up changed since the page was read: show what it says now, with the reason.
      return reloadNext().then(function () { x.error = c.text; G.app.render(); return null; });
    });
  }

  G.handlers.click['home-confirm'] = function (el) {
    const rid = el.getAttribute('data-rid');
    return answer(function (x) { return G.api.raidRoster.confirm(x.gid, rid); }, 'You confirmed.');
  };

  G.handlers.click['home-signup'] = function (el) {
    const rid = el.getAttribute('data-rid');
    return answer(function (x) { return G.api.signups.save(x.gid, rid, { kind: 'signed' }); }, 'You are signed up.');
  };

  G.handlers.click['home-decline'] = function (el) {
    const x = a().homeMember;
    if (!x || x.busy) return;
    G.ui.openDialog(G.pages.raidRoster.declineDialogHtml('home', el.getAttribute('data-rid')), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  // The decline dialog's submit (pages-raid-roster.js) calls this when it was opened from Home.
  function afterDecline() { say('You told the officers you can\'t come.'); return reloadNext(); }

  G.handlers.click['home-cal'] = function () {
    const x = a().homeMember;
    const gd = x ? st().guilds[x.gid] : null;
    if (!x || !gd || !x.teamId || !G.pages.calendar) return null;
    const team = G.pages.attendance.teamOf(gd, x.teamId);
    return G.pages.calendar.open(x.gid, x.teamId, team ? team.name : '');
  };

  G.pages.homeMember = {
    inText: inText,
    ownTeamOf: ownTeamOf,
    summaryText: summaryText,
    homeHtml: homeHtml,
    afterDecline: afterDecline,
    reloadNext: reloadNext,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
