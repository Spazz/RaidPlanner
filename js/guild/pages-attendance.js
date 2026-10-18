// ── PAGE: TEAM ATTENDANCE (+ the outcome vocabulary every attendance page shares) ──
// The letters, words, colours-by-class and cell/chip builders for outcomes live here; pages-raid, pages-review,
// pages-person-attendance and pages-raids use them. The page itself: header, window switch, legend, a sortable table
// of people with the recent-raids grid grouped by reset week (phone: person cards), "How this is counted".
// Data: GET /attendance/team?team=&window= and GET /attendance/policy (see the Phase 3 spec, API section).
// Above the grid sits the Watch list card (data.watch: people under the policy's `watch` thresholds), for viewers who can review the team.
// This file is safe to load alone (the letters-table parity test does): nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  // Outcome ids in legend order, with the one-letter code each cell carries (the letter is never optional: colour is
  // not the only signal). Mirrors worker/attendance-policy.js; guild-attendance-rules-tests.js checks the parity.
  const OUTCOMES = ['present', 'bench', 'missed', 'missed_notice', 'late', 'left_early', 'late_left', 'fill_in', 'tentative', 'no_signup'];
  const LETTERS = { present: 'P', bench: 'B', missed: 'M', missed_notice: 'N', late: 'L', left_early: 'E', late_left: 'LE', fill_in: 'F', tentative: 'T', no_signup: '-' };
  const OUTCOME_LABELS = {
    present: 'Present', bench: 'Bench', missed: 'Missed', missed_notice: 'Missed with notice', late: 'Late', left_early: 'Left early',
    late_left: 'Late and left early', fill_in: 'Other team', tentative: 'Tentative', no_signup: 'No sign-up',
  };
  const KIND_LABELS = { signed: 'Signed up', late: 'Late', standby: 'Standby', bench: 'Bench', tentative: 'Tentative', absence: 'Absence' };
  const FLAG_LABELS = { no_show: 'No show', late: 'Late', left_early: 'Left early', unmatched: 'Unmatched' };
  const DEFAULT_CREDITS = [{ id: 'full', label: 'Full', value: 1 }, { id: 'half', label: 'Half', value: 0.5 }, { id: 'none', label: 'None', value: 0 }];
  const ATTENDED_OUTCOMES = ['present', 'bench', 'late', 'left_early', 'late_left', 'fill_in'];
  const COLUMNS = ['player', 'pct', 'all', 'signup', 'streak', 'last'];
  const DEFAULT_SORT = { column: 'player', dir: 'asc' };
  const PHONE_CELLS = 8;
  const RAID_PAGE_GUARD = 30;

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function st() { return G.app.state; }
  function attState() { const s = st(); if (!s.att) s.att = {}; return s.att; }
  function apiBase(gid) { return '/api/guild/' + encodeURIComponent(gid); }
  function letterOf(outcome) { return has(LETTERS, outcome) ? LETTERS[outcome] : '?'; }
  function labelOf(outcome) { return has(OUTCOME_LABELS, outcome) ? OUTCOME_LABELS[outcome] : String(outcome == null ? '' : outcome); }
  function outClass(outcome) { return has(LETTERS, outcome) ? 'gs-out-' + outcome : 'gs-out-none'; }
  function teamOf(gd, id) { return (gd && Array.isArray(gd.teams) ? gd.teams : []).filter(function (t) { return t.id === id; })[0] || null; }
  function dateOf(x) { return x && (x.date || x.raidOn) ? String(x.date || x.raidOn) : ''; }

  // ── outcome builders ──
  // A small coloured letter box (decorative; the word or aria-label next to it carries the meaning).
  function swatchHtml(outcome, pending) {
    return '<span class="gs-cell ' + outClass(outcome) + '" aria-hidden="true">' + esc(letterOf(outcome)) + (pending ? '?' : '') + '</span>';
  }

  // Letter box + word: "P Present". `pending` adds the question mark and the words "awaiting review".
  function outcomeChipHtml(outcome, pending) {
    return '<span class="gs-outchip">' + swatchHtml(outcome, pending) + '<span>' + esc(labelOf(outcome)) + (pending ? ' (awaiting review)' : '') + '</span></span>';
  }

  // One grid cell. cell = { raidId, date, outcome, letter, via, pending, preStart } or null (no record that raid).
  function cellHtml(cell, date) {
    const day = G.ui.weekdayDay(dateOf(cell) || date) || (dateOf(cell) || date || '');
    if (!cell || cell.preStart || !cell.outcome) {
      const why = cell && cell.preStart ? 'before joining' : 'no record';
      return '<span class="gs-cell gs-cell-blank" role="img" aria-label="' + esc(day + ': ' + why) + '" title="' + esc(day + ': ' + why) + '"></span>';
    }
    let letter = typeof cell.letter === 'string' && cell.letter ? cell.letter : letterOf(cell.outcome);
    if (cell.pending && letter.slice(-1) !== '?') letter += '?';
    const viaName = cell.via ? (typeof cell.via === 'object' ? cell.via.name : cell.via) : '';
    const via = cell.via ? ' (' + (viaName || 'another team') + ')' : '';
    const text = day + ': ' + labelOf(cell.outcome) + via + (cell.pending ? ', awaiting review' : '');
    return '<span class="gs-cell ' + outClass(cell.outcome) + (cell.pending ? ' is-pending' : '') + '" role="img" aria-label="' + esc(text) + '" title="' + esc(text) + '">' + esc(letter) + '</span>';
  }

  function legendHtml() {
    return '<ul class="gs-legend-list" aria-label="Legend">' + OUTCOMES.map(function (o) {
      return '<li class="gs-legend-item">' + swatchHtml(o, false) + '<span>' + esc(labelOf(o)) + '</span></li>';
    }).join('') + '<li class="gs-legend-item"><span class="gs-cell gs-cell-blank" aria-hidden="true"></span><span>Before joining</span></li></ul>';
  }

  function creditText(credit, pending) {
    if (pending || credit == null) return pending ? 'Pending' : 'Not counted';
    return G.ui.percent(credit * 100);
  }

  function flagChipsHtml(flags) {
    return (Array.isArray(flags) ? flags : []).map(function (f) {
      return '<span class="gs-chip gs-chip-flag">' + esc(has(FLAG_LABELS, f) ? FLAG_LABELS[f] : f) + '</span>';
    }).join('');
  }

  // ── sorting ──
  function sortValue(p, col) {
    switch (col) {
      case 'pct': return p.pct;
      case 'all': return p.pctAll;
      case 'signup': return p.signupRate;
      case 'streak': return p.streak;
      case 'last': return p.lastAttended;
      default: return String(p.name == null ? '' : p.name);
    }
  }

  function compareValues(a, b) {
    if (typeof a === 'string' || typeof b === 'string') return String(a).localeCompare(String(b), 'en');
    return a - b;
  }

  // Empty values (a dash) sort last in either direction; ties fall back to the name.
  function sortPeople(people, sort) {
    const s = sort || DEFAULT_SORT;
    const dir = s.dir === 'desc' ? -1 : 1;
    return (Array.isArray(people) ? people : []).slice().sort(function (a, b) {
      const va = sortValue(a, s.column);
      const vb = sortValue(b, s.column);
      const ea = va == null || va === '';
      const eb = vb == null || vb === '';
      if (ea !== eb) return ea ? 1 : -1;
      const c = ea ? 0 : dir * compareValues(va, vb);
      return c || String(a.name == null ? '' : a.name).localeCompare(String(b.name == null ? '' : b.name), 'en');
    });
  }

  function nextSort(sort, column) {
    if (sort && sort.column === column) return { column: column, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    return { column: column, dir: column === 'player' ? 'asc' : 'desc' };
  }

  function ariaSort(sort, column) {
    if (!sort || sort.column !== column) return '';
    return sort.dir === 'desc' ? 'descending' : 'ascending';
  }

  // ── the recent-raids grid: columns = raids grouped by reset week, newest right ──
  // Raids the team did not hold (an Other-team cell on a date with no home raid) become extra columns in their week.
  function gridOf(data, people) {
    const weeks = {};
    const known = {};
    function addCol(weekStart, col) {
      if (!weeks[weekStart]) weeks[weekStart] = { weekStart: weekStart, cols: [] };
      weeks[weekStart].cols.push(col);
      known[col.id] = true;
    }
    (Array.isArray(data.weeks) ? data.weeks : []).forEach(function (w) {
      (Array.isArray(w.raids) ? w.raids : []).forEach(function (r) {
        addCol(w.weekStart, { id: r.id, date: r.raidOn, zone: r.zone || '', extra: false });
      });
    });
    people.forEach(function (p) {
      (Array.isArray(p.cells) ? p.cells : []).forEach(function (c) {
        if (!c || known[c.raidId]) return;
        addCol(c.weekStart || dateOf(c), { id: c.raidId, date: dateOf(c), zone: '', extra: true });
      });
    });
    return Object.keys(weeks).sort().map(function (k) {
      weeks[k].cols.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      return weeks[k];
    });
  }

  function cellMapOf(p) {
    const m = {};
    (Array.isArray(p.cells) ? p.cells : []).forEach(function (c) { if (c) m[c.raidId] = c; });
    return m;
  }

  function weekLabel(weekStart) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(weekStart || ''));
    return m ? 'Wk ' + Number(m[1]) + '/' + Number(m[2]) : 'Wk';
  }

  function colHeadHtml(gid, col) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(col.date || '');
    const wd = (G.ui.weekdayDay(col.date) || '').split(' ')[0];
    const inner = '<span class="gs-att-wd">' + esc(wd) + '</span><span>' + esc(m ? Number(m[1]) + '/' + Number(m[2]) : col.date) + '</span>';
    if (col.extra) return '<th scope="col" class="gs-att-col"><span title="Other-team attendance">' + inner + '</span></th>';
    return '<th scope="col" class="gs-att-col"><a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: col.id })) + '" aria-label="' + esc('Raid on ' + (G.ui.weekdayDay(col.date) || col.date)) + '">' + inner + '</a></th>';
  }

  function statName(p) {
    return '<span class="gs-att-name">' + G.ui.classNameHtml(p.name, p.class) + (p.isMe ? '<span class="gs-you">You</span>' : '') + '</span>';
  }

  function streakHtml(p) {
    const n = typeof p.streak === 'number' ? p.streak : 0;
    return '<span class="gs-streak' + (p.streakFlag ? ' is-flag' : '') + '">' + esc(n) + (p.streakFlag ? '<span class="gs-sr"> raids missed in a row, flagged</span>' : '') + '</span>';
  }

  function pctHtml(p, key) {
    const v = G.ui.percent(p[key]);
    if (key === 'pct' && p.pending > 0) return esc(v) + '<span class="gs-sr">, ' + esc(plural(p.pending, 'raid', 'raids')) + ' awaiting review</span>';
    return esc(v);
  }

  function windowShort(w) { return w === 'all' ? 'All time' : (w ? w + '-wk' : 'Window') + ' %'; }

  function sortHeaderHtml(col, label, sort) {
    const aria = ariaSort(sort, col);
    const dir = aria === 'descending' ? 'desc' : aria === 'ascending' ? 'asc' : '';
    return '<th scope="col" rowspan="2"' + (aria ? ' aria-sort="' + aria + '"' : '') + '><button type="button" class="gs-sort" data-action="att-sort" data-col="' + col + '" data-key="asort-' + col + '"' + (dir ? ' data-dir="' + dir + '"' : '') + '>' +
      esc(label) + '<span class="gs-sort-ind" aria-hidden="true"></span></button></th>';
  }

  function tableHtml(gid, data, people, view) {
    const grid = gridOf(data, people);
    const labels = { player: 'Player', pct: windowShort(data.window), all: 'All time %', signup: 'Sign-up rate', streak: 'Streak', last: 'Last attended' };
    const head1 = '<tr>' + COLUMNS.map(function (c) { return sortHeaderHtml(c, labels[c], view.sort); }).join('') +
      grid.map(function (w) { return '<th scope="colgroup" colspan="' + w.cols.length + '" class="gs-att-week">' + esc(weekLabel(w.weekStart)) + '</th>'; }).join('') + '</tr>';
    const head2 = '<tr>' + grid.map(function (w) { return w.cols.map(function (c) { return colHeadHtml(gid, c); }).join(''); }).join('') + '</tr>';
    const rows = people.map(function (p) {
      const cm = cellMapOf(p);
      return '<tr><th scope="row" class="gs-cell-strong">' + statName(p) + '<span class="gs-char-sub">' + esc(G.ui.statusLabel(p.status)) + '</span></th>' +
        '<td class="gs-nowrap">' + pctHtml(p, 'pct') + '</td><td class="gs-nowrap">' + pctHtml(p, 'pctAll') + '</td><td class="gs-nowrap">' + pctHtml(p, 'signupRate') + '</td>' +
        '<td>' + streakHtml(p) + '</td><td class="gs-nowrap">' + esc(G.ui.shortDay(p.lastAttended) || '-') + '</td>' +
        grid.map(function (w) { return w.cols.map(function (c) { return '<td class="gs-att-cell">' + cellHtml(cm[c.id] || null, c.date) + '</td>'; }).join(''); }).join('') + '</tr>';
    }).join('');
    return '<div class="gs-table-wrap gs-att-table"><table class="gs-table gs-table-att" aria-label="Team attendance"><thead>' + head1 + head2 + '</thead><tbody>' + rows + '</tbody></table></div>';
  }

  function cardsHtml(gid, people) {
    return '<ul class="gs-att-cards" aria-label="Team attendance">' + people.map(function (p) {
      const cells = (Array.isArray(p.cells) ? p.cells : []).slice().sort(function (a, b) { return dateOf(a) < dateOf(b) ? -1 : 1; }).slice(-PHONE_CELLS);
      return '<li class="gs-att-card"><div class="gs-card-top">' + statName(p) + G.ui.statusChipHtml(p.status) + '</div>' +
        '<dl class="gs-att-stats"><div><dt>Window</dt><dd>' + pctHtml(p, 'pct') + '</dd></div><div><dt>All time</dt><dd>' + pctHtml(p, 'pctAll') + '</dd></div>' +
        '<div><dt>Sign-up</dt><dd>' + pctHtml(p, 'signupRate') + '</dd></div><div><dt>Streak</dt><dd>' + streakHtml(p) + '</dd></div></dl>' +
        '<div class="gs-att-strip">' + cells.map(function (c) { return cellHtml(c, dateOf(c)); }).join('') + '</div></li>';
    }).join('') + '</ul>';
  }

  function windowSwitchHtml(data) {
    const policy = data.policy || {};
    const weeks = Array.isArray(policy.switchWeeks) && policy.switchWeeks.length ? policy.switchWeeks : [8, 12];
    const items = weeks.map(function (n) { return { value: n, label: n + ' weeks' }; }).concat([{ value: 'all', label: 'All time' }]);
    return '<div class="gs-segs" role="group" aria-label="Time window">' + items.map(function (it) {
      return '<button type="button" class="gs-seg" data-action="att-window" data-window="' + esc(it.value) + '" data-key="awin-' + esc(it.value) + '" aria-pressed="' + (String(data.window) === String(it.value) ? 'true' : 'false') + '">' + esc(it.label) + '</button>';
    }).join('') + '</div>';
  }

  // ── "How this is counted": the resolved policy as plain sentences ──
  function pol(p, path, fallback) {
    let cur = p;
    const keys = path.split('.');
    for (let i = 0; i < keys.length; i++) {
      if (!cur || typeof cur !== 'object' || !has(cur, keys[i])) return fallback;
      cur = cur[keys[i]];
    }
    return cur;
  }

  function creditListText(values) {
    return (Array.isArray(values) && values.length ? values : DEFAULT_CREDITS).map(function (v) { return v.label + ' ' + Math.round(v.value * 100) + '%'; }).join(', ');
  }

  function describePolicy(p) {
    const lines = [];
    const statuses = pol(p, 'expected.statuses', ['raider', 'trial']);
    lines.push(pol(p, 'expected.mode', 'signedUp') === 'statuses'
      ? 'Expected: everyone with status ' + statuses.map(function (s) { return G.ui.statusLabel(s); }).join(', ') + ' is expected, signed up or not. No sign-up counts as Missed.'
      : 'Expected: only people who sign up are expected.');
    lines.push(pol(p, 'noSignup', 'shown') === 'shown' ? 'A roster person who is not expected and did not sign up shows as No sign-up and is left out of the percentage.' : 'A roster person who is not expected and did not sign up is not shown.');
    lines.push(pol(p, 'tentative', 'asNoSignup') === 'asSignedUp' ? 'A Tentative sign-up counts as signed up.' : 'A Tentative sign-up counts like no sign-up; if they show up they get normal credit.');
    lines.push(pol(p, 'absence', 'missedWithNotice') === 'excused' ? 'An Absence sign-up is left out of the percentage.' : 'An Absence sign-up counts as Missed, tagged "with notice".');
    lines.push(pol(p, 'bench', 'full') === 'excluded' ? 'Bench (sign-up or plan) is left out of the percentage.' : 'Bench (sign-up or plan) gets full credit.');
    lines.push(pol(p, 'lateSignup', 'fullCreditNoFlag') === 'flagLikeOthers' ? 'A Late sign-up who arrives late is flagged like anyone else.' : 'A Late sign-up who arrives late is Present with full credit and no flag. Leaving early is still flagged.');
    lines.push('Late or left early means missing the first or last boss pull of the raid (wipes count, all of the raid\'s logs together). An officer picks the credit: ' + creditListText(pol(p, 'credit.values', null)) + '.');
    const fill = pol(p, 'fillIn', 'always');
    lines.push(fill === 'recordOnly' ? 'Raiding with another team is shown but never counted.'
      : fill === 'homeIfNoRaid' ? 'Raiding with another team counts for the home team only when the home team had no raid that day.'
        : 'Raiding with another team always counts for the home team, and replaces a missed or no-sign-up cell on the same day.');
    const weeks = pol(p, 'window.defaultWeeks', 8);
    lines.push('The main percentage covers the last ' + weeks + ' full reset weeks, including this one. All time is always available.');
    lines.push(pol(p, 'effectiveStart', 'laterOfJoinAndFirst') === 'joinDate' ? 'Raids before a person\'s join date do not count.' : 'Raids before the later of a person\'s join date and first attended raid do not count.');
    const streak = pol(p, 'streakFlagAt', 4);
    if (streak > 0) lines.push('A streak of ' + streak + ' missed raids in a row is highlighted.');
    return lines;
  }

  function howCountedHtml(policyView, teamId) {
    const resolved = policyView && policyView.resolved && policyView.resolved[teamId] ? policyView.resolved[teamId] : (policyView && policyView.defaults) || null;
    if (!resolved) return '';
    return '<details class="gs-how"><summary>How this is counted</summary><ul class="gs-bullets">' + describePolicy(resolved).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>';
  }

  // ── the Watch list card ──
  // data.watch is null (the viewer cannot review the team, or both thresholds are off) or { below, dropBy, window, previousFrom, entries }.
  // A policy fraction as typed percent: 0.75 -> 75, 0.125 -> 12.5.
  function watchPoints(fraction) { return Math.round(fraction * 1000) / 10; }

  // "Below 75% or down 15+ points against the previous 8 weeks": only the checks that are on.
  function watchRuleText(w) {
    const hasBelow = typeof w.below === 'number';
    const hasDrop = typeof w.dropBy === 'number';
    const against = ' against the previous ' + (typeof w.window === 'number' ? plural(w.window, 'week', 'weeks') : 'period');
    if (hasBelow && hasDrop) return 'Below ' + watchPoints(w.below) + '% or down ' + watchPoints(w.dropBy) + '+ points' + against;
    if (hasBelow) return 'Below ' + watchPoints(w.below) + '%';
    if (hasDrop) return 'Down ' + watchPoints(w.dropBy) + '+ points' + against;
    return 'No watch rule is set';
  }

  function watchReasonChips(w, reasons) {
    const labels = {
      below: typeof w.below === 'number' ? 'Below ' + watchPoints(w.below) + '%' : 'Below the line',
      drop: typeof w.dropBy === 'number' ? 'Down ' + watchPoints(w.dropBy) + '+ points' : 'Dropped',
    };
    return (Array.isArray(reasons) ? reasons : []).filter(function (r) { return has(labels, r); })
      .map(function (r) { return '<span class="gs-chip gs-chip-flag">' + esc(labels[r]) + '</span>'; }).join('');
  }

  function watchEntryHtml(gid, w, e) {
    const cls = G.ui.classClass(e.class);
    const drop = typeof e.drop === 'number' && e.drop > 0 ? Math.round(e.drop) : 0;
    const was = typeof e.previousPct === 'number' ? '<span class="gs-watch-was">was ' + esc(G.ui.percent(e.previousPct)) + (drop ? ', down ' + esc(plural(drop, 'point', 'points')) : '') + '</span>' : '';
    const who = e.playerId ? '<a class="gs-char-link' + (cls ? ' ' + cls : '') + '" href="' + esc(G.router.format({ name: 'personatt', gid: gid, pid: e.playerId })) + '">' + esc(e.name) + '</a>' : G.ui.classNameHtml(e.name, e.class);
    return '<li class="gs-watch-item"><div class="gs-watch-who">' + who +
      '<span class="gs-char-sub">' + esc(G.ui.statusLabel(e.status)) + '</span></div>' +
      '<div class="gs-watch-pct"><span class="gs-watch-num">' + esc(G.ui.percent(e.pct)) + '</span>' + was + '</div>' +
      '<div class="gs-watch-counts">Missed ' + esc(e.missed || 0) + ', with notice ' + esc(e.missedNotice || 0) + (typeof e.counted === 'number' ? '<span class="gs-fine"> of ' + esc(plural(e.counted, 'raid', 'raids')) + '</span>' : '') + '</div>' +
      '<div class="gs-pills">' + watchReasonChips(w, e.reasons) + '</div></li>';
  }

  // The card stays when nobody is on the list (an empty feature stays visible); no card at all when watch is null.
  function watchHtml(gid, watch) {
    if (!watch || typeof watch !== 'object') return '';
    const entries = Array.isArray(watch.entries) ? watch.entries : [];
    return '<section class="gs-card-sec gs-watch" aria-labelledby="att-watch-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="att-watch-h">Watch list</h2>' +
      (entries.length ? '<span class="gs-fine">' + esc(plural(entries.length, 'person', 'people')) + '</span>' : '') + '</div><div class="gs-card-sec-body">' +
      '<p class="gs-fine">' + esc(watchRuleText(watch)) + '</p>' +
      (entries.length ? '<ul class="gs-watch-list" aria-label="Watch list">' + entries.map(function (e) { return watchEntryHtml(gid, watch, e); }).join('') + '</ul>'
        : '<p class="gs-empty">Nobody is on the watch list.</p>') + '</div></section>';
  }

  // ── stale raids: recalculate banner ──
  function staleBannerHtml(n, canEdit, progress) {
    if (progress && progress.running) {
      return '<div class="gs-notice" role="status"><span>Recalculating ' + esc(progress.done) + ' of ' + esc(progress.total) + '...</span></div>';
    }
    if (!(n > 0)) return '';
    return '<div class="gs-notice gs-stale-banner" role="status"><span>Rules or roster changed under ' + esc(plural(n, 'raid', 'raids')) + '. Their results are from before the change.</span>' +
      (canEdit ? '<button type="button" class="gs-btn gs-btn-sm" data-action="att-recalc" data-key="att-recalc">Recalculate ' + esc(plural(n, 'raid', 'raids')) + '</button>' : '') + '</div>';
  }

  // ── the page ──
  function headerHtml(gd, teamId, data) {
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = teamOf(gd, teamId);
    const people = Array.isArray(data.people) ? data.people : [];
    const sub = (several && team ? esc(team.name) + ' &middot; ' : esc(gd.guild.name) + ' &middot; ') + esc(plural(people.length, 'person', 'people'));
    const canReview = G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', teamId);
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', teamId);
    const actions = (canReview ? '<a class="gs-btn" href="' + esc(G.router.format({ name: 'review', gid: gd.guild.id })) + '">Review queue' + (data.awaitingReview > 0 ? ' (' + esc(data.awaitingReview) + ')' : '') + '</a>' : '') +
      (canEdit ? '<a class="gs-btn" href="' + esc(G.router.format({ name: 'backfill', gid: gd.guild.id })) + '">Backfill</a>' : '');
    return '<div class="gs-roster-head"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Attendance</h1><p class="gs-sub">' + sub + '</p></div>' +
      (actions ? '<div class="gs-roster-actions">' + actions + '</div>' : '') + '</div>';
  }

  function noAccessHtml(gd, teamId) {
    const team = teamOf(gd, teamId);
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Attendance</h1></div><section class="gs-empty-card"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('attendance', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg">Attendance is for the team\'s members</h2><p class="gs-lead gs-lead-sm">Attendance for ' + esc(team ? team.name : 'this team') + ' is visible to the people who have a character on it.</p></section></div>';
  }

  function emptyHtml(canEdit, gid) {
    return '<section class="gs-empty-card" aria-labelledby="att-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('attendance', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="att-empty-h">No attendance yet</h2>' +
      '<p class="gs-lead gs-lead-sm">' + (canEdit ? 'Attendance builds up from raids. Add a raid with its Raid-Helper event and Warcraft Logs report, or backfill past reports.' : 'Attendance shows here after the first raid is added.') + '</p>' +
      (canEdit ? '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'raidnew', gid: gid })) + '">New raid</a><a class="gs-btn" href="' + esc(G.router.format({ name: 'backfill', gid: gid })) + '">Backfill from Warcraft Logs</a></div>' : '') + '</section>';
  }

  // opts: { guildData, teamId, data (GET /attendance/team) | null, denied, view: { sort, includeInactive }, policy (GET /attendance/policy) | null, progress, alert }
  function attendanceHtml(opts) {
    const gd = opts.guildData;
    const teamId = opts.teamId;
    if (opts.denied) return noAccessHtml(gd, teamId);
    const data = opts.data;
    const view = Object.assign({ sort: DEFAULT_SORT, includeInactive: false }, opts.view || {});
    const people = (Array.isArray(data.people) ? data.people : []).filter(function (p) { return view.includeInactive || p.status !== 'inactive'; });
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', teamId);
    const hasRaids = (Array.isArray(data.weeks) ? data.weeks : []).some(function (w) { return Array.isArray(w.raids) && w.raids.length; });
    const sorted = sortPeople(people, view.sort);
    const body = !hasRaids && !people.some(function (p) { return Array.isArray(p.cells) && p.cells.length; }) ? emptyHtml(canEdit, gd.guild.id) :
      '<div class="gs-roster-filters">' + windowSwitchHtml(data) +
      '<div class="gs-check"><input type="checkbox" id="att-inactive" data-change="att-inactive"' + (view.includeInactive ? ' checked' : '') + '><label for="att-inactive">Include inactive</label></div></div>' +
      '<details class="gs-how gs-legend-box" open><summary>Legend</summary>' + legendHtml() + '</details>' +
      (data.awaitingReview > 0 ? '<p class="gs-fine" id="att-awaiting">' + esc(plural(data.awaitingReview, 'raid', 'raids')) + ' awaiting review. Their pending cells are marked with a question mark and left out of the percentage.</p>' : '') +
      (sorted.length ? tableHtml(gd.guild.id, data, sorted, view) + cardsHtml(gd.guild.id, sorted) : '<p class="gs-empty">No one matches these filters.</p>');
    return '<div class="gs-page gs-att-page">' + headerHtml(gd, teamId, data) +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      staleBannerHtml(data.staleRaids || 0, canEdit, opts.progress) + watchHtml(gd.guild.id, data.watch) + body + howCountedHtml(opts.policy, teamId) + '</div>';
  }

  // ── data ──
  function attView() {
    const a = attState();
    if (!a.attUi) a.attUi = { sort: { column: DEFAULT_SORT.column, dir: DEFAULT_SORT.dir }, includeInactive: false, window: null };
    return a.attUi;
  }

  function loadPolicy(gid) {
    const a = attState();
    if (!a.policy) a.policy = {};
    if (a.policy[gid]) return Promise.resolve(a.policy[gid]);
    return G.api.get(apiBase(gid) + '/attendance/policy').then(function (res) { a.policy[gid] = res; return res; }, function () { return null; });
  }

  function load(r, gd) {
    const a = attState();
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a.team = { gid: gid, teamId: null, data: null }; return null; }
    if (!G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.view', teamId)) { a.team = { gid: gid, teamId: teamId, data: null, denied: true }; return null; }
    const view = attView();
    // A window belongs to one team (each team has its own offered weeks): a team change goes back to its default.
    if (view.windowTeam !== teamId) { view.window = null; view.windowTeam = teamId; }
    function fetchTeam(w) {
      const q = '?team=' + encodeURIComponent(teamId) + (w != null ? '&window=' + encodeURIComponent(w) : '');
      return G.api.get(apiBase(gid) + '/attendance/team' + q);
    }
    // A window the team does not offer is a 400 on 'window': fall back to the team's default.
    const teamData = fetchTeam(view.window).catch(function (err) {
      if (view.window != null && err && err.status === 400 && err.field === 'window') { view.window = null; return fetchTeam(null); }
      throw err;
    });
    return Promise.all([teamData, loadPolicy(gid)]).then(function (res) {
      a.team = { gid: gid, teamId: teamId, data: res[0], denied: false };
      return null;
    });
  }

  function main(r, gd) {
    const a = attState();
    const t = a.team;
    if (!t || t.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!t.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    if (t.denied) return attendanceHtml({ guildData: gd, teamId: t.teamId, denied: true });
    return attendanceHtml({ guildData: gd, teamId: t.teamId, data: t.data, view: attView(), policy: a.policy && a.policy[gd.guild.id], progress: a.recalc, alert: st().pageAlert });
  }

  // ── recalculate stale raids (a request per raid, looped here) ──
  // Raid ids of one team whose stored results are older than the rules, newest first, walking the list's cursor.
  function staleIdsOf(gid, teamId) {
    const ids = [];
    function page(before, n) {
      if (n >= RAID_PAGE_GUARD) return Promise.resolve(ids);
      const q = '?team=' + encodeURIComponent(teamId) + (before ? '&before=' + encodeURIComponent(before) : '');
      return G.api.get(apiBase(gid) + '/raids' + q).then(function (res) {
        const list = res && Array.isArray(res.raids) ? res.raids : [];
        list.forEach(function (x) { if (x.stale) ids.push(x.id); });
        if (!res || !res.hasMore || !list.length) return ids;
        return page(list[list.length - 1].raidOn, n + 1);
      });
    }
    return page(null, 0);
  }

  // ids: raid ids; onProgress({running, done, total, failed}); resolves { done, failed }.
  function recalcAll(gid, ids, onProgress) {
    const total = ids.length;
    let done = 0;
    let failed = 0;
    function report(running) { if (onProgress) onProgress({ running: running, done: done, total: total, failed: failed }); }
    report(true);
    return ids.reduce(function (chain, id) {
      return chain.then(function () {
        return G.api.post(apiBase(gid) + '/raids/' + encodeURIComponent(id) + '/recompute', {}).then(function (res) {
          if (res && res.attendanceFlags) G.app.applyFlags(gid, res);
        }, function () { failed++; }).then(function () { done++; report(true); });
      });
    }, Promise.resolve()).then(function () { report(false); return { done: done, failed: failed }; });
  }

  // Recalculate every stale raid of the given teams, then reload the route. Used by the banners.
  function recalcTeams(gid, teamIds) {
    const a = attState();
    if (a.recalc && a.recalc.running) return Promise.resolve();
    a.recalc = { running: true, done: 0, total: 0, failed: 0 };
    G.app.render();
    return Promise.all(teamIds.map(function (t) { return staleIdsOf(gid, t); })).then(function (lists) {
      const ids = [].concat.apply([], lists);
      return recalcAll(gid, ids, function (p) { a.recalc = p; if (p.running) G.app.render(); });
    }).then(function (res) {
      a.recalc = null;
      st().pageAlert = res && res.failed ? 'Could not recalculate ' + plural(res.failed, 'raid', 'raids') + '. Try again.' : '';
      G.app.routeAll({ force: true });
    }, function (err) {
      a.recalc = null;
      G.app.handleError(err, { pageAlert: true });
    });
  }

  G.handlers.click['att-recalc'] = function () {
    const gid = st().currentGid;
    const gd = gid ? st().guilds[gid] : null;
    if (!gd) return;
    recalcTeams(gid, [G.app.teamFor(gd)].filter(Boolean));
  };

  G.handlers.click['att-sort'] = function (el) {
    const v = attView();
    v.sort = nextSort(v.sort, el.getAttribute('data-col'));
    G.app.render();
  };

  G.handlers.click['att-window'] = function (el) {
    const raw = el.getAttribute('data-window');
    attView().window = raw === 'all' ? 'all' : Number(raw);
    G.app.routeAll({ force: true });
  };

  G.handlers.change['att-inactive'] = function (el) {
    attView().includeInactive = !!el.checked;
    G.app.render();
  };

  G.pages.attendance = {
    OUTCOMES: OUTCOMES,
    LETTERS: LETTERS,
    OUTCOME_LABELS: OUTCOME_LABELS,
    KIND_LABELS: KIND_LABELS,
    FLAG_LABELS: FLAG_LABELS,
    DEFAULT_CREDITS: DEFAULT_CREDITS,
    ATTENDED_OUTCOMES: ATTENDED_OUTCOMES,
    COLUMNS: COLUMNS,
    DEFAULT_SORT: DEFAULT_SORT,
    letterOf: letterOf,
    labelOf: labelOf,
    swatchHtml: swatchHtml,
    outcomeChipHtml: outcomeChipHtml,
    cellHtml: cellHtml,
    legendHtml: legendHtml,
    creditText: creditText,
    flagChipsHtml: flagChipsHtml,
    sortPeople: sortPeople,
    nextSort: nextSort,
    ariaSort: ariaSort,
    gridOf: gridOf,
    describePolicy: describePolicy,
    howCountedHtml: howCountedHtml,
    staleBannerHtml: staleBannerHtml,
    watchHtml: watchHtml,
    watchRuleText: watchRuleText,
    attendanceHtml: attendanceHtml,
    apiBase: apiBase,
    attState: attState,
    teamOf: teamOf,
    plural: plural,
    loadPolicy: loadPolicy,
    staleIdsOf: staleIdsOf,
    recalcAll: recalcAll,
    recalcTeams: recalcTeams,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
