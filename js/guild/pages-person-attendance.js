// ── PAGES: PERSON ATTENDANCE (the card on the roster person page, and the full history page) ──
// GET /attendance/person/:pid?window= -> { person, teams: [ { team, window, metrics, cells: [ { raid, outcome, credit, via, reason } ] } ] },
// only the teams the viewer may see. Members open their own record; the officer reason shows to reviewers only.
(function (G) {
  'use strict';

  const CARD_CELLS = 8;
  const LATE_TYPES = ['late', 'left_early', 'late_left'];

  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }
  function nameOfTeam(t) { return t && typeof t === 'object' ? t.name : ''; }
  function dateOfCell(c) {
    const r = c && c.raid;
    return (r && typeof r === 'object' ? r.raidOn : null) || (c && (c.date || c.raidOn)) || '';
  }
  function raidIdOf(c) { return idOf(c && c.raid) || (c && c.raidId) || ''; }
  function metricCells(t) { return t && Array.isArray(t.cells) ? t.cells : []; }

  // The window is per team: teams[].window is a number of weeks or 'all'.
  function windowLabel(team) {
    return team && typeof team.window === 'number' ? team.window + '-week attendance' : 'Recent attendance';
  }

  function tilesHtml(m, team) {
    const metrics = m || {};
    return '<dl class="gs-summary"><div class="gs-summary-item"><dt>' + esc(windowLabel(team)) + '</dt><dd>' + esc(G.ui.percent(metrics.pct)) + '</dd></div>' +
      '<div class="gs-summary-item"><dt>All-time attendance</dt><dd>' + esc(G.ui.percent(metrics.pctAll)) + '</dd></div>' +
      '<div class="gs-summary-item"><dt>Sign-up rate</dt><dd>' + esc(G.ui.percent(metrics.signupRate)) + '</dd></div></dl>';
  }

  function stripHtml(cells) {
    const last = cells.slice().sort(function (x, y) { return dateOfCell(x) < dateOfCell(y) ? -1 : 1; }).slice(-CARD_CELLS);
    if (!last.length) return '<p class="gs-fine">No raids yet.</p>';
    return '<div class="gs-att-strip">' + last.map(function (c) { return A().cellHtml(c, dateOfCell(c)); }).join('') + '</div>';
  }

  // opts: { gid, pid, record (the roster record), state: { data, denied } | null }
  function cardHtml(opts) {
    const s = opts.state;
    const isMe = !!(opts.record && opts.record.person && opts.record.person.isMe);
    let body;
    if (!s) {
      body = '<p class="gs-fine">' + esc(isMe ? 'Your attendance shows here after the first raid.' : 'Attendance shows here after the first raid.') + '</p>';
    } else if (s.denied || !s.data) {
      body = '<p class="gs-fine">Attendance for this person is visible to the members of their team.</p>';
    } else {
      const teams = Array.isArray(s.data.teams) ? s.data.teams : [];
      body = teams.length ? teams.map(function (t) {
        return '<div class="gs-att-teamblock">' + (teams.length > 1 ? '<h3 class="gs-h3">' + esc(nameOfTeam(t.team)) + '</h3>' : '') + tilesHtml(t.metrics, t) + stripHtml(metricCells(t)) + '</div>';
      }).join('') + '<p class="gs-fine"><a href="' + esc(G.router.format({ name: 'personatt', gid: opts.gid, pid: opts.pid })) + '">Full history</a></p>'
        : '<p class="gs-fine">' + esc(isMe ? 'Your attendance shows here after the first raid.' : 'Attendance shows here after the first raid.') + '</p>';
    }
    return '<section class="gs-card-sec" aria-labelledby="attendance-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="attendance-h">Attendance</h2></div><div class="gs-card-sec-body">' + body + '</div></section>';
  }

  function loadCard(gid, pid, gd) {
    const can = gd && gd.me && gd.me.can;
    if (!G.shell.hasAction(can, 'attendance.view')) { a().personCard = { gid: gid, pid: pid, data: null, denied: false, none: true }; return Promise.resolve(null); }
    return G.api.get(A().apiBase(gid) + '/attendance/person/' + encodeURIComponent(pid)).then(function (data) {
      a().personCard = { gid: gid, pid: pid, data: data, denied: false };
      return null;
    }, function (err) {
      a().personCard = { gid: gid, pid: pid, data: null, denied: !!(err && (err.status === 403 || err.status === 404)) };
      return null;
    });
  }

  function cardState(gid, pid) {
    const c = a().personCard;
    return c && c.gid === gid && c.pid === pid && !c.none ? c : null;
  }

  // ── full history page ──
  function historyRowHtml(gid, cell, showReason) {
    const date = dateOfCell(cell);
    const rid = raidIdOf(cell);
    const zone = cell.raid && typeof cell.raid === 'object' && cell.raid.zone ? cell.raid.zone : '';
    const pending = cell.credit == null && LATE_TYPES.indexOf(cell.outcome) >= 0;
    const via = cell.via ? 'via ' + (typeof cell.via === 'object' ? cell.via.name : cell.via) : '';
    const day = G.ui.weekdayDay(date) || date;
    return '<tr><th scope="row" class="gs-cell-strong gs-nowrap">' + (rid ? '<a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: rid })) + '">' + esc(day) + '</a>' : esc(day)) + '</th>' +
      '<td>' + (zone ? esc(zone) : '<span class="gs-muted">-</span>') + '</td><td>' + A().outcomeChipHtml(cell.outcome, pending) + '</td><td class="gs-nowrap">' + esc(A().creditText(cell.credit, pending)) + '</td>' +
      '<td>' + (via ? esc(via) : '<span class="gs-muted">-</span>') + '</td>' + (showReason ? '<td>' + (cell.reason ? esc(cell.reason) : '<span class="gs-muted">-</span>') + '</td>' : '') + '</tr>';
  }

  function historyCardHtml(gid, cell, showReason) {
    const date = dateOfCell(cell);
    const pending = cell.credit == null && LATE_TYPES.indexOf(cell.outcome) >= 0;
    const via = cell.via ? 'via ' + (typeof cell.via === 'object' ? cell.via.name : cell.via) : '';
    return '<li class="gs-roster-card"><div class="gs-card-top"><span>' + esc(G.ui.weekdayDay(date) || date) + '</span>' + A().outcomeChipHtml(cell.outcome, pending) + '</div>' +
      '<div class="gs-card-meta"><span class="gs-fine">' + esc(A().creditText(cell.credit, pending)) + '</span>' + (via ? '<span class="gs-fine">' + esc(via) + '</span>' : '') + '</div>' + (showReason && cell.reason ? '<div class="gs-fine">' + esc(cell.reason) + '</div>' : '') + '</li>';
  }

  // opts: { guildData, pid, data (GET /attendance/person/:pid) }
  function personAttHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data;
    const p = data.person || {};
    const name = p.name || (p.main && p.main.name) || 'Person';
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const head = '<div class="gs-person-head"><div class="gs-person-title"><div class="gs-person-h1"><h1 class="gs-h1" tabindex="-1">' + esc(name) + '</h1>' + (p.isMe ? '<span class="gs-you">You</span>' : '') + '</div>' +
      '<p class="gs-sub">Attendance history</p>' + (p.status ? '<div class="gs-chips">' + G.ui.statusChipHtml(p.status) + '</div>' : '') + '</div>' +
      '<p class="gs-person-discord"><a href="' + esc(G.router.format({ name: 'person', gid: gid, pid: opts.pid })) + '">Open in Roster</a></p></div>';
    const blocks = teams.map(function (t, i) {
      const cells = (Array.isArray(t.cells) ? t.cells : []).slice().sort(function (x, y) { return dateOfCell(x) < dateOfCell(y) ? 1 : -1; });
      const teamId = idOf(t.team);
      const showReason = G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', teamId);
      const h = 'pa-team-' + i;
      return '<section class="gs-card-sec" aria-labelledby="' + h + '"><div class="gs-card-sec-head"><h2 class="gs-h2" id="' + h + '">' + esc(nameOfTeam(t.team) || 'Team') + '</h2></div><div class="gs-card-sec-body">' + tilesHtml(t.metrics, t) +
        (cells.length
          ? '<div class="gs-table-wrap gs-flush gs-pa-table"><table class="gs-table gs-table-history" aria-label="Raid by raid"><thead><tr><th scope="col">Raid</th><th scope="col">Zone</th><th scope="col">Outcome</th><th scope="col">Credit</th><th scope="col">Team</th>' + (showReason ? '<th scope="col">Officer reason</th>' : '') + '</tr></thead><tbody>' +
            cells.map(function (c) { return historyRowHtml(gid, c, showReason); }).join('') + '</tbody></table></div>' +
            '<ul class="gs-roster-cards gs-pa-cards" aria-label="Raid by raid">' + cells.map(function (c) { return historyCardHtml(gid, c, showReason); }).join('') + '</ul>'
          : '<p class="gs-fine">No raids yet.</p>') + '</div></section>';
    }).join('');
    return '<div class="gs-page gs-person-page">' + head + (blocks || '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">Nothing to show</h2><p class="gs-lead gs-lead-sm">There is no attendance you can see for this person yet.</p></section>') + '</div>';
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    return G.api.get(A().apiBase(gid) + '/attendance/person/' + encodeURIComponent(r.pid)).then(function (data) {
      a().personAtt = { gid: gid, pid: r.pid, data: data };
      return null;
    });
  }

  function main(r, gd) {
    const x = a().personAtt;
    if (!x || x.gid !== gd.guild.id || x.pid !== r.pid) return G.pages.signin.loadingHtml();
    return personAttHtml({ guildData: gd, pid: r.pid, data: x.data });
  }

  function nameFor(r) {
    const x = a().personAtt;
    if (!x || x.pid !== r.pid || !x.data || !x.data.person) return '';
    const p = x.data.person;
    return p.name || (p.main && p.main.name) || '';
  }

  G.pages.personAtt = { cardHtml: cardHtml, personAttHtml: personAttHtml, loadCard: loadCard, cardState: cardState, nameFor: nameFor, load: load, main: main };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
