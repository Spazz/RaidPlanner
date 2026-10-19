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

  // The Roster record's figures: three numbers over a hairline, each a caps label and a big value ("8 weeks" / "All time" / "Sign-ups").
  function figuresHtml(m, team) {
    const metrics = m || {};
    const weeks = team && typeof team.window === 'number' ? team.window + ' weeks' : 'Recent';
    const one = function (label, value) { return '<div class="gs-pr-fig"><span class="gs-pr-cap">' + esc(label) + '</span><span class="gs-pr-num">' + esc(G.ui.percent(value)) + '</span></div>'; };
    return '<div class="gs-pr-figs is-three">' + one(weeks, metrics.pct) + one('All time', metrics.pctAll) + one('Sign-ups', metrics.signupRate) + '</div>';
  }

  // One raid as a row: the day, the zone, a tinted outcome word (and "with notice" / "no notice" on a miss).
  const OUTCOME_CHIP = { present: ['green', 'Attended'], bench: ['grey', 'Bench'], fill_in: ['grey', 'Other team'], late: ['blue', 'Late'], left_early: ['blue', 'Left early'], late_left: ['blue', 'Late, left early'],
    missed: ['rose', 'Missed'], missed_notice: ['rose', 'Missed'], tentative: ['grey', 'Tentative'], no_signup: ['grey', 'No sign-up'] };
  function raidRowHtml(c) {
    const date = dateOfCell(c);
    const r = c.raid && typeof c.raid === 'object' ? c.raid : {};
    const pair = Object.prototype.hasOwnProperty.call(OUTCOME_CHIP, c.outcome) ? OUTCOME_CHIP[c.outcome] : ['grey', A().labelOf(c.outcome)];
    const note = c.outcome === 'missed' ? 'no notice' : c.outcome === 'missed_notice' ? 'with notice' : '';
    return '<div class="gs-pr-row gs-pr-raid"><span class="gs-pr-date">' + esc(G.ui.weekdayDay(date) || date) + '</span><span class="gs-pr-what">' + esc(r.zone || r.title || '') + '</span>' +
      '<span class="gs-pr-end">' + (note ? '<span class="gs-pr-mut">' + note + '</span>' : '') + '<span class="gs-hd-chip is-' + pair[0] + '">' + esc(pair[1] + (c.credit == null && LATE_TYPES.indexOf(c.outcome) >= 0 ? ' (awaiting review)' : '')) + '</span></span></div>';
  }
  function rowsOf(cells, max) {
    return cells.filter(function (c) { return c && c.outcome && !c.preStart; }).sort(function (x, y) { return dateOfCell(x) < dateOfCell(y) ? 1 : -1; }).slice(0, max);
  }

  // opts: { gid, pid, record (the roster record), state: { data, denied } | null }  ->  the section of the person page (T2)
  function sectionOf(opts) {
    const s = opts.state;
    const p = (opts.record && opts.record.person) || {};
    const isMe = !!p.isMe;
    const trial = p.status === 'trial' && !!(opts.record.can && opts.record.can.edit);
    const none = '<p class="gs-fine">' + esc(isMe ? 'Your attendance shows here after the first raid.' : 'Attendance shows here after the first raid.') + '</p>';
    const link = function () { return '<div class="gs-pr-linkrow"><a class="gs-fg-u" href="' + esc(G.router.format({ name: 'personatt', gid: opts.gid, pid: opts.pid })) + '">Full history</a></div>'; };
    if (!s) return { id: 'attendance', title: 'Attendance', bodyHtml: none };
    if (s.denied || !s.data) return { id: 'attendance', title: 'Attendance', bodyHtml: '<p class="gs-fine">Attendance for this person is visible to the members of their team.</p>' };
    const teams = Array.isArray(s.data.teams) ? s.data.teams : [];
    if (!teams.length) return { id: 'attendance', title: 'Attendance', bodyHtml: none };
    if (trial) {
      // A Trial: the figures are in the decision panel above, so only the raids since the trial started are listed here.
      const since = p.trialStart || '';
      const all = [].concat.apply([], teams.map(metricCells)).filter(function (c) { return !since || dateOfCell(c) >= since; });
      const rows = rowsOf(all, CARD_CELLS);
      return { id: 'attendance', title: 'Attendance', flush: true, metaHtml: since ? 'Since trial start &middot; ' + esc(rows.length === 1 ? '1 raid counted' : rows.length + ' raids counted') : '',
        bodyHtml: (rows.length ? rows.map(raidRowHtml).join('') : '<div class="gs-pr-pad"><p class="gs-fine">No raids since the trial started.</p></div>') + link() };
    }
    const body = teams.map(function (t) {
      const rows = rowsOf(metricCells(t), CARD_CELLS);
      return '<div class="gs-att-teamblock">' + (teams.length > 1 ? '<h3 class="gs-pr-team">' + esc(nameOfTeam(t.team)) + '</h3>' : '') + figuresHtml(t.metrics, t) +
        (rows.length ? rows.map(raidRowHtml).join('') : '<div class="gs-pr-pad"><p class="gs-fine">No raids yet.</p></div>') + '</div>';
    }).join('') + link();
    return { id: 'attendance', title: 'Attendance', flush: true, bodyHtml: body };
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
