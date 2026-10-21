// ── PAGE: TEAM ATTENDANCE, Week grid view ──
// One panel: the bar, then the table: Name, the window %, Streak, then the raid days grouped by reset week (newest right). The Name and % columns
// stick while the days scroll sideways; the page scrolls the table to its newest raids after each render (pages-attendance.js afterRender).
// The page frame, the bar, sorting and the cell builder live in pages-attendance.js. Nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};

  function A() { return G.pages.attendance; }
  function plural(n, one, many) { return A().plural(n, one, many); }

  // "Week of Sep 8" for the reset week that starts on this date.
  function weekLabel(weekStart) {
    const day = G.ui.shortDay(weekStart);
    return day ? 'Week of ' + day : 'Week';
  }

  function windowLabel(w) { return w === 'all' ? 'All time' : (w ? w + ' weeks' : 'Window'); }

  // A sort head: a real button, at least 36 px, with aria-sort on its cell.
  function sortHeadHtml(col, label, sort, cls) {
    const aria = A().ariaSort(sort, col);
    const dir = aria === 'descending' ? 'desc' : aria === 'ascending' ? 'asc' : '';
    return '<th scope="col" rowspan="2" class="' + cls + '"' + (aria ? ' aria-sort="' + aria + '"' : '') + '><button type="button" class="gs-sort" data-action="att-sort" data-col="' + col + '" data-key="asort-' + col + '"' + (dir ? ' data-dir="' + dir + '"' : '') + '>' +
      esc(label) + '<span class="gs-sort-ind" aria-hidden="true"></span></button></th>';
  }

  // The day head: weekday over "Sep 9", linking to the raid (a raid the team did not hold is only labelled).
  function dayHeadHtml(gid, col, first) {
    const wd = (G.ui.weekdayDay(col.date) || '').split(' ')[0];
    const inner = '<span class="gs-at-wd">' + esc(wd) + '</span><span>' + esc(G.ui.shortDay(col.date) || col.date) + '</span>';
    const cls = 'gs-at-dh' + (first ? ' is-wk' : '');
    if (col.extra) return '<th scope="col" class="' + cls + '"><span class="gs-at-dhl" title="Other-team attendance">' + inner + '</span></th>';
    return '<th scope="col" class="' + cls + '"><a class="gs-at-dhl" href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: col.id })) + '" aria-label="' + esc((G.ui.weekdayDay(col.date) || col.date) + ', open raid') + '">' + inner + '</a></th>';
  }

  function streakHtml(p) {
    const n = typeof p.streak === 'number' ? p.streak : 0;
    return p.streakFlag ? '<span class="gs-hd-chip is-rose">' + esc(n) + '<span class="gs-sr"> raids missed in a row, flagged</span></span>' : '<span class="gs-at-streak">' + esc(n) + '</span>';
  }

  function pctHtml(p) {
    const v = G.ui.percent(p.pct);
    return p.pending > 0 ? esc(v) + '<span class="gs-sr">, ' + esc(plural(p.pending, 'raid', 'raids')) + ' awaiting review</span>' : esc(v);
  }

  function tableHtml(gid, data, people, view) {
    const grid = A().gridOf(data, people);
    const head1 = '<tr>' + sortHeadHtml('player', 'Name', view.sort, 'gs-at-c-name') + sortHeadHtml('pct', windowLabel(data.window), view.sort, 'gs-at-c-pct') + sortHeadHtml('streak', 'Streak', view.sort, 'gs-at-c-streak') +
      grid.map(function (w) { return '<th scope="colgroup" colspan="' + w.cols.length + '" class="gs-at-wkh">' + esc(weekLabel(w.weekStart)) + '</th>'; }).join('') + '</tr>';
    const head2 = '<tr>' + grid.map(function (w) { return w.cols.map(function (c, i) { return dayHeadHtml(gid, c, i === 0); }).join(''); }).join('') + '</tr>';
    const rows = people.map(function (p) {
      const cm = A().cellMapOf(p);
      return '<tr' + (p.isMe ? ' class="is-you"' : '') + '><th scope="row" class="gs-at-c-name">' + A().nameLinkHtml(gid, p, true) + '</th>' +
        '<td class="gs-at-c-pct">' + pctHtml(p) + '</td><td class="gs-at-c-streak">' + streakHtml(p) + '</td>' +
        grid.map(function (w) { return w.cols.map(function (c, i) { return '<td class="gs-at-d' + (i === 0 ? ' is-wk' : '') + '">' + A().cellHtml(cm[c.id] || null, c.date) + '</td>'; }).join(''); }).join('') + '</tr>';
    }).join('');
    return '<div class="gs-at-scroll"><table class="gs-at-grid" aria-label="Attendance by raid"><thead>' + head1 + head2 + '</thead><tbody>' + rows + '</tbody></table></div>';
  }

  // m: { gid, data, people (inactive already filtered), view }
  function gridHtml(m) {
    const sorted = A().sortPeople(m.people, m.view.sort);
    return '<section class="gs-hd-panel gs-at-mx" aria-label="Attendance by raid">' + A().barHtml(m.data, m.view) +
      (sorted.length ? tableHtml(m.gid, m.data, sorted, m.view) : '<p class="gs-fg-mut gs-at-none">No one matches these filters.</p>') + '</section>';
  }

  G.pages.attendanceGrid = {
    gridHtml: gridHtml,
    tableHtml: tableHtml,
    weekLabel: weekLabel,
    dayHeadHtml: dayHeadHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
