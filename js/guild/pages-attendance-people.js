// ── PAGE: TEAM ATTENDANCE, People view ──
// The officer's default view of the Attendance section: two panels (Needs a look = data.watch, Awaiting your call = the open flags of
// GET /attendance/review), then the bar and everyone else in two groups (In between, Reliable). The page frame, the bar and the shared cell/strip
// builders live in pages-attendance.js; Reviewed / Undo are its handlers (att-watch-review / att-watch-undo), Decide is pages-review.js's dialog
// (data-where="attendance"). Nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};

  const AWAITING_MAX = 10; // rows of the Awaiting your call panel before it points at the Review queue

  function A() { return G.pages.attendance; }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function nameOf(x) { return String(x && x.name != null ? x.name : ''); }
  function byName(a, b) { return nameOf(a).localeCompare(nameOf(b), 'en'); }

  // The person's rank and the ladder's suggestion (pages-ranks.js): '' while the guild has no ladder; `onlySuggestion` keeps the compact rows to the ones with something to decide.
  function rankHtml(p, teamId, onlySuggestion) {
    if (!p || !G.pages.ranks || (onlySuggestion && !p.rankSuggestion)) return '';
    return G.pages.ranks.lineHtml(p, teamId);
  }

  function panelLabel(text, count) {
    return '<h2 class="gs-hd-sl"><span class="gs-at-sl">' + esc(text) + '<span class="gs-fg-cnt">' + esc(count) + '</span></span></h2>';
  }

  // ── Needs a look ──
  // A policy fraction as typed percent: 0.75 -> 75, 0.125 -> 12.5.
  function watchPoints(fraction) { return Math.round(fraction * 1000) / 10; }

  // "Below 75% - 68%, was 79%" / "Down 18 points - 70%, was 88%": the reason, the % now and the % before.
  function watchReasonText(w, e) {
    const reasons = Array.isArray(e.reasons) ? e.reasons : [];
    const below = reasons.indexOf('below') >= 0;
    const drop = reasons.indexOf('drop') >= 0;
    const points = typeof e.drop === 'number' && e.drop > 0 ? Math.round(e.drop) : (typeof w.dropBy === 'number' ? watchPoints(w.dropBy) : 0);
    const belowText = 'Below ' + (typeof w.below === 'number' ? watchPoints(w.below) + '%' : 'the line');
    const dropText = 'down ' + plural(points, 'point', 'points');
    const lead = below && drop ? belowText + ' and ' + dropText : below ? belowText : drop ? 'Down ' + plural(points, 'point', 'points') : 'On the watch list';
    return lead + ' - ' + G.ui.percent(e.pct) + (typeof e.previousPct === 'number' ? ', was ' + G.ui.percent(e.previousPct) : '');
  }

  // "Reviewed by Kezzik, Oct 16. Comes back if attendance drops 5 more points or a raid is missed." (the Worker's rule: WATCH_RETURN_POINTS)
  function reviewedText(e) {
    const by = e.reviewed && e.reviewed.by && e.reviewed.by.name ? String(e.reviewed.by.name) : 'an officer';
    const day = e.reviewed && typeof e.reviewed.at === 'number' ? G.ui.dayInZone(e.reviewed.at, G.ui.guildZone()).replace(/^\S+\s+/, '') : '';
    return 'Reviewed by ' + by + (day ? ', ' + day : '') + '. Comes back if attendance drops 5 more points or a raid is missed.';
  }

  // The button of an entry: "Reviewed" on an open one, "Undo" on a reviewed one. Only entries that carry an itemId (the Worker sends it) get one.
  function watchActionHtml(e) {
    if (!e.itemId) return '';
    const reviewed = !!e.reviewed;
    return G.ui.buttonHtml({
      label: reviewed ? 'Undo' : 'Reviewed', variant: 'secondary', ariaLabel: (reviewed ? 'Undo Reviewed for ' : 'Mark Reviewed for ') + nameOf(e),
      attrs: { 'data-action': reviewed ? 'att-watch-undo' : 'att-watch-review', 'data-item': e.itemId, 'data-key': 'att-watch-' + e.itemId },
    });
  }

  // ctx: { people (the team's people, for each entry's cells), weeks (A().lastRaidWeeks) }; without it an entry has no cells.
  function watchRowHtml(gid, w, e, ctx) {
    const person = ctx && ctx.people ? ctx.people[e.playerId] : null;
    return '<li class="gs-at-row gs-at-w' + (e.reviewed ? ' is-reviewed' : '') + '"><div class="gs-at-who">' + A().nameLinkHtml(gid, e, true) +
      '<span class="gs-at-why">' + esc(watchReasonText(w, e)) + '</span>' + rankHtml(person, ctx && ctx.teamId) + (e.reviewed ? '<span class="gs-at-note">' + esc(reviewedText(e)) + '</span>' : '') + '</div>' +
      (person ? A().stripHtml(nameOf(e), ctx.weeks, person) : '') + '<div class="gs-at-act">' + watchActionHtml(e) + '</div></li>';
  }

  // The panel; '' when the viewer cannot review the team or both thresholds are off (data.watch is null).
  function watchHtml(gid, watch, ctx) {
    if (!watch || typeof watch !== 'object') return '';
    const entries = Array.isArray(watch.entries) ? watch.entries : [];
    return '<section class="gs-hd-panel gs-at-pan gs-at-watch" aria-label="Needs a look">' + panelLabel('Needs a look', entries.length) +
      (entries.length ? '<ul class="gs-at-list">' + entries.map(function (e) { return watchRowHtml(gid, watch, e, ctx); }).join('') + '</ul>' : '<p class="gs-fg-mut gs-at-none">No one is below the line.</p>') + '</section>';
  }

  // ── Awaiting your call ──
  // The open flags of people (not unmatched names) grouped by raid, newest raid first: [{ raid, items }].
  function awaitingGroups(review) {
    return (review && Array.isArray(review.raids) ? review.raids : []).map(function (g) {
      return { raid: g.raid || {}, items: (Array.isArray(g.items) ? g.items : []).filter(function (i) { return i && i.playerId; }) };
    }).filter(function (g) { return g.items.length; });
  }

  function awaitingRowHtml(gid, raid, item) {
    const evidence = G.pages.review && G.pages.review.evidenceText ? G.pages.review.evidenceText(item) : '';
    const cell = A().cellHtml({ raidId: raid.id, date: raid.raidOn, outcome: item.outcome, pending: true }, raid.raidOn);
    return '<li class="gs-at-row gs-at-a"><div class="gs-at-who">' + A().nameLinkHtml(gid, item, true) + '</div><div class="gs-at-ev">' + cell + '<span>' + esc(evidence || A().labelOf(item.outcome)) + '</span></div>' +
      '<div class="gs-at-act">' + G.ui.buttonHtml({
        label: 'Decide', variant: 'secondary', ariaLabel: 'Decide for ' + nameOf(item),
        attrs: { 'data-action': 'decide-open', 'data-rid': raid.id, 'data-pid': item.playerId, 'data-where': 'attendance', 'data-key': 'decide-' + raid.id + item.playerId },
      }) + '</div></li>';
  }

  function awaitingHtml(gid, review) {
    const groups = awaitingGroups(review);
    const total = groups.reduce(function (n, g) { return n + g.items.length; }, 0);
    let left = AWAITING_MAX;
    const body = groups.map(function (g) {
      const rows = g.items.slice(0, left);
      left -= rows.length;
      if (!rows.length) return '';
      return '<h3 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(G.ui.weekdayDay(g.raid.raidOn) || g.raid.raidOn || 'Raid') + '</span><span class="gs-fg-ghn">' + esc(g.items.length) + '</span></h3>' +
        '<ul class="gs-at-list">' + rows.map(function (i) { return awaitingRowHtml(gid, g.raid, i); }).join('') + '</ul>';
    }).join('');
    const more = total > AWAITING_MAX ? '<p class="gs-fg-mut gs-at-more">' + esc(plural(total - AWAITING_MAX, 'more flag', 'more flags')) + '. <a class="gs-fg-u" href="' + esc(G.router.format({ name: 'review', gid: gid })) + '">Open the Review queue</a></p>' : '';
    return '<section class="gs-hd-panel gs-at-pan gs-at-await" aria-label="Awaiting your call">' + panelLabel('Awaiting your call', total) +
      (total ? body + more : '<p class="gs-fg-mut gs-at-none">No flags are waiting.</p>') + '</section>';
  }

  // ── In between / Reliable ──
  function pctHtml(p) {
    const v = G.ui.percent(p.pct);
    return p.pending > 0 ? esc(v) + '<span class="gs-sr">, ' + esc(plural(p.pending, 'raid', 'raids')) + ' awaiting review</span>' : esc(v);
  }

  // "was 80%, -5": the previous window's % and the change in points; '' while there is no previous window to compare.
  function changeText(p) {
    if (typeof p.pct !== 'number' || typeof p.previousPct !== 'number') return '';
    const delta = Math.round(p.pct) - Math.round(p.previousPct);
    return 'was ' + G.ui.percent(p.previousPct) + ', ' + (delta > 0 ? '+' + delta : String(delta));
  }

  function isReliable(p) { return typeof p.pct === 'number' && p.pct / 100 >= A().RELIABLE_AT; }

  function betweenRowHtml(gid, teamId, p, weeks) {
    const chip = p.streakFlag ? '<span class="gs-hd-chip is-rose">' + esc(p.streak) + ' missed<span class="gs-sr"> raids in a row, flagged</span></span>' : '';
    return '<li class="gs-at-row gs-at-b' + (p.isMe ? ' is-you' : '') + '"><div class="gs-at-who">' + A().nameLinkHtml(gid, p, true) + rankHtml(p, teamId) + '</div><span class="gs-at-pct">' + pctHtml(p) + '</span>' +
      '<span class="gs-at-was">' + esc(changeText(p)) + '</span>' + A().stripHtml(nameOf(p), weeks, p) + '<span class="gs-at-chipbox">' + chip + '</span></li>';
  }

  function reliableRowHtml(gid, teamId, p) {
    return '<li class="gs-at-rl' + (p.isMe ? ' is-you' : '') + '"><div class="gs-at-who">' + A().nameLinkHtml(gid, p, true) + rankHtml(p, teamId, true) + '</div><span class="gs-at-pct">' + pctHtml(p) + '</span></li>';
  }

  function windowWords(w) { return w === 'all' ? 'all time' : plural(Number(w), 'week', 'weeks'); }

  function rangeText(weeks) {
    const cols = weeks.reduce(function (all, w) { return all.concat(w.cols); }, []);
    if (!cols.length) return '';
    return 'Last ' + plural(cols.length, 'raid', 'raids') + ', ' + G.ui.shortDay(cols[0].date) + ' to ' + G.ui.shortDay(cols[cols.length - 1].date);
  }

  function groupHead(title, count, note) {
    return '<h3 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(title) + '</span><span class="gs-fg-ghn">' + esc(count) + '</span>' + (note ? '<span class="gs-fg-ghx">' + esc(note) + '</span>' : '') + '</h3>';
  }

  function bandsHtml(gid, teamId, others, weeks, windowValue) {
    const between = others.filter(function (p) { return !isReliable(p); }).sort(byName);
    const reliable = others.filter(isReliable).sort(byName);
    return (between.length ? groupHead('In between', between.length, rangeText(weeks)) + '<ul class="gs-at-list">' + between.map(function (p) { return betweenRowHtml(gid, teamId, p, weeks); }).join('') + '</ul>' : '') +
      (reliable.length ? groupHead('Reliable', reliable.length, Math.round(A().RELIABLE_AT * 100) + '% or more over ' + windowWords(windowValue)) + '<ul class="gs-at-rel">' + reliable.map(function (p) { return reliableRowHtml(gid, teamId, p); }).join('') + '</ul>' : '') +
      (!between.length && !reliable.length ? '<p class="gs-fg-mut gs-at-none">No one else matches.</p>' : '');
  }

  // m: { gid, data, people (inactive already filtered), view, review }
  function peopleHtml(m) {
    const att = A();
    const weeks = att.lastRaidWeeks(att.gridOf(m.data, m.people), 8);
    const byId = {};
    m.people.forEach(function (p) { byId[p.id] = p; });
    const watch = m.data.watch && typeof m.data.watch === 'object' ? m.data.watch : null;
    const listed = {};
    ((watch && watch.entries) || []).forEach(function (e) { listed[e.playerId] = true; });
    const others = m.people.filter(function (p) { return !listed[p.id]; });
    return '<div class="gs-at-top' + (watch ? '' : ' is-solo') + '">' + watchHtml(m.gid, watch, { people: byId, weeks: weeks, teamId: m.teamId }) + awaitingHtml(m.gid, m.review) + '</div>' +
      '<section class="gs-hd-panel gs-at-band" aria-label="Everyone">' + att.barHtml(m.data, m.view) + bandsHtml(m.gid, m.teamId, others, weeks, m.data.window) + '</section>';
  }

  G.pages.attendancePeople = {
    AWAITING_MAX: AWAITING_MAX,
    peopleHtml: peopleHtml,
    watchHtml: watchHtml,
    watchReasonText: watchReasonText,
    awaitingHtml: awaitingHtml,
    awaitingGroups: awaitingGroups,
    bandsHtml: bandsHtml,
    changeText: changeText,
    isReliable: isReliable,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
