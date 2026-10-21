// ── PAGE: TEAM ATTENDANCE (+ the outcome vocabulary every attendance page shares) ──
// The letters, words, colours-by-class and cell/chip builders for outcomes live here; pages-raid, pages-review,
// pages-person-attendance and pages-raids use them. The page itself: header, window switch, legend, a sortable table
// of people with the recent-raids grid grouped by reset week (phone: person cards), "How this is counted".
// Data: GET /attendance/team?team=&window= and GET /attendance/policy (see the Phase 3 spec, API section).
// People view: Needs a look (data.watch) and Awaiting your call (GET /attendance/review) panels, then the rest in In between / Reliable (pages-attendance-people.js);
// Week grid view: one table of raids by reset week (pages-attendance-grid.js). Officers only; everyone else sees their own record (pages-person-attendance.js).
// This file is safe to load alone (the letters-table parity test does): nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  // Outcome ids in legend order, with the one-letter code each cell carries (the letter is never optional: colour is
  // not the only signal). Mirrors worker/attendance-policy.js; guild-attendance-rules-tests.js checks the parity.
  const OUTCOMES = ['present', 'bench', 'missed', 'missed_notice', 'late', 'left_early', 'late_left', 'fill_in', 'tentative', 'no_signup'];
  const LETTERS = { present: 'A', bench: 'B', missed: 'M', missed_notice: 'N', late: 'L', left_early: 'E', late_left: 'LE', fill_in: 'F', tentative: 'T', no_signup: '-' };
  const OUTCOME_LABELS = {
    present: 'Attended', bench: 'Bench', missed: 'Missed', missed_notice: 'Missed with notice', late: 'Late', left_early: 'Left early',
    late_left: 'Late and left early', fill_in: 'Other team', tentative: 'Tentative', no_signup: 'No sign-up',
  };
  const KIND_LABELS = { signed: 'Signed up', late: 'Late', standby: 'Standby', bench: 'Bench', tentative: 'Tentative', absence: "Can't come" };
  const FLAG_LABELS = { no_show: 'No show', late: 'Late', left_early: 'Left early', unmatched: 'Unmatched' };
  const DEFAULT_CREDITS = [{ id: 'full', label: 'Full', value: 1 }, { id: 'half', label: 'Half', value: 0.5 }, { id: 'none', label: 'None', value: 0 }];
  const ATTENDED_OUTCOMES = ['present', 'bench', 'late', 'left_early', 'late_left', 'fill_in'];
  const COLUMNS = ['player', 'pct', 'streak'];
  const DEFAULT_SORT = { column: 'player', dir: 'asc' };
  const STRIP_RAIDS = 8; // the raids a People row shows, newest last
  const RELIABLE_AT = 0.9; // a window % at or above this puts a person in the Reliable group (an app constant, not a setting)
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
    return '<span class="gs-cell ' + outClass(outcome) + (pending ? ' is-pending' : '') + '" aria-hidden="true">' + esc(letterOf(outcome)) + (pending ? '?' : '') + '</span>';
  }

  // Letter box + word: "A Attended". `pending` adds the question mark and the words "awaiting review".
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

  // ── shared by the People and Week grid views ──
  // The person's name in class colour, linking to their history (watch entries and review items carry playerId, team people carry id).
  function nameLinkHtml(gid, p, withIcon) {
    const pid = p.id || p.playerId;
    const cls = G.ui.classClass(p.class);
    const label = '<span class="gs-char-name' + (cls ? ' ' + cls : '') + '">' + esc(p.name) + '</span>';
    const who = pid ? '<a class="gs-char-link' + (cls ? ' ' + cls : '') + '" href="' + esc(G.router.format({ name: 'personatt', gid: gid, pid: pid })) + '">' + esc(p.name) + '</a>' : label;
    return '<span class="gs-at-name">' + (withIcon ? G.ui.specIconHtml(p.class, p.mainSpec || null, 20) : '') + who + (p.isMe ? '<span class="gs-you">You</span>' : '') + '</span>';
  }

  // The last `n` raid columns of the grid, still grouped by reset week: [{ weekStart, cols }].
  function lastRaidWeeks(grid, n) {
    let left = n;
    const out = [];
    for (let i = grid.length - 1; i >= 0 && left > 0; i--) {
      const cols = grid[i].cols.slice(-left);
      left -= cols.length;
      out.unshift({ weekStart: grid[i].weekStart, cols: cols });
    }
    return out;
  }

  // One person's last raids as cells, a pair of days per reset week; `weeks` come from lastRaidWeeks so every row lines up.
  function stripHtml(name, weeks, p) {
    const count = weeks.reduce(function (n, w) { return n + w.cols.length; }, 0);
    if (!count) return '';
    const cm = cellMapOf(p || {});
    return '<div class="gs-at-strip" role="group" aria-label="' + esc(name + ', last ' + plural(count, 'raid', 'raids') + ', oldest first') + '">' + weeks.map(function (w) {
      return '<span class="gs-at-pair">' + w.cols.map(function (c) { return cellHtml(cm[c.id] || null, c.date); }).join('') + '</span>';
    }).join('') + '</div>';
  }

  // ── the bar: view switch, window segments, Include inactive, Legend ──
  function viewSegsHtml(mode) {
    return '<div class="gs-fg-segs" role="group" aria-label="View">' + [['people', 'People'], ['grid', 'Week grid']].map(function (v) {
      return '<button type="button" class="gs-fg-seg" data-action="att-view" data-view="' + v[0] + '" data-key="aview-' + v[0] + '" aria-pressed="' + (mode === v[0] ? 'true' : 'false') + '">' + v[1] + '</button>';
    }).join('') + '</div>';
  }

  function windowSegsHtml(data) {
    const policy = data.policy || {};
    const weeks = Array.isArray(policy.switchWeeks) && policy.switchWeeks.length ? policy.switchWeeks : [4, 8];
    const items = weeks.map(function (n) { return { value: n, label: n + ' weeks' }; }).concat([{ value: 'all', label: 'All time' }]);
    return '<div class="gs-fg-segs" role="group" aria-label="Time window">' + items.map(function (it) {
      return '<button type="button" class="gs-fg-seg" data-action="att-window" data-window="' + esc(it.value) + '" data-key="awin-' + esc(it.value) + '" aria-pressed="' + (String(data.window) === String(it.value) ? 'true' : 'false') + '">' + esc(it.label) + '</button>';
    }).join('') + '</div>';
  }

  function barHtml(data, view) {
    return '<div class="gs-at-bar"><div class="gs-at-barl">' + viewSegsHtml(view.mode) + windowSegsHtml(data) + '</div><div class="gs-at-barl">' +
      '<label class="gs-at-chk" for="att-inactive"><input type="checkbox" id="att-inactive" data-change="att-inactive"' + (view.includeInactive ? ' checked' : '') + '>Include inactive</label>' +
      '<button type="button" class="gs-btn" data-action="att-legend" data-key="att-legend" aria-haspopup="dialog">Legend</button></div></div>';
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
    lines.push(pol(p, 'absence', 'missedWithNotice') === 'excused' ? 'A Can\'t come sign-up is left out of the percentage.' : 'A Can\'t come sign-up counts as Missed, tagged "with notice".');
    lines.push(pol(p, 'bench', 'full') === 'excluded' ? 'Bench (sign-up or plan) is left out of the percentage.' : 'Bench (sign-up or plan) gets full credit.');
    lines.push(pol(p, 'lateSignup', 'fullCreditNoFlag') === 'flagLikeOthers' ? 'A Late sign-up who arrives late is flagged like anyone else.' : 'A Late sign-up who arrives late is Attended with full credit and no flag. Leaving early is still flagged.');
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
    return '<ul class="gs-bullets">' + describePolicy(resolved).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
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
  function windowText(w) { return w === 'all' ? 'All time' : (Number(w) > 0 ? 'Last ' + plural(Number(w), 'week', 'weeks') : ''); }
  function pageOpen() { return '<div class="gs-page gs-list-page gs-forge gs-at-page">'; }

  // T1 header: the title, one context line (team, window, people), the one molten button (Review N flags) and the one More menu.
  // The flag count is the Attendance tab's badge (G.shell.attendanceBadge), so the header and the tab can never disagree.
  function headOpts(gd, teamId, data, people, flags) {
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = teamOf(gd, teamId);
    const canReview = G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', teamId);
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', teamId);
    const parts = [several && team ? team.name : gd.guild.name, windowText(data.window), plural(people.length, 'person', 'people')];
    const items = [];
    if (canReview) items.push({ label: 'Review queue' + (flags > 0 ? ' (' + flags + ')' : ''), href: G.router.format({ name: 'review', gid: gd.guild.id }), key: 'mi-att-review' });
    if (canEdit) items.push({ label: 'Backfill from Warcraft Logs', href: G.router.format({ name: 'backfill', gid: gd.guild.id }), key: 'mi-att-backfill' });
    items.push({ label: 'How this is counted', data: { action: 'att-how' }, key: 'mi-att-how' });
    return {
      title: 'Attendance', context: parts.filter(Boolean).join(' - '), more: { id: 'att-more', key: 'att-more', items: items },
      primary: flags > 0 ? { label: 'Review ' + plural(flags, 'flag', 'flags'), href: G.router.format({ name: 'review', gid: gd.guild.id }), attrs: { 'data-key': 'att-review-flags' } } : null,
    };
  }

  function noAccessHtml(gd, teamId) {
    const team = teamOf(gd, teamId);
    return pageOpen() + G.ui.pageHeadHtml({ title: 'Attendance' }) + '<section class="gs-empty-card"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('attendance', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg">Attendance is for the team\'s members</h2><p class="gs-lead gs-lead-sm">Attendance for ' + esc(team ? team.name : 'this team') + ' is visible to the people who have a character on it.</p></section></div>';
  }

  function emptyHtml(canEdit, gid) {
    return '<section class="gs-empty-card" aria-labelledby="att-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('attendance', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="att-empty-h">No attendance yet</h2>' +
      '<p class="gs-lead gs-lead-sm">' + (canEdit ? 'Attendance builds up from raids. Add a raid with its Raid-Helper event and Warcraft Logs report, or backfill past reports.' : 'Attendance shows here after the first raid is added.') + '</p>' +
      (canEdit ? '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'raidnew', gid: gid })) + '">New raid</a><a class="gs-btn" href="' + esc(G.router.format({ name: 'backfill', gid: gid })) + '">Backfill from Warcraft Logs</a></div>' : '') + '</section>';
  }

  // The loading state: the heading and grey blocks where the panels will be.
  function skeletonHtml() {
    const sk = function (cls) { return '<span class="gs-hd-sk ' + cls + '"></span>'; };
    return '<div class="gs-page gs-list-page gs-forge gs-at-page" aria-busy="true"><p class="gs-sr" role="status">Loading attendance</p>' + G.ui.pageHeadHtml({ title: 'Attendance' }) +
      '<div class="gs-at-top" aria-hidden="true">' + [0, 1].map(function () { return '<div class="gs-hd-panel gs-at-pan">' + sk('is-sm') + sk('is-line') + sk('is-line') + sk('is-line') + '</div>'; }).join('') + '</div>' +
      '<div class="gs-hd-panel gs-at-band" aria-hidden="true">' + [0, 1, 2, 3, 4, 5].map(function () { return sk('is-line'); }).join('') + '</div></div>';
  }

  // The load failed: the one region says so, with Try again.
  function errorHtml(text) {
    return pageOpen() + G.ui.pageHeadHtml({ title: 'Attendance' }) +
      G.ui.errorRegionHtml({ title: 'We couldn\'t load attendance.', text: text || 'The server didn\'t answer.', safe: 'Nothing you saved was lost.', retry: { variant: 'primary', size: undefined, attrs: { 'data-action': 'retry', 'data-key': 'att-retry' } } }) + '</div>';
  }

  // opts: { guildData, teamId, data (GET /attendance/team) | null, denied, review (GET /attendance/review) | null, view: { mode, sort, includeInactive }, progress, alert }
  function attendanceHtml(opts) {
    const gd = opts.guildData;
    const teamId = opts.teamId;
    if (opts.denied) return noAccessHtml(gd, teamId);
    const data = opts.data;
    const view = Object.assign({ mode: 'people', sort: DEFAULT_SORT, includeInactive: false }, opts.view || {});
    const people = (Array.isArray(data.people) ? data.people : []).filter(function (p) { return view.includeInactive || p.status !== 'inactive'; });
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', teamId);
    const canReview = G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', teamId);
    const flags = canReview ? G.shell.attendanceBadge(gd, teamId) : 0;
    const hasRaids = (Array.isArray(data.weeks) ? data.weeks : []).some(function (w) { return Array.isArray(w.raids) && w.raids.length; });
    const empty = !hasRaids && !people.some(function (p) { return Array.isArray(p.cells) && p.cells.length; });
    const notices = G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + staleBannerHtml(data.staleRaids || 0, canEdit, opts.progress);
    const head = G.ui.pageHeadHtml(headOpts(gd, teamId, data, people, flags));
    if (empty) return pageOpen() + head + notices + emptyHtml(canEdit, gd.guild.id) + '</div>';
    const model = { gd: gd, gid: gd.guild.id, teamId: teamId, data: data, people: people, view: view, review: opts.review || null };
    const body = view.mode === 'grid' ? G.pages.attendanceGrid.gridHtml(model) : G.pages.attendancePeople.peopleHtml(model);
    return pageOpen() + head + notices + body + '</div>';
  }

  // ── data ──
  function attView() {
    const a = attState();
    if (!a.attUi) a.attUi = { sort: { column: DEFAULT_SORT.column, dir: DEFAULT_SORT.dir }, includeInactive: false, window: null, mode: 'people', modeGid: null };
    return a.attUi;
  }

  // The last view an officer used, per guild, in this browser. Never required: no storage, People.
  function viewKey(gid) { return 'raidsmith.attendance.view.' + gid; }
  function storedMode(gid) {
    try { return localStorage.getItem(viewKey(gid)) === 'grid' ? 'grid' : 'people'; } catch (e) { return 'people'; }
  }
  function storeMode(gid, mode) {
    try { localStorage.setItem(viewKey(gid), mode); } catch (e) { /* remembering the view is a convenience */ }
  }
  function viewOf(gid) {
    const v = attView();
    if (v.modeGid !== gid) { v.mode = storedMode(gid); v.modeGid = gid; }
    return v;
  }

  function loadPolicy(gid) {
    const a = attState();
    if (!a.policy) a.policy = {};
    if (a.policy[gid]) return Promise.resolve(a.policy[gid]);
    return G.api.get(apiBase(gid) + '/attendance/policy').then(function (res) { a.policy[gid] = res; return res; }, function () { return null; });
  }

  // The team page is for the roles that review attendance on the team; everyone else gets their own record (D1). No team yet: a reviewer anywhere still sees the no-team state.
  function reviewsTeam(gd, teamId) {
    const can = gd.me && gd.me.can;
    return teamId ? G.shell.allowsTeam(can, 'attendance.review', teamId) : G.shell.hasAction(can, 'attendance.review');
  }
  function ownPersonId(gd) { return gd.me && gd.me.personId ? gd.me.personId : ''; }

  function load(r, gd) {
    const a = attState();
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!reviewsTeam(gd, teamId)) {
      const pid = ownPersonId(gd);
      return pid ? G.pages.personAtt.load({ name: 'personatt', gid: gid, pid: pid }, gd) : null;
    }
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
    // The flags awaiting a decision (the Awaiting your call panel); the page works without them.
    const reviewData = G.api.get(apiBase(gid) + '/attendance/review?team=' + encodeURIComponent(teamId)).catch(function () { return null; });
    return Promise.all([teamData, loadPolicy(gid), reviewData]).then(function (res) {
      a.team = { gid: gid, teamId: teamId, data: res[0], denied: false, review: res[2] };
      return null;
    }, function (err) {
      // A sign-in or permission problem is the app's to handle; any other failure is this page's error region with Try again.
      if (err && (err.status === 401 || err.status === 403 || err.status === 404)) throw err;
      a.team = { gid: gid, teamId: teamId, data: null, error: (err && err.message) || "The server didn't answer." };
      return null;
    });
  }

  function main(r, gd) {
    const a = attState();
    if (!reviewsTeam(gd, G.app.teamFor(gd))) {
      const pid = ownPersonId(gd);
      if (!pid) {
        return G.ui.listPageHtml({ head: { title: 'Attendance' }, bodyHtml: G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: 'No roster entry yet', text: 'Your attendance shows here once an officer links you to the roster.' }) });
      }
      return G.pages.personAtt.mainOwn({ name: 'personatt', gid: gd.guild.id, pid: pid }, gd);
    }
    const t = a.team;
    if (!t || t.gid !== gd.guild.id) return skeletonHtml();
    if (!t.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    if (t.denied) return attendanceHtml({ guildData: gd, teamId: t.teamId, denied: true });
    if (t.error) return errorHtml(t.error);
    return attendanceHtml({ guildData: gd, teamId: t.teamId, data: t.data, review: t.review, view: viewOf(gd.guild.id), progress: a.recalc, alert: st().pageAlert });
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

  // Reviewed / Undo on a watch entry: the same shared dismissal Home uses (POST / DELETE /attention/dismissals). The Worker decides when the entry comes back
  // (a further drop of 5 points or a newly missed raid); the page reads the team again so the entry shows its new state, and the Home badge is read again.
  function watchCall(el, call) {
    const gid = st().currentGid;
    const itemId = el.getAttribute('data-item');
    if (!gid || !itemId) return null;
    return call(gid, itemId).then(function () {
      if (G.app.ensureAttention) G.app.ensureAttention(gid, true);
      return G.app.routeAll({ force: true });
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }
  G.handlers.click['att-watch-review'] = function (el) { return watchCall(el, G.api.attention.dismiss); };
  G.handlers.click['att-watch-undo'] = function (el) { return watchCall(el, G.api.attention.restore); };

  // The view switch (People | Week grid): no new request, and the choice is remembered for this guild in this browser.
  G.handlers.click['att-view'] = function (el) {
    const gid = st().currentGid;
    const mode = el.getAttribute('data-view') === 'grid' ? 'grid' : 'people';
    const v = attView();
    v.mode = mode;
    v.modeGid = gid;
    storeMode(gid, mode);
    G.app.render();
  };

  function openInfoDialog(title, bodyHtml) {
    G.ui.openDialog(G.ui.dialogHtml({ kind: 'form', formless: true, title: title, bodyHtml: bodyHtml, cancel: { label: 'Close' } }), { labelledBy: 'dlg-title' });
  }

  G.handlers.click['att-legend'] = function () { openInfoDialog('Legend', legendHtml()); };

  G.handlers.click['att-how'] = function () {
    const gid = st().currentGid;
    const gd = gid ? st().guilds[gid] : null;
    if (!gd) return;
    const body = howCountedHtml(attState().policy && attState().policy[gid], G.app.teamFor(gd));
    if (body) openInfoDialog('How this is counted', body);
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

  // After each render: the Week grid opens scrolled to its newest raids (the right end).
  function afterRender(r) {
    if (typeof document === 'undefined' || !r || !((r.name === 'section' && r.section === 'attendance') || r.name === 'personatt')) return;
    Array.prototype.forEach.call(document.querySelectorAll('.gs-at-scroll'), function (box) { box.scrollLeft = box.scrollWidth; });
  }

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
    attendanceHtml: attendanceHtml,
    barHtml: barHtml,
    nameLinkHtml: nameLinkHtml,
    lastRaidWeeks: lastRaidWeeks,
    stripHtml: stripHtml,
    cellMapOf: cellMapOf,
    dateOf: dateOf,
    skeletonHtml: skeletonHtml,
    errorHtml: errorHtml,
    afterRender: afterRender,
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
    RELIABLE_AT: RELIABLE_AT,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
