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

  // The Roster record's figures: numbers over a hairline, each a caps label and a big value. The card shows three ("8 weeks" / "All time" / "Sign-ups").
  function figuresHtml(m, team) {
    const metrics = m || {};
    const weeks = team && typeof team.window === 'number' ? team.window + ' weeks' : 'Recent';
    return '<div class="gs-pr-figs is-three">' + figHtml(weeks, G.ui.percent(metrics.pct)) + figHtml('All time', G.ui.percent(metrics.pctAll)) + figHtml('Sign-ups', G.ui.percent(metrics.signupRate)) + '</div>';
  }
  function figHtml(label, value) { return '<div class="gs-pr-fig"><span class="gs-pr-cap">' + esc(label) + '</span><span class="gs-pr-num">' + esc(value) + '</span></div>'; }

  // One raid as a row: the day, the zone, the outcome as the same cell + word the attendance grid uses.
  function raidRowHtml(c) {
    const date = dateOfCell(c);
    const r = c.raid && typeof c.raid === 'object' ? c.raid : {};
    const pending = !!c.pending || (c.credit == null && LATE_TYPES.indexOf(c.outcome) >= 0);
    return '<div class="gs-pr-row gs-pr-raid"><span class="gs-pr-date">' + esc(G.ui.weekdayDay(date) || date) + '</span><span class="gs-pr-what">' + esc(r.zone || r.title || '') + '</span>' +
      '<span class="gs-pr-end">' + A().outcomeChipHtml(c.outcome, pending) + '</span></div>';
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

  // ── full history page (T2/Forge: the head, the figures, the week strip, the raid-by-raid list; one block per team) ──
  const WINDOWS = [4, 8, 'all'];
  const CREDIT_WORDS = { 1: 'Full', 0.5: 'Half', 0: 'None' };

  function ui() {
    const s = a();
    if (!s.personUi) s.personUi = { win: null, showAll: false };
    return s.personUi;
  }

  // The head, You line and sections the loot history page shares: opts { gd, pid, person (the Worker's), kind ('attendance' | 'loot') }.
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

  // The attendance page head: "Attendance" on a member's own record, the person's name in class colour for anyone else's. ONE chip at most, and
  // never the Raider chip (a Raider is the normal case): Trial, Reserve and Inactive, or You when it is the viewer's own record.
  function pageHead(gd, p, own, canMore) {
    const cls = p.class ? G.ui.className(p.class) : '';
    const bits = [gd.guild.name, cls].filter(Boolean);
    const chip = G.pages.person.headChipHtml({ status: p.status, isMe: !own && !!p.isMe });
    const items = canMore ? [{ label: 'How this is counted', data: { action: 'att-how' }, key: 'mi-pa-how' }] : [];
    return {
      title: own ? 'Attendance' : (p.name || 'Person'), titleClass: own ? '' : (p.class ? G.ui.classClass(p.class) : ''),
      context: bits.join(' - '), chipsHtml: chip,
      back: own ? null : { href: G.router.format({ name: 'section', gid: gd.guild.id, section: 'attendance' }), label: 'Attendance' },
      more: items.length ? { id: 'pa-more', key: 'pa-more', items: items } : null,
    };
  }

  function creditWord(cell, pending) {
    if (cell.preStart) return '-';
    if (pending) return 'Pending';
    if (cell.credit == null) return 'Not counted';
    return Object.prototype.hasOwnProperty.call(CREDIT_WORDS, cell.credit) ? CREDIT_WORDS[cell.credit] : G.ui.percent(cell.credit * 100);
  }

  function historyColumns(showReason) {
    const cols = [{ key: 'date', label: 'Date', primary: true }, { key: 'raid', label: 'Raid' }, { key: 'outcome', label: 'Outcome' }, { key: 'credit', label: 'Credit' }];
    if (showReason) cols.push({ key: 'reason', label: 'Officer reason' });
    return cols;
  }

  // One raid of the list. A raid from before the person joined is greyed, says "Before joining" and carries no credit (the grid draws it as an empty box).
  function historyRow(gid, cell) {
    const date = dateOfCell(cell);
    const rid = raidIdOf(cell);
    const zone = cell.raid && typeof cell.raid === 'object' && cell.raid.zone ? cell.raid.zone : '';
    const pending = !!cell.pending || (cell.credit == null && LATE_TYPES.indexOf(cell.outcome) >= 0);
    const day = G.ui.shortDay(date) || date;
    const dash = '<span class="gs-muted gs-dash">-</span>';
    const via = cell.via && typeof cell.via === 'object' && cell.via.name ? ' (' + cell.via.name + ')' : '';
    const word = cell.preStart ? 'Before joining' : A().labelOf(cell.outcome) + via + (pending ? ' (awaiting review)' : '');
    const box = cell.preStart ? '<span class="gs-cell gs-cell-blank" aria-hidden="true"></span>' : A().swatchHtml(cell.outcome, pending);
    const grey = function (html) { return cell.preStart ? '<span class="gs-pa-grey">' + html + '</span>' : html; };
    const outcome = '<span class="gs-outchip">' + box + '<span>' + esc(word) + '</span></span>';
    return {
      id: rid || date,
      sort: { date: date },
      cells: {
        date: grey(rid ? '<a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: rid })) + '">' + esc(day) + '</a>' : esc(day)),
        raid: grey(zone ? esc(zone) : dash), outcome: grey(outcome), credit: grey(esc(creditWord(cell, pending))), reason: cell.reason ? esc(cell.reason) : dash,
      },
    };
  }

  function windowSegsHtml(team, idx) {
    const selected = ui().win != null ? ui().win : (team && team.window);
    return '<div class="gs-fg-segs" role="group" aria-label="Time window">' + WINDOWS.map(function (w) {
      return '<button type="button" class="gs-fg-seg" data-action="pa-window" data-window="' + esc(w) + '" data-key="pawin-' + idx + '-' + esc(w) + '" aria-pressed="' + (String(selected) === String(w) ? 'true' : 'false') + '">' + (w === 'all' ? 'All time' : w + ' weeks') + '</button>';
    }).join('') + '</div>';
  }

  // The five figures: 4 weeks, 8 weeks, All time, Sign-ups, Streak. pcts = { 4: { teamId: pct }, 8: { ... } } from the extra window requests.
  function ownFiguresHtml(team, pcts) {
    const m = team.metrics || {};
    const tid = idOf(team.team);
    const at = function (n) {
      if (team.window === n) return m.pct;
      return pcts && pcts[n] && pcts[n][tid] != null ? pcts[n][tid] : null;
    };
    const streak = typeof m.streak === 'number' ? String(m.streak) : '-';
    return '<section class="gs-hd-panel gs-pa-figs" aria-label="Attendance figures"><div class="gs-pr-figs is-five">' + figHtml('4 weeks', G.ui.percent(at(4))) + figHtml('8 weeks', G.ui.percent(at(8))) +
      figHtml('All time', G.ui.percent(m.pctAll)) + figHtml('Sign-ups', G.ui.percent(m.signupRate)) + figHtml('Streak', streak) + '</div></section>';
  }

  // The person's cells in the grid's own shape, grouped by reset week with the Week grid's helper (A().gridOf).
  function stripCells(team) {
    return metricCells(team).filter(function (c) { return c && c.outcome; }).map(function (c) {
      return { raidId: raidIdOf(c), date: dateOfCell(c), weekStart: c.weekStart || dateOfCell(c), outcome: c.outcome, letter: c.letter, via: c.via, pending: !!c.pending, preStart: !!c.preStart, credit: c.credit };
    });
  }

  function stripPanelHtml(gid, team, idx) {
    const cells = stripCells(team);
    const grid = A().gridOf({ weeks: [] }, [{ cells: cells }]);
    grid.forEach(function (w) { w.cols.forEach(function (c) { c.extra = false; }); });
    const cm = A().cellMapOf({ cells: cells });
    const label = 'My attendance, ' + (team.window === 'all' ? 'all time' : 'last ' + team.window + ' weeks');
    let body;
    if (!grid.length) body = '<p class="gs-fg-mut gs-at-none">No raids in this window.</p>';
    else {
      const head1 = '<tr>' + grid.map(function (w) { return '<th scope="colgroup" colspan="' + w.cols.length + '" class="gs-at-wkh">' + esc(G.pages.attendanceGrid.weekLabel(w.weekStart)) + '</th>'; }).join('') + '</tr>';
      const head2 = '<tr>' + grid.map(function (w) { return w.cols.map(function (c, i) { return G.pages.attendanceGrid.dayHeadHtml(gid, c, i === 0); }).join(''); }).join('') + '</tr>';
      const row = '<tr>' + grid.map(function (w) { return w.cols.map(function (c, i) { return '<td class="gs-at-d' + (i === 0 ? ' is-wk' : '') + '">' + A().cellHtml(cm[c.id] || null, c.date) + '</td>'; }).join(''); }).join('') + '</tr>';
      body = '<div class="gs-at-scroll"><table class="gs-at-grid gs-at-solo" aria-label="' + esc(label) + '"><thead>' + head1 + head2 + '</thead><tbody>' + row + '</tbody></table></div>';
    }
    return '<section class="gs-hd-panel gs-at-mx gs-pa-strip" aria-label="' + esc(label) + '"><div class="gs-at-bar"><div class="gs-at-barl">' + windowSegsHtml(team, idx) + '</div><div class="gs-at-barl">' +
      '<button type="button" class="gs-btn" data-action="att-legend" data-key="pa-legend-' + idx + '" aria-haspopup="dialog">Legend</button></div></div>' + body + '</section>';
  }

  function listPanelHtml(gid, team, showReason) {
    const cells = metricCells(team).filter(function (c) { return c && c.outcome; }).sort(function (x, y) { return dateOfCell(x) < dateOfCell(y) ? 1 : -1; });
    if (!cells.length) return '';
    const rows = cells.map(function (c) { return historyRow(gid, c); });
    return '<section class="gs-hd-panel gs-pa-list" aria-labelledby="pa-list-h"><h2 class="gs-hd-sl" id="pa-list-h"><span>Raid by raid</span></h2>' +
      G.ui.dataTableHtml({ label: 'Raid by raid', columns: historyColumns(showReason), rows: rows, limit: 10, showAll: !!ui().showAll, showAllAction: 'pa-showall', noun: 'raids' }) + '</section>';
  }

  // opts: { guildData, pid, data (GET /attendance/person/:pid), pcts, own (the member's own record: h1 "Attendance"), alert }
  function personAttHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data;
    const p = data.person || {};
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const own = !!opts.own;
    const rank = G.pages.ranks ? G.pages.ranks.personBoxSection(Object.assign({}, p, { id: opts.pid }), teams) : null;
    const canMore = !!(A().attState().policy && A().attState().policy[gid]);
    let body = '';
    teams.forEach(function (t, i) {
      const showReason = G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', idOf(t.team));
      body += (teams.length > 1 ? '<h2 class="gs-hd-sl gs-pa-team"><span>' + esc(nameOfTeam(t.team) || 'Team') + '</span></h2>' : '') +
        ownFiguresHtml(t, opts.pcts) + stripPanelHtml(gid, t, i) + (listPanelHtml(gid, t, showReason) || '');
    });
    if (!teams.length) body = G.ui.emptyStateHtml({ kind: 'first', icon: 'attendance', title: 'No attendance yet', text: 'Attendance shows here after the first raid.' });
    return '<div class="gs-page gs-list-page gs-forge gs-at-page gs-pa-page' + (own ? ' is-own' : '') + '">' + G.ui.pageHeadHtml(pageHead(gd, p, own, canMore)) + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      body + (rank ? G.ui.objectSectionHtml(rank) : '') + '</div>';
  }

  // ── data ──
  function fetchPerson(gid, pid, win) {
    return G.api.get(A().apiBase(gid) + '/attendance/person/' + encodeURIComponent(pid) + (win != null ? '?window=' + encodeURIComponent(win) : ''));
  }

  function pctsOf(resp, n) {
    const out = {};
    (resp && Array.isArray(resp.teams) ? resp.teams : []).forEach(function (t) { if (t.window === n && t.metrics) out[idOf(t.team)] = t.metrics.pct; });
    return out;
  }

  // The chosen window's response drives the strip and the list; the 4 and 8 week figures come from their own requests (skipped when already in hand).
  function load(r, gd) {
    const gid = gd.guild.id;
    const win = ui().win;
    if (!A().attState().policy || !A().attState().policy[gid]) A().loadPolicy(gid).then(function () { G.app.render(); });
    return fetchPerson(gid, r.pid, win).then(function (data) {
      const pcts = { 4: pctsOf(data, 4), 8: pctsOf(data, 8) };
      const extra = [4, 8].filter(function (n) { return data.teams && data.teams.length && !Object.keys(pcts[n]).length; }).map(function (n) {
        return fetchPerson(gid, r.pid, n).then(function (res) { pcts[n] = pctsOf(res, n); }, function () { return null; });
      });
      return Promise.all(extra).then(function () {
        a().personAtt = { gid: gid, pid: r.pid, data: data, pcts: pcts };
        return null;
      });
    }, function (err) {
      if (err && (err.status === 401 || err.status === 403 || err.status === 404)) throw err;
      a().personAtt = { gid: gid, pid: r.pid, data: null, error: (err && err.message) || "The server didn't answer." };
      return null;
    });
  }

  // own: the member's own record, opened from the Attendance section (mainOwn); main is the personatt route's page.
  function render(r, gd, own) {
    const x = a().personAtt;
    if (!x || x.gid !== gd.guild.id || x.pid !== r.pid) return A().skeletonHtml();
    if (x.error) return A().errorHtml(x.error);
    return personAttHtml({ guildData: gd, pid: r.pid, data: x.data, pcts: x.pcts, own: !!own, alert: G.app.state.pageAlert });
  }
  function main(r, gd) { return render(r, gd, false); }
  function mainOwn(r, gd) { return render(r, gd, true); }

  function nameFor(r) {
    const x = a().personAtt;
    if (!x || x.pid !== r.pid || !x.data || !x.data.person) return '';
    const p = x.data.person;
    return p.name || (p.main && p.main.name) || '';
  }

  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };
  G.handlers.click['pa-window'] = function (el) {
    const raw = el.getAttribute('data-window');
    ui().win = raw === 'all' ? 'all' : Number(raw);
    G.app.routeAll({ force: true });
  };
  G.handlers.click['pa-showall'] = function () { ui().showAll = true; G.app.render(); };

  G.pages.personAtt = { sectionOf: sectionOf, subHead: subHead, subYou: subYou, cardHtml: cardHtml, personAttHtml: personAttHtml, loadCard: loadCard, cardState: cardState, nameFor: nameFor, load: load, main: main, mainOwn: mainOwn };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
