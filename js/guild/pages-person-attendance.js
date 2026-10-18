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

  // opts: { gid, pid, record (the roster record), state: { data, denied } | null }  ->  the section of the person page (T2)
  function sectionOf(opts) {
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
    return { id: 'attendance', title: 'Attendance', bodyHtml: body };
  }

  function cardHtml(opts) { return G.ui.objectSectionHtml(sectionOf(opts)); }

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

  // ── full history page (T2: the person's header, the You line, one section per team) ──
  function historyColumns(showReason) {
    const cols = [{ key: 'raid', label: 'Raid', primary: true }, { key: 'zone', label: 'Zone' }, { key: 'outcome', label: 'Outcome' }, { key: 'credit', label: 'Credit' }, { key: 'team', label: 'Team' }];
    if (showReason) cols.push({ key: 'reason', label: 'Officer reason' });
    return cols;
  }

  function historyRow(gid, cell) {
    const date = dateOfCell(cell);
    const rid = raidIdOf(cell);
    const zone = cell.raid && typeof cell.raid === 'object' && cell.raid.zone ? cell.raid.zone : '';
    const pending = cell.credit == null && LATE_TYPES.indexOf(cell.outcome) >= 0;
    const via = cell.via ? 'via ' + (typeof cell.via === 'object' ? cell.via.name : cell.via) : '';
    const day = G.ui.weekdayDay(date) || date;
    const dash = '<span class="gs-muted gs-dash">-</span>';
    return {
      id: rid || date,
      cells: {
        raid: rid ? '<a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: rid })) + '">' + esc(day) + '</a>' : esc(day),
        zone: zone ? esc(zone) : dash, outcome: A().outcomeChipHtml(cell.outcome, pending), credit: esc(A().creditText(cell.credit, pending)),
        team: via ? esc(via) : dash, reason: cell.reason ? esc(cell.reason) : dash,
      },
    };
  }

  // The head, You line and sections the three person pages share: opts { gd, pid, person (the Worker's), kind ('attendance' | 'loot') }.
  function subHead(opts) {
    const p = opts.person || {};
    const name = p.name || (p.main && p.main.name) || 'Person';
    const cls = p.class ? G.ui.className(p.class) : '';
    const what = opts.kind === 'loot' ? 'Loot history' : 'Attendance history';
    return G.pages.person.headOpts({
      name: name, status: p.status, person: p, isMe: !!p.isMe,
      contextHtml: '<span>' + esc(what) + '</span>' + (cls ? '<span class="gs-sumsep" aria-hidden="true"></span><span>Main: ' + G.ui.classNameHtml(cls, p.class) + '</span>' : ''),
      back: { href: G.router.format({ name: 'person', gid: opts.gd.guild.id, pid: opts.pid }), label: 'Roster record' },
    });
  }

  function subYou(isMe, text) {
    return isMe ? '<span class="gs-youline-label">You</span> ' + esc(text) : '';
  }

  // opts: { guildData, pid, data (GET /attendance/person/:pid) }
  function personAttHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data;
    const p = data.person || {};
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const sections = [];
    const rank = G.pages.ranks ? G.pages.ranks.personBoxSection(Object.assign({}, p, { id: opts.pid }), teams) : null;
    if (rank) sections.push(rank);
    teams.forEach(function (t, i) {
      const cells = (Array.isArray(t.cells) ? t.cells : []).slice().sort(function (x, y) { return dateOfCell(x) < dateOfCell(y) ? 1 : -1; });
      const showReason = G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', idOf(t.team));
      const table = cells.length
        ? G.ui.dataTableHtml({ label: 'Raid by raid', columns: historyColumns(showReason), rows: cells.map(function (c) { return historyRow(gid, c); }), showAll: true, noun: 'raids' })
        : '<p class="gs-fine">No raids yet.</p>';
      sections.push({ id: 'pa-team-' + i, title: nameOfTeam(t.team) || 'Team', bodyHtml: tilesHtml(t.metrics, t) + table });
    });
    if (!sections.length) sections.push({ id: 'pa-none', title: 'Nothing to show', bodyHtml: '<p class="gs-fine">There is no attendance you can see for this person yet.</p>' });
    return G.ui.objectPageHtml({
      head: subHead({ gd: gd, pid: opts.pid, person: p, kind: 'attendance' }),
      noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'),
      youHtml: subYou(!!p.isMe, 'This is your attendance. Your team and your officers can see it.'),
      pageClass: 'gs-person-page' + (p.isMe ? ' is-own' : ''),
      sections: sections,
    });
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
    return personAttHtml({ guildData: gd, pid: r.pid, data: x.data, alert: G.app.state.pageAlert });
  }

  function nameFor(r) {
    const x = a().personAtt;
    if (!x || x.pid !== r.pid || !x.data || !x.data.person) return '';
    const p = x.data.person;
    return p.name || (p.main && p.main.name) || '';
  }

  G.pages.personAtt = { sectionOf: sectionOf, subHead: subHead, subYou: subYou, cardHtml: cardHtml, personAttHtml: personAttHtml, loadCard: loadCard, cardState: cardState, nameFor: nameFor, load: load, main: main };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
