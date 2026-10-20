// ── PAGES: RAIDS LIST and NEW RAID ──────────────────────────────
// The list of one team's raids (GET /raids?team=) on the Forge look (T1 + a right rail): Upcoming (raids that have not started, soonest first, as cards: gold date,
// time, title in ONE link, the sign-up figure and bar, then ONE status item - the officer's Plan chip or the member's Sign up / chip) and Past (newest first, a
// table with one status chip) tabs, "Create upcoming raids" from the team's weekly schedule (also run by itself when the team's schedule says so), "Subscribe in
// your calendar" (pages-calendar.js), the rail (standing sign-ups, the officer's away panel, the member's away line) and the New raid page, which
// runs its calls in order (create raid, event, each report, plan) with a status line per source. A failure stops that
// source only: the raid exists, the page links to it and offers Retry. Dates are the guild's calendar dates.
(function (G) {
  'use strict';

  const REPORT_SHORT = 28;
  const RAID_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const RAID_TIME = /^\d{2}:\d{2}$/;
  const DEFAULT_START = '20:00';
  const CARD_LIMIT = 8; // upcoming cards before "Show all N"

  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function raidHref(gid, rid) { return G.router.format({ name: 'raid', gid: gid, rid: rid }); }

  // "Hyjal Summit - 20"; "20-player" when the raid has no zone; the zone alone when no size came with it (an older reply); '' when neither.
  function zoneSizeText(zone, size) {
    const n = typeof size === 'number' && size > 0 ? size : null;
    if (zone) return n ? zone + ' - ' + n : zone;
    return n ? n + '-player' : '';
  }

  // ── list ──
  function pillHtml(kind, text) { return '<span class="gs-pill gs-pill-' + kind + '">' + esc(text) + '</span>'; }

  // The status pills of one list row: the state, plus open flags on a manual raid. A stale raid shows only "Needs recalculation", whatever else its stored state says.
  // memberView: the viewer cannot review the team. They see Reviewed and Awaiting log; the review and recalculation chips are the officers' work states.
  function statePillsHtml(r, memberView) {
    const pills = [];
    const flags = r.openFlags > 0 ? r.openFlags : 0;
    if (memberView) {
      if (r.stale || r.state === 'stale') return '';
      return r.state === 'reviewed' ? '<span class="gs-pills">' + pillHtml('ok', 'Reviewed') + '</span>' : (r.state === 'awaiting_log' ? '<span class="gs-pills">' + pillHtml('muted', 'Awaiting log') + '</span>' : '');
    }
    if (r.stale || r.state === 'stale') return '<span class="gs-pills">' + pillHtml('warn', 'Needs recalculation') + '</span>';
    switch (r.state) {
      case 'upcoming': pills.push(pillHtml('info', 'Upcoming')); break;
      case 'awaiting_log': pills.push(pillHtml('muted', 'Awaiting log')); break;
      case 'manual':
        pills.push(pillHtml('info', 'No log - by hand'));
        if (flags) pills.push(pillHtml('warn', flags + ' to review'));
        break;
      case 'to_review': pills.push(pillHtml('warn', flags + ' to review')); break;
      case 'reviewed': pills.push(pillHtml('ok', 'Reviewed')); break;
      default: pills.push(pillHtml('muted', String(r.state == null ? '' : r.state).replace(/_/g, ' ')));
    }
    return '<span class="gs-pills">' + pills.join('') + '</span>';
  }

  function sourceChipsHtml(src) {
    const s = src || {};
    const chips = [];
    if (s.event) chips.push('<span class="gs-chip gs-chip-src">Sign-ups</span>');
    if (s.reports > 0) chips.push('<span class="gs-chip gs-chip-src">Log' + (s.reports > 1 ? ' x' + esc(s.reports) : '') + '</span>');
    if (s.plan) chips.push('<span class="gs-chip gs-chip-src">Plan</span>');
    return chips.length ? chips.join(' ') : '<span class="gs-muted">None</span>';
  }

  function bossesText(b) {
    const x = b || {};
    if (!(x.pulls > 0)) return '-';
    return plural(x.kills || 0, 'kill', 'kills') + ', ' + plural(x.pulls - (x.kills || 0), 'wipe', 'wipes');
  }

  function countsText(c) {
    if (!c) return '-';
    return (c.present || 0) + ' / ' + (c.bench || 0) + ' / ' + (c.missed || 0);
  }

  // Present / bench / missed as one stacked bar (an SVG: widths are attributes, the page allows no inline style) beside the numbers. Decorative: the numbers say it.
  function stackBarHtml(c) {
    const present = c.present || 0;
    const bench = c.bench || 0;
    const missed = c.missed || 0;
    const total = present + bench + missed;
    if (!total) return '';
    const share = function (n) { return Math.round(n / total * 1000) / 10; };
    const benchW = share(bench);
    const missedW = share(missed);
    const presentW = Math.round((100 - benchW - missedW) * 10) / 10;
    return '<svg class="gs-stackbar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      '<rect class="gs-sb-present" x="0" y="0" width="' + presentW + '" height="8"/><rect class="gs-sb-bench" x="' + presentW + '" y="0" width="' + benchW + '" height="8"/>' +
      '<rect class="gs-sb-missed" x="' + Math.round((presentW + benchW) * 10) / 10 + '" y="0" width="' + missedW + '" height="8"/></svg>';
  }

  // The Past table's Status: ONE gs-hd-chip word. Officers: Needs recalculation and N to review are the attention (rose); the rest grey. A stale raid shows only
  // "Needs recalculation", whatever else its stored state says; a manual raid with open flags says "N to review" (the work to do). A member sees Reviewed and
  // Awaiting log only, and nothing for a stale raid (the review and recalculation words are the officers' work states).
  function statusChipHtml(r, memberView) {
    const chip = function (tone, text) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(text) + '</span>'; };
    const flags = r.openFlags > 0 ? r.openFlags : 0;
    if (memberView) {
      if (r.stale || r.state === 'stale') return '';
      return r.state === 'reviewed' ? chip('grey', 'Reviewed') : (r.state === 'awaiting_log' ? chip('grey', 'Awaiting log') : '');
    }
    if (r.stale || r.state === 'stale') return chip('rose', 'Needs recalculation');
    switch (r.state) {
      case 'upcoming': return chip('grey', 'Upcoming');
      case 'awaiting_log': return chip('grey', 'Awaiting log');
      case 'manual': return flags ? chip('rose', flags + ' to review') : chip('grey', 'No log - by hand');
      case 'to_review': return chip('rose', flags + ' to review');
      case 'reviewed': return chip('grey', 'Reviewed');
      default: return chip('grey', String(r.state == null ? '' : r.state).replace(/_/g, ' '));
    }
  }

  // Past raids as the T1 data table: Date (the link, the row header) | Raid (zone bold, size muted) | Bosses | Attended / bench / missed | Status. Below 760 px the
  // helper turns the rows into cards. The sources of a raid are on its page (the Raid panel), not here.
  function pastTableHtml(gd, raids, officer, showAll) {
    const gid = gd.guild.id;
    const columns = [
      { key: 'date', label: 'Date', primary: true },
      { key: 'raid', label: 'Raid' },
      { key: 'bosses', label: 'Bosses' },
      { key: 'counts', label: 'Attended / bench / missed' },
      { key: 'status', label: 'Status' },
    ];
    const rows = raids.map(function (r) {
      const size = typeof r.size === 'number' && r.size > 0 ? r.size + '-player' : '';
      const name = r.zone || r.title || size;
      const sub = name !== size ? size : '';
      return { id: r.id, cells: {
        date: '<a class="gs-raid-link" href="' + esc(raidHref(gid, r.id)) + '">' + esc(G.ui.weekdayDay(r.raidOn) || r.raidOn) + '</a>',
        raid: name ? '<strong class="gs-rp-zone">' + esc(name) + '</strong>' + (sub ? '<span class="gs-rp-size">' + esc(sub) + '</span>' : '') : '<span class="gs-muted">-</span>',
        bosses: esc(bossesText(r.bosses)),
        counts: r.counts ? '<span class="gs-stack">' + stackBarHtml(r.counts) + '<span class="gs-stack-num">' + esc(countsText(r.counts)) + '</span></span>' : '<span class="gs-muted">-</span>',
        status: statusChipHtml(r, !officer),
      } };
    });
    return G.ui.dataTableHtml({ label: 'Raids', columns: columns, rows: rows, showAll: !!showAll, showAllAction: 'raids-past-all', noun: 'raids' });
  }

  // ── upcoming ──
  // '8:00 PM ET': the time in the guild's zone with the zone written next to it (G.ui.timeInZone).
  function timeText(ms, timeZone) {
    return G.ui.timeInZone(ms, timeZone);
  }

  // 'Sat Oct 17, 8:00 PM ET': the raid's guild-local date and its start time in the guild's time zone. A date-only raid (timeKnown === false: its
  // startsAt is a placeholder noon) is the day alone, never a made-up time; callers add "time not set" (timeNotSetHtml).
  function whenText(r, gd) {
    const day = G.ui.weekdayDay(r.raidOn) || r.raidOn;
    if (r.timeKnown === false) return day;
    const time = timeText(r.startsAt, gd && gd.guild ? gd.guild.timeZone : '');
    return time ? day + ', ' + time : day;
  }

  function timeNotSetHtml(r) {
    return r.timeKnown === false ? ' <span class="gs-muted gs-time-unset">time not set</span>' : '';
  }

  // The guild's calendar date (YYYY-MM-DD; en-CA writes it so) of a moment; '' when the time zone is unusable.
  function dateOf(ms, timeZone) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); } catch (e) { return ''; }
  }

  // A moment that is not a raid's start (the sign-up deadline) written like one, in the guild's time zone: 'Thu Oct 15, 7:30 PM ET'.
  function momentText(ms, gd) {
    const zone = gd && gd.guild ? gd.guild.timeZone : '';
    const day = G.ui.weekdayDay(dateOf(ms, zone));
    const time = timeText(ms, zone);
    return day && time ? day + ', ' + time : day || time;
  }

  // Why a raid that has only a date closes sign-ups when it does (raid.closesSource, set by the Worker for such a raid only): 'slot' = the team schedule slot
  // time on that weekday, 'default' = 18:00 guild time because the team has no slot that day. '' for a raid with a start time.
  function closeNoteText(raid) {
    if (!raid || !raid.closesSource) return '';
    const earlier = raid.closeHours > 0 ? ', ' + plural(raid.closeHours, 'hour', 'hours') + ' earlier' : '';
    if (raid.closesSource === 'slot') return 'this raid has only a date, so sign-ups close at the time of the schedule slot that day' + earlier;
    return 'this raid has only a date and the team has no schedule slot that day, so sign-ups close at 18:00 guild time' + earlier;
  }

  // The same, short, for the Raids list: 'Thu 7:30 PM ET'.
  function momentShortText(ms, gd) {
    const zone = gd && gd.guild ? gd.guild.timeZone : '';
    const weekday = (G.ui.weekdayDay(dateOf(ms, zone)) || '').split(' ')[0];
    const time = timeText(ms, zone);
    return weekday && time ? weekday + ' ' + time : weekday || time;
  }

  // '18 / 20 signed up, 2 bench' (the expected players against the raid's size; late counts as signed up); '23 signed, 2 bench' when no size came with
  // the row; '-' when the viewer may not see counts.
  function signupsText(s, size) {
    if (!s) return '-';
    const signed = (s.signed || 0) + (s.late || 0);
    const standby = s.standby || 0;
    if (!signed && !standby && !s.bench && !s.tentative && !s.absence) return 'No sign-ups yet';
    const parts = [typeof size === 'number' && size > 0 ? (typeof s.expected === 'number' ? s.expected : signed + standby) + ' / ' + size + ' signed up' : signed + ' signed'];
    if (standby) parts.push(standby + ' standby');
    if (s.bench) parts.push(s.bench + ' bench');
    if (s.tentative) parts.push(s.tentative + ' tentative');
    if (s.absence) parts.push(s.absence + ' can\'t come');
    return parts.join(', ');
  }

  function planPillHtml(r) { return r.planned ? pillHtml('ok', 'Planned') : pillHtml('muted', 'Not planned'); }

  // "Sign-ups close Thu 7:30 PM" while the window is open and the team (or the raid) has a deadline; nothing otherwise.
  function deadlineHtml(r, gd) {
    if (!r.signupsOpen || !(r.closeHours > 0) || typeof r.closesAt !== 'number') return '';
    const when = momentShortText(r.closesAt, gd);
    return when ? '<span class="gs-fine">Sign-ups close ' + esc(when) + '</span>' : '';
  }

  // The raid's title on a card: the event title, else the zone, else the size ("25-player").
  function cardTitleText(r) {
    const size = typeof r.size === 'number' && r.size > 0 ? r.size + '-player' : '';
    return r.title || r.zone || size || 'Raid';
  }

  // "13 / 25" and a thin neutral bar (an SVG: the page allows no inline style) while the viewer may see counts (r.signups); nothing otherwise. Without a size the
  // figure is the count alone.
  function cardFigureHtml(r) {
    const s = r.signups;
    if (!s) return '';
    const signed = (s.signed || 0) + (s.late || 0);
    const count = typeof s.expected === 'number' ? s.expected : signed + (s.standby || 0);
    const size = typeof r.size === 'number' && r.size > 0 ? r.size : 0;
    const pct = size ? Math.max(0, Math.min(100, Math.round(count / size * 1000) / 10)) : 0;
    const bar = size ? '<svg class="gs-rc-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="gs-rc-bar-track" x="0" y="0" width="100" height="4"/><rect class="gs-rc-bar-fill" x="0" y="0" width="' + pct + '" height="4"/></svg>' : '';
    return '<div class="gs-rc-signups"><span class="gs-rc-fig">' + esc(count) + (size ? ' <span class="gs-rc-of">/ ' + esc(size) + '</span>' : '') + '<span class="gs-sr"> signed up</span></span>' + bar + '</div>';
  }

  // The ONE status item of a card, outside its link.
  //   Officer (raids.edit): a grey Plan chip while the raid is not planned (the list does not say planned-but-not-published, so there is no Publish); nothing
  //   otherwise; the Raid-Helper moved warning stays as a muted line.
  //   Member with a character (signups.self): a seat in a published line-up = grey Group N / Bench; a sign-up = green Signed up (+ muted Standing) or a grey chip
  //   with its word; none yet = Sign up while the window is open, else the muted "Sign-ups closed".
  function cardStatusHtml(r, canEdit, canSignUp) {
    const chip = function (tone, text) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(text) + '</span>'; };
    if (canEdit) {
      return (r.planned ? '' : chip('grey', 'Plan')) +
        (r.eventMovedOn ? '<p class="gs-rc-note">Raid-Helper has this event on ' + esc(G.ui.weekdayDay(r.eventMovedOn) || r.eventMovedOn) + '. The raid was not moved.</p>' : '');
    }
    if (!canSignUp) return '';
    const m = r.mine;
    if (m && m.roster) return chip('grey', m.roster.group ? 'Group ' + m.roster.group : 'Bench');
    if (m && m.kind) {
      if (m.source === 'away') return chip('grey', 'Away');
      if (m.kind === 'signed') return chip('green', 'Signed up') + (m.standing ? '<span class="gs-rc-note">Standing</span>' : '');
      return chip('grey', A().KIND_LABELS[m.kind] || m.kind);
    }
    if (r.signupsOpen) return '<button type="button" class="gs-btn gs-btn-sm" data-action="raids-signup" data-rid="' + esc(r.id) + '" data-key="rs-' + esc(r.id) + '">Sign up</button>';
    return '<span class="gs-rc-note">Sign-ups closed</span>';
  }

  // One upcoming raid as a card: ONE link (to the raid page) around the gold date, the time and the title; the sign-up figure and bar; then the status item.
  function cardHtml(gd, r, canEdit, canSignUp) {
    const zone = gd && gd.guild ? gd.guild.timeZone : '';
    const day = G.ui.weekdayDay(r.raidOn) || r.raidOn;
    const time = r.timeKnown === false ? '' : timeText(r.startsAt, zone);
    const status = cardStatusHtml(r, canEdit, canSignUp);
    return '<li class="gs-rc"><a class="gs-rc-link" href="' + esc(raidHref(gd.guild.id, r.id)) + '"><span class="gs-hd-daydate gs-rc-date">' + esc(day) + '</span>' +
      '<span class="gs-rc-time">' + esc(time || 'Time not set') + '</span><span class="gs-rc-title">' + esc(cardTitleText(r)) + '</span></a>' +
      cardFigureHtml(r) + (status ? '<div class="gs-rc-status">' + status + '</div>' : '') + '</li>';
  }

  // Upcoming raids as cards in a grid (one per row on a phone): the first 8, then "Show all N".
  function upcomingHtml(gd, upcoming, canEdit, canSignUp, showAll) {
    if (!upcoming.length) {
      return G.ui.emptyStateHtml({ kind: 'filtered', title: 'No upcoming raids', text: canEdit ? 'Use New raid to add one, or Create upcoming raids from the weekly schedule.' : 'Your officers haven\'t scheduled one yet.' });
    }
    const shown = showAll || upcoming.length <= CARD_LIMIT ? upcoming : upcoming.slice(0, CARD_LIMIT);
    const foot = shown.length < upcoming.length
      ? '<div class="gs-dtable-foot gs-rc-foot"><span class="gs-fine">Showing ' + shown.length + ' of ' + upcoming.length + ' raids</span><button type="button" class="gs-linkbtn" data-action="raids-show-all">Show all ' + upcoming.length + '</button></div>'
      : '';
    return '<ul class="gs-rc-grid" aria-label="Upcoming raids">' + shown.map(function (r) { return cardHtml(gd, r, canEdit, canSignUp); }).join('') + '</ul>' + foot;
  }

  // A sign-up view (the Worker's answer to a sign-up write) folded into its upcoming row: what the viewer is down as, the counts, whether it is open.
  function applySignupView(x, rid, view) {
    const row = ((x.data && x.data.upcoming) || []).filter(function (r) { return r.id === rid; })[0];
    if (!row || !view) return;
    const sig = view.me && view.me.signup;
    const seat = row.mine && row.mine.roster ? row.mine.roster : null;
    row.mine = sig ? { kind: sig.kind, source: sig.source, characterName: sig.source === 'raidsmith' ? sig.name : null } : null;
    if (row.mine && sig.standing) row.mine.standing = true;
    if (seat) row.mine = Object.assign(row.mine || { kind: null, source: null, characterName: null }, { roster: seat });
    if (view.counts) row.signups = { signed: view.counts.signed, late: view.counts.late, standby: view.counts.standby || 0, tentative: view.counts.tentative, bench: view.counts.bench, absence: view.counts.absence };
    row.locked = !!(view.raid && view.raid.locked);
    row.signupsOpen = !(view.raid && view.raid.closed);
  }

  // What "Create upcoming raids" did, in a sentence. res: { created, skipped, weeks }.
  function fillText(res) {
    const created = res && Array.isArray(res.created) ? res.created : [];
    const skipped = res && Array.isArray(res.skipped) ? res.skipped : [];
    const exists = skipped.filter(function (x) { return x.reason === 'exists'; }).length;
    const noTime = skipped.filter(function (x) { return x.reason === 'no_such_time'; }).length;
    const weeks = res && res.weeks ? res.weeks : 0;
    const parts = [];
    if (created.length) {
      parts.push('Created ' + plural(created.length, 'upcoming raid', 'upcoming raids') + ': ' + created.map(function (x) { return G.ui.shortDay(x.raidOn); }).join(', ') + '.');
      if (exists) parts.push(plural(exists, 'date already had', 'dates already had') + ' a raid.');
    } else {
      parts.push('Nothing new to create: the next ' + plural(weeks, 'week', 'weeks') + ' already have their raids.');
    }
    if (noTime) parts.push(plural(noTime, 'slot was', 'slots were') + ' skipped because that time does not exist on a day the clocks change.');
    return parts.join(' ');
  }


  function flagBannerHtml(gd, teamId, raids) {
    const flagged = raids.filter(function (r) { return r.openFlags > 0; });
    if (!flagged.length || !G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', teamId)) return '';
    const dates = flagged.map(function (r) { return G.ui.shortDay(r.raidOn); });
    const list = dates.length > 1 ? dates.slice(0, -1).join(', ') + ' and ' + dates[dates.length - 1] : dates[0];
    return '<div class="gs-notice" role="status"><span>' + esc(plural(flagged.length, 'raid has', 'raids have')) + ' open flags: ' + esc(list) + '.</span>' +
      '<a class="gs-btn gs-btn-sm" href="' + esc(G.router.format({ name: 'review', gid: gd.guild.id })) + '">Open review queue</a></div>';
  }

  function emptyHtml(gd, canEdit) {
    const gid = gd.guild.id;
    const body = canEdit
      ? '<p class="gs-lead gs-lead-sm">A raid is one team\'s raid on one date. Add one from its Raid-Helper event and Warcraft Logs report, backfill past reports, or set a weekly schedule and create the upcoming raids from it.</p>' +
        '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'raidnew', gid: gid })) + '">New raid</a>' +
        '<a class="gs-btn" href="' + esc(G.router.format({ name: 'backfill', gid: gid })) + '">Backfill from Warcraft Logs</a></div>'
      : '<p class="gs-lead gs-lead-sm">Your officers haven\'t added a raid yet.</p>';
    return '<section class="gs-empty-card" aria-labelledby="raids-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('raids', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="raids-empty-h">No raids yet</h2>' + body + '</section>';
  }

  // The tab strip (Forge .gs-subtabs): Upcoming / Past with gold count badges, Progress when the board exists. Buttons: a tab changes the list in place.
  function tabsHtml(tab, upcomingCount, pastCount) {
    const items = [
      { key: 'upcoming', label: 'Upcoming', count: upcomingCount },
      { key: 'past', label: 'Past', count: pastCount },
      G.pages.progress ? { key: 'progress', label: 'Progress' } : null,
    ].filter(Boolean);
    return '<nav aria-label="Raids"><ul class="gs-subtabs gs-raids-tabs">' + items.map(function (it) {
      const on = it.key === tab;
      return '<li><button type="button" class="gs-subtab' + (on ? ' is-active' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" data-action="raids-tab" data-value="' + it.key + '" data-key="rt-' + it.key + '">' +
        esc(it.label) + (it.count != null ? ' <span class="gs-tab-count">' + esc(it.count) + '</span>' : '') + '</button></li>';
    }).join('') + '</ul></nav>';
  }

  // The rail beside the cards / table (below it under 1024 px): the viewer's standing sign-ups; for an officer the away panel with Create upcoming raids; for a
  // member the one away line. Pieces that are not ready (still loading, no person) draw nothing.
  function railHtml(gd, x) {
    const teamId = x.teamId;
    const can = x.data && x.data.can;
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', teamId);
    const hasSlots = !!(x.data && x.data.schedule && x.data.schedule.slots > 0);
    const standing = G.pages.standing ? G.pages.standing.cardHtml({ guildData: gd, teamId: teamId, canSignUp: !!(can && can.signup), state: a().standing }) : '';
    let away = '';
    if (canEdit) {
      const fill = hasSlots ? '<button type="button" class="gs-btn gs-rl-fill" data-action="raids-fill" data-key="rail-raids-fill">Create upcoming raids</button>' : '';
      away = G.pages.away ? G.pages.away.teamCardHtml({ guildData: gd, teamId: teamId, state: a().awayTeam, footHtml: fill }) : '';
    } else if (G.pages.away && G.pages.away.memberLineHtml) {
      away = G.pages.away.memberLineHtml({ guildData: gd, state: a().away });
    }
    return standing + away;
  }

  // opts: { guildData, teamId, data (GET /raids?team=) , progress, alert, note, more (bool), tab ('upcoming' | 'past' | 'progress'; default: Upcoming when there is one),
  //         progressHtml (the Progress tab's board, pages-progress.js), showAll (Upcoming shows every card), showAllPast (Past shows every loaded row),
  //         railHtml (the rail's panels, see railHtml) }
  // T1 list page on Forge: the header (title, one context line, the one More menu, New raid as the one primary), the Upcoming / Past / Progress tabs, then the main
  // column (cards or the Past table) and the rail.
  function raidsHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || { raids: [] };
    const raids = Array.isArray(data.raids) ? data.raids : [];
    const upcoming = Array.isArray(data.upcoming) ? data.upcoming : [];
    const tab = opts.tab === 'upcoming' || opts.tab === 'past' || (opts.tab === 'progress' && G.pages.progress) ? opts.tab : (upcoming.length ? 'upcoming' : 'past');
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', opts.teamId);
    const canReview = G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', opts.teamId);
    const officer = canEdit || canReview;
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = A().teamOf(gd, opts.teamId);
    const pastCount = raids.length + (opts.more ? '+' : '');
    const context = [several && team ? team.name : gd.guild.name, tab === 'progress' ? 'Boss progress from the logged raids' : upcoming.length + ' upcoming, ' + pastCount + ' past'].join(' - ');
    const staleCount = raids.filter(function (r) { return r.stale; }).length;
    const hasSlots = !!(data.schedule && data.schedule.slots > 0);
    // One primary (New raid, officers) and the one More menu with the rest. Everyone who sees the list may subscribe to the team's calendar (the link is
    // theirs) and reach their away notices; the officers' pages and the weekly fill come with it.
    const more = [];
    if (canEdit) {
      more.push({ label: 'Backfill from Warcraft Logs', href: G.router.format({ name: 'backfill', gid: gid }) });
      more.push({ label: 'Raid schedule', href: G.router.format({ name: 'settings', gid: gid, tab: 'schedule' }) });
      if (hasSlots) more.push({ label: 'Create upcoming raids', key: 'mi-raids-fill', data: { action: 'raids-fill' } });
    }
    if (opts.teamId && G.pages.calendar) more.push({ label: 'Subscribe in your calendar', key: 'mi-cal-open', data: { action: 'cal-open' } });
    more.push({ label: 'My away notices', href: G.router.format({ name: 'away', gid: gid }) });
    const head = { title: 'Raids', context: context, more: { id: 'raids-more', key: 'raids-more', items: more }, primary: canEdit ? { label: 'New raid', href: G.router.format({ name: 'raidnew', gid: gid }) } : null };
    const empty = !raids.length && !upcoming.length;
    const bar = empty ? '' : tabsHtml(tab, upcoming.length, pastCount);
    let body;
    if (empty) {
      body = emptyHtml(gd, canEdit);
    } else if (tab === 'progress') {
      body = opts.progressHtml || '';
    } else if (tab === 'upcoming') {
      body = upcomingHtml(gd, upcoming, canEdit, !!(data.can && data.can.signup), opts.showAll);
    } else if (!raids.length) {
      body = G.ui.emptyStateHtml({ title: 'No past raids yet', icon: 'raids', text: 'Raids move here after they start.' + (canEdit ? ' Attach a Warcraft Logs report to a finished raid to record attendance.' : ''),
        actions: canEdit ? [{ label: 'Backfill from Warcraft Logs', variant: 'secondary', href: G.router.format({ name: 'backfill', gid: gid }) }] : [] });
    } else {
      body = pastTableHtml(gd, raids, officer, opts.showAllPast) +
        (opts.more ? '<div class="gs-actions"><button type="button" class="gs-btn" data-action="raids-older" data-key="raids-older">Show older raids</button></div>' : '');
    }
    const rail = opts.railHtml || '';
    return '<div class="gs-page gs-list-page gs-forge gs-raids-page">' + G.ui.pageHeadHtml(head) +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (opts.note ? '<div class="gs-notice" role="status"><span>' + esc(opts.note) + '</span></div>' : '') +
      A().staleBannerHtml(staleCount, canEdit, opts.progress) + flagBannerHtml(gd, opts.teamId, raids) +
      bar + '<div class="gs-listbody gs-raids-split' + (rail ? ' has-rail' : '') + '" aria-live="polite"><div class="gs-raids-main">' + body + '</div>' +
      (rail ? '<aside class="gs-raids-rail" aria-label="Your sign-ups and away notices">' + rail + '</aside>' : '') + '</div></div>';
  }

  function loadList(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().raids = { gid: gid, teamId: null, data: null }; return null; }
    const keptTab = a().raids && a().raids.gid === gid && a().raids.teamId === teamId ? a().raids.tab : null;
    const kept = keptTab === 'progress' ? null : keptTab; // the Progress board is read again when its tab is opened
    return G.api.get(A().apiBase(gid) + '/raids?team=' + encodeURIComponent(teamId)).then(function (data) {
      a().raids = { gid: gid, teamId: teamId, data: data, more: !!(data && data.hasMore), tab: kept || null, note: '' };
      return autoFill(a().raids);
    });
  }

  // Reads the list again (after a sign-up, or after raids were created); the older raids already paged in stay.
  function reloadList(x) {
    return G.api.get(A().apiBase(x.gid) + '/raids?team=' + encodeURIComponent(x.teamId)).then(function (data) {
      const older = x.data && x.data.raids && x.data.raids.length > data.raids.length ? x.data.raids : null;
      x.data = older ? Object.assign({}, data, { raids: older }) : data;
      if (!older) x.more = !!data.hasMore;
      return null;
    });
  }

  // A team whose schedule says so gets its upcoming raids created when an officer opens Raids, once a day per browser session. It is best
  // effort: a failure leaves the page as it loaded (the Create upcoming raids button is still there).
  function autoFill(x) {
    const sch = x.data && x.data.schedule;
    const done = a().autoFilled || (a().autoFilled = {});
    const key = x.gid + '|' + x.teamId + '|' + (x.data && x.data.today ? x.data.today : '');
    if (!sch || !sch.auto || !(sch.slots > 0) || done[key]) return Promise.resolve(null);
    done[key] = true;
    return G.api.signups.fill(x.gid, x.teamId).then(function (res) {
      if (!res || !res.created || !res.created.length) return null;
      x.note = fillText(res);
      return reloadList(x);
    }).then(null, function () { return null; });
  }

  function mainList(r, gd) {
    const x = a().raids;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return raidsHtml({ guildData: gd, teamId: x.teamId, data: x.data, more: x.more, tab: x.tab, showAll: x.showAll, showAllPast: x.showAllPast, progress: a().recalc, alert: st().pageAlert, note: x.note,
      progressHtml: G.pages.progress ? G.pages.progress.tabHtml(x) : '', railHtml: railHtml(gd, x) });
  }

  G.handlers.click['raids-tab'] = function (el) {
    const x = a().raids;
    if (!x) return;
    const wanted = el.getAttribute('data-value') || el.getAttribute('data-tab');
    x.tab = wanted === 'past' ? 'past' : (wanted === 'progress' && G.pages.progress ? 'progress' : 'upcoming');
    // The boss board is read when its tab opens (and again each time: kills land after every logged raid).
    if (x.tab === 'progress') G.pages.progress.load(x).then(function () { if (a().raids === x && x.tab === 'progress') G.app.render(); });
    G.app.render();
  };

  // ── An event on another day than the raid ──
  // PUT .../event answers 409 event_other_day (eventDate, raidDate: guild calendar dates) when the raid has no log and its event is on another
  // day. Every place that links, replaces or refreshes an event (the raid page's Link / Replace / Refresh sign-ups and Plan in Planner, the
  // Raids list's Refresh sign-ups and Plan in Planner) goes through putEvent: it asks, and sends the call again with moveRaid: true on a yes.
  // Cancel (or Escape, or leaving the page) resolves MOVE_CANCELLED: nothing changed and the caller just stops.
  const MOVE_CANCELLED = Object.freeze({ cancelled: true });
  let moveAsk = null;

  function dayOf(date) { return G.ui.weekdayDay(date) || String(date == null ? '' : date); }

  function moveDialogHtml(err) {
    const b = (err && err.body) || {};
    return '<form class="gs-dialog-form" data-submit="raid-move-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Move this raid?</h2>' +
      '<p class="gs-confirm-text" id="dlg-text">This event is on ' + esc(dayOf(b.eventDate)) + ', the raid is on ' + esc(dayOf(b.raidDate)) + '. Move the raid to ' + esc(dayOf(b.eventDate)) + '?</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="dlg-submit">Move raid</button></div></form>';
  }

  function settleMove(ask, yes) {
    if (moveAsk !== ask) return;
    moveAsk = null;
    ask.resolve(yes);
  }

  // Opens the question; resolves true (Move raid) or false (Cancel, Escape, the page changed, or no dialog could open).
  function confirmMove(err) {
    return new Promise(function (resolve) {
      if (moveAsk) settleMove(moveAsk, false);
      const ask = { resolve: resolve };
      moveAsk = ask;
      const dlg = G.ui.openDialog(moveDialogHtml(err), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
      if (!dlg) { settleMove(ask, false); return; } // no dialog could open: nobody said yes
      dlg.addEventListener('close', function () { settleMove(ask, false); });
    });
  }

  G.handlers.submit['raid-move-form'] = function (form) {
    if (moveAsk) settleMove(moveAsk, true);
    G.ui.closeDialogOf(form);
  };

  // The one call: source = the event id or link, otherServer = acceptOtherServer. Resolves the raid detail, or MOVE_CANCELLED.
  function putEvent(gid, rid, source, otherServer) {
    const url = A().apiBase(gid) + '/raids/' + encodeURIComponent(rid) + '/event';
    const body = { source: source, acceptOtherServer: !!otherServer };
    return G.api.put(url, body).then(null, function (err) {
      if (!err || err.code !== 'event_other_day') throw err;
      return confirmMove(err).then(function (yes) {
        if (!yes) return MOVE_CANCELLED;
        return G.api.put(url, Object.assign({}, body, { moveRaid: true })).then(null, function (second) {
          // The team has a raid on that day already: say which day, not the ISO date the Worker names.
          if (second && second.code === 'raid_date_taken' && second.body && second.body.eventDate) {
            second.message = 'This team already has a raid on ' + dayOf(second.body.eventDate) + ', so this raid cannot move there.';
          }
          throw second;
        });
      });
    });
  }

  // Refresh sign-ups: the event is imported again (PUT .../event with the raid's own event id), then the upcoming list is read again. A raid
  // that moved to its event's day is read with the past list too (it may have left Upcoming).
  G.handlers.click['raids-refresh'] = function (el) {
    const x = a().raids;
    if (!x || !x.data) return;
    const row = (x.data.upcoming || []).filter(function (r) { return r.id === el.getAttribute('data-rid'); })[0];
    if (!row || !row.eventId) return;
    el.disabled = true;
    putEvent(x.gid, row.id, row.eventId, row.otherServer).then(function (res) {
      if (res === MOVE_CANCELLED) { el.disabled = false; return null; }
      G.app.applyFlags(x.gid, res);
      const moved = !!(res && res.raid && res.raid.raidOn && res.raid.raidOn !== row.raidOn);
      if (moved) {
        return reloadList(x).then(function () {
          x.note = 'Moved the raid to ' + dayOf(res.raid.raidOn) + '.';
          st().pageAlert = '';
          G.app.render();
        });
      }
      return G.api.get(A().apiBase(x.gid) + '/raids?team=' + encodeURIComponent(x.teamId)).then(function (list) {
        x.data.upcoming = Array.isArray(list.upcoming) ? list.upcoming : [];
        st().pageAlert = '';
        G.app.render();
      });
    }).then(null, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  // Plan in Planner: an event-sourced raid takes its sign-ups from Raid-Helper again first (the call Refresh sign-ups makes, with the same
  // question when the event is on another day), then the Planner opens on the raid (#/planner?raid=<gid>.<rid>, which survives a reload).
  // event: { id, otherServer } or null. A failed refresh keeps the officer on this page with the error. Resolves true when the Planner was
  // opened, false when the officer answered Cancel to the move question (they stay here, nothing changed).
  function planInPlanner(gid, rid, event) {
    const open = function () { window.location.hash = G.router.format({ name: 'planner', gid: gid, rid: rid }); };
    if (!event || !event.id) { open(); return Promise.resolve(true); }
    return putEvent(gid, rid, event.id, event.otherServer).then(function (res) {
      if (res === MOVE_CANCELLED) return false;
      G.app.applyFlags(gid, res);
      open();
      return true;
    });
  }

  G.handlers.click['raids-plan'] = function (el) {
    const x = a().raids;
    if (!x || !x.data) return;
    const row = (x.data.upcoming || []).filter(function (r) { return r.id === el.getAttribute('data-rid'); })[0];
    if (!row) return;
    el.disabled = true;
    planInPlanner(x.gid, row.id, row.eventSourced && row.eventId ? { id: row.eventId, otherServer: !!row.otherServer } : null).then(function (opened) {
      if (!opened) el.disabled = false;
    }, function (err) {
      el.disabled = false;
      G.app.handleError(err, { pageAlert: true });
    });
  };

  // One-click Sign up: the viewer's default character and main spec, as signed up. The row then shows what the Worker answered.
  G.handlers.click['raids-signup'] = function (el) {
    const x = a().raids;
    if (!x || !x.data) return;
    const rid = el.getAttribute('data-rid');
    el.disabled = true;
    return G.api.signups.save(x.gid, rid, { kind: 'signed' }).then(function (view) {
      applySignupView(x, rid, view);
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      el.disabled = false;
      const show = function () { G.app.handleError(err, { pageAlert: true }); };
      // The window closed since the list was read: show the list as it is now, with the reason.
      if (err && err.code === 'signups_closed') reloadList(x).then(show, show); else show();
    });
  };

  G.handlers.click['raids-fill'] = function (el) {
    const x = a().raids;
    if (!x || !x.teamId) return;
    el.disabled = true;
    return G.api.signups.fill(x.gid, x.teamId).then(function (res) {
      x.note = fillText(res);
      return reloadList(x);
    }).then(function () {
      st().pageAlert = '';
      x.tab = 'upcoming';
      G.app.render();
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  G.handlers.click['raids-show-all'] = function () {
    const x = a().raids;
    if (!x) return;
    x.showAll = true;
    G.app.render();
  };

  G.handlers.click['raids-past-all'] = function () {
    const x = a().raids;
    if (!x) return;
    x.showAllPast = true;
    G.app.render();
  };

  G.handlers.click['raids-older'] = function (el) {
    const x = a().raids;
    const gd = currentGd();
    if (!x || !gd || !x.data.raids.length) return;
    const last = x.data.raids[x.data.raids.length - 1];
    el.disabled = true;
    G.api.get(A().apiBase(x.gid) + '/raids?team=' + encodeURIComponent(x.teamId) + '&before=' + encodeURIComponent(last.raidOn)).then(function (res) {
      const more = Array.isArray(res.raids) ? res.raids : [];
      x.data.raids = x.data.raids.concat(more);
      x.more = !!(res && res.hasMore);
      G.app.render();
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  // ── New raid ──
  function newState() { return a().nr || null; }

  function freshForm(gd) {
    return { teamId: G.app.teamFor(gd) || '', event: '', reports: [''], plan: '', mode: 'log', date: '', time: DEFAULT_START, zone: '', title: '', size: '' };
  }

  function editableTeams(gd) {
    return G.shell.activeTeams(gd.teams).filter(function (t) { return G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', t.id); });
  }

  // The guild's calendar date today; '' when the time zone is unusable.
  function guildTodayOf(gd) {
    return dateOf(Date.now(), gd && gd.guild && gd.guild.timeZone ? gd.guild.timeZone : undefined);
  }

  // The raid names of the guild's game version (the planner's raid list, planning templates left out) for the Zone select.
  function zonesOf(gd) {
    const rules = typeof RulesData !== 'undefined' && RulesData && gd && gd.guild ? RulesData[gd.guild.gameVersion] : null;
    const raids = rules && rules.raids ? rules.raids : {};
    return Object.keys(raids).filter(function (k) { return raids[k].tier !== 'Planning templates'; }).map(function (k) { return raids[k].name; });
  }

  // What the New raid form shows for its date: a date from today on adds Start time, Zone and Title; a date after today is a raid
  // that has not happened, so the attendance source and report rows go.
  function whenFlags(f, today) {
    const dated = !!f.date && !!today && f.date >= today;
    const future = dated && f.date > today;
    const manual = f.mode === 'manual' && !future;
    return { dated: dated, future: future, manual: manual, showWhen: dated && !manual, showTime: dated && !manual && !String(f.event || '').trim() };
  }

  function loadNew(r, gd) {
    const gid = gd.guild.id;
    const teams = editableTeams(gd);
    if (!teams.length) {
      return Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'Adding raids is for the officers and team leads of a team.' }));
    }
    const nr = newState();
    if (!nr || nr.gid !== gid || (nr.run && !nr.run.running)) {
      const form = freshForm(gd);
      if (!teams.some(function (t) { return t.id === form.teamId; })) form.teamId = teams[0].id;
      a().nr = { gid: gid, form: form, run: null, error: '' };
    }
    return null;
  }

  function shorten(s) {
    const t = String(s == null ? '' : s).trim();
    return t.length > REPORT_SHORT ? t.slice(0, REPORT_SHORT - 3) + '...' : t;
  }

  function reportRowHtml(value, i, count) {
    const id = 'nr-report-' + i;
    return '<div class="gs-nr-row"><label class="gs-sr" for="' + id + '">Warcraft Logs report ' + (i + 1) + '</label>' +
      '<input class="gs-input nr-report" type="text" id="' + id + '" data-key="' + id + '" placeholder="Report link or code" autocomplete="off" value="' + esc(value) + '">' +
      (count > 1 ? '<button type="button" class="gs-icon-btn" data-action="nr-remove-report" data-idx="' + i + '" data-key="nr-rm-' + i + '" aria-label="Remove report ' + (i + 1) + '">' + G.icons.icon('close', 18) + '</button>' : '') + '</div>';
  }

  // backAction (optional): a failed first step ("Create the raid") also offers "Back to the form", with what was typed kept.
  function runLinesHtml(gid, run, retryAction, backAction) {
    const retry = retryAction || 'nr-retry';
    const words = { pending: 'Waiting', running: 'Working...', ok: 'Done', error: 'Failed', skipped: 'Waiting for the raid' };
    return '<ul class="gs-run-lines" aria-live="polite">' + run.lines.map(function (l) {
      let actions = '';
      if (l.status === 'error') {
        if (backAction && l.id === 'raid' && !run.raidId) actions += '<button type="button" class="gs-btn gs-btn-sm" data-action="' + backAction + '" data-key="nr-back">Back to the form</button>';
        if (l.openRaidId) actions += '<a class="gs-btn gs-btn-sm" href="' + esc(raidHref(gid, l.openRaidId)) + '">Open that raid</a>';
        if (l.accept) actions += '<button type="button" class="gs-btn gs-btn-sm" data-action="' + retry + '" data-line="' + esc(l.id) + '" data-accept="1" data-key="nr-accept-' + esc(l.id) + '">' + esc(l.accept) + '</button>';
        else if (!l.openRaidId) actions += '<button type="button" class="gs-btn gs-btn-sm" data-action="' + retry + '" data-line="' + esc(l.id) + '" data-key="nr-retry-' + esc(l.id) + '">Retry</button>';
      }
      return '<li class="gs-run-line is-' + esc(l.status) + '"><span class="gs-run-status">' + esc(words[l.status] || l.status) + '</span><span class="gs-run-label">' + esc(l.label) + '</span>' +
        (l.message ? '<span class="gs-run-msg" role="status">' + esc(l.message) + '</span>' : '') + (actions ? '<span class="gs-row-actions">' + actions + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function raidNewHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const nr = opts.state;
    const f = nr.form;
    const teams = editableTeams(gd);
    const run = nr.run;
    const today = opts.today || guildTodayOf(gd);
    const flags = whenFlags(f, today);
    const manual = flags.manual;
    const hideFuture = flags.future ? ' hidden' : '';
    const zones = zonesOf(gd);
    const whenFields = '<div class="gs-field" id="nr-time-field"' + (flags.showTime ? '' : ' hidden') + '><label class="gs-label" for="nr-time">Start time</label><input class="gs-input" type="time" id="nr-time" data-key="nr-time" value="' + esc(f.time == null ? DEFAULT_START : f.time) + '" aria-describedby="nr-time-help"><p class="gs-fine" id="nr-time-help">The guild\'s local time.</p></div>' +
      '<div class="gs-field" id="nr-zone-field"' + (flags.showWhen ? '' : ' hidden') + '><label class="gs-label" for="nr-zone">Zone (optional)</label><select class="gs-input" id="nr-zone" data-key="nr-zone">' + G.ui.optionsHtml([{ value: '', label: 'No zone yet' }].concat(zones.map(function (z) { return { value: z, label: z }; })), f.zone || '') + '</select></div>' +
      '<div class="gs-field" id="nr-title-field"' + (flags.showWhen ? '' : ' hidden') + '><label class="gs-label" for="nr-title">Title (optional)</label><input class="gs-input" type="text" id="nr-title" data-key="nr-title" maxlength="100" autocomplete="off" value="' + esc(f.title || '') + '"></div>';
    const sizeField = '<div class="gs-field"><label class="gs-label" for="nr-size">Raid size</label><select class="gs-input" id="nr-size" data-key="nr-size" aria-describedby="nr-size-help">' +
      G.ui.optionsHtml(G.ui.sizeChoices('Automatic - from the zone, else the team\'s size'), f.size == null ? '' : f.size) + '</select>' +
      '<p class="gs-fine" id="nr-size-help">How many players the raid is for. Sign-ups are counted against it. It can be changed on the raid page.</p></div>';
    const teamField = teams.length > 1
      ? '<div class="gs-field"><label class="gs-label" for="nr-team">Team</label><select class="gs-input" id="nr-team" data-key="nr-team">' + G.ui.optionsHtml(teams.map(function (t) { return { value: t.id, label: t.name }; }), f.teamId) + '</select></div>' : '';
    const done = run && !run.running;
    const raidId = run && run.raidId;
    const runBlock = run
      ? '<section class="gs-card-sec" aria-labelledby="nr-run-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="nr-run-h">Creating the raid</h2></div><div class="gs-card-sec-body">' + runLinesHtml(gid, run, null, 'nr-back') +
        (raidId ? '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(raidHref(gid, raidId)) + '">Open raid</a>' + (done ? '<button type="button" class="gs-btn" data-action="nr-another" data-key="nr-another">Add another raid</button>' : '') + '</div>' : '') + '</div></section>'
      : '';
    const form = run ? '' : '<form class="gs-card-sec" data-submit="nr-create-form" novalidate><div class="gs-card-sec-body">' + teamField +
      '<div class="gs-field"><label class="gs-label" for="nr-event">Raid-Helper event (optional)</label><input class="gs-input" type="text" id="nr-event" data-key="nr-event" data-input="nr-when" placeholder="Event link or ID" autocomplete="off" value="' + esc(f.event) + '" aria-describedby="nr-event-help">' +
      '<p class="gs-fine" id="nr-event-help">The sign-ups. The event\'s start time also sets the raid date and time. A future event is fine.</p></div>' +
      '<fieldset class="gs-fieldset" id="nr-source" data-future-hide' + hideFuture + '><legend class="gs-legend">Attendance source</legend><div class="gs-radios">' +
      '<div class="gs-check"><input type="radio" id="nr-mode-log" name="nr-mode" value="log"' + (manual ? '' : ' checked') + ' data-change="nr-mode"><label for="nr-mode-log">Warcraft Logs report</label></div>' +
      '<div class="gs-check"><input type="radio" id="nr-mode-manual" name="nr-mode" value="manual"' + (manual ? ' checked' : '') + ' data-change="nr-mode"><label for="nr-mode-manual">No log - enter attendance by hand</label></div></div></fieldset>' +
      '<div class="gs-field"><label class="gs-label" for="nr-date">Raid date' + (f.event.trim() || (!manual && f.reports.some(function (v) { return v.trim(); })) ? ' (optional)' : '') + '</label><input class="gs-input" type="date" id="nr-date" data-key="nr-date" data-input="nr-when" value="' + esc(f.date) + '" aria-describedby="nr-date-help">' +
      '<p class="gs-fine" id="nr-date-help">Needed unless a Raid-Helper event or a Warcraft Logs report gives the date. The guild\'s calendar date. A date from today on can be a raid that has not happened yet.</p></div>' + whenFields + sizeField +
      (manual ? '<p class="gs-fine" data-future-hide' + hideFuture + '>After the raid is created you tick who was present and give a reason.</p>'
        : '<fieldset class="gs-fieldset" id="nr-reports" data-future-hide' + hideFuture + '><legend class="gs-legend">Warcraft Logs reports (optional)</legend>' + f.reports.map(function (v, i) { return reportRowHtml(v, i, f.reports.length); }).join('') +
          '<div><button type="button" class="gs-btn gs-btn-sm" data-action="nr-add-report" data-key="nr-add-report">Add another report</button></div></fieldset>') +
      '<div class="gs-field"><label class="gs-label" for="nr-plan">Raidsmith plan (optional)</label><textarea class="gs-input gs-textarea" id="nr-plan" data-key="nr-plan" rows="2" placeholder="Plan link or share code" autocomplete="off">' + esc(f.plan) + '</textarea></div>' +
      '<p class="gs-alert" id="nr-error" role="alert"' + (nr.error ? '' : ' hidden') + '>' + esc(nr.error) + '</p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten">Create raid</button><a class="gs-btn" href="' + esc(G.router.format({ name: 'section', gid: gid, section: 'raids' })) + '">Cancel</a></div></div></form>';
    // Raid-Helper first: the event gives the date, the time and the sign-ups, so it is the first thing asked.
    return '<div class="gs-page gs-page-narrow">' + G.ui.pageHeadHtml({ title: 'New raid', context: 'One team\'s raid on one date. Add what you have; the rest can be added later.', back: { href: G.router.format({ name: 'section', gid: gid, section: 'raids' }), label: 'Raids' } }) + form + runBlock + '</div>';
  }

  function mainNew(r, gd) {
    const nr = newState();
    if (!nr || nr.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return raidNewHtml({ guildData: gd, state: nr });
  }

  // The date and event inputs show or hide the when-fields in place (a re-render on blur could swallow the click on Create raid).
  function applyWhen() {
    if (typeof document === 'undefined') return;
    syncForm();
    const nr = newState();
    const gd = currentGd();
    if (!nr || !gd) return;
    const flags = whenFlags(nr.form, guildTodayOf(gd));
    const set = function (id, hide) { const el = document.getElementById(id); if (el) el.hidden = hide; };
    set('nr-time-field', !flags.showTime);
    set('nr-zone-field', !flags.showWhen);
    set('nr-title-field', !flags.showWhen);
    Array.prototype.forEach.call(document.querySelectorAll('[data-future-hide]'), function (el) { el.hidden = flags.future; });
  }

  G.handlers.input['nr-when'] = applyWhen;

  // Reads the form's fields into state (before a re-render drops them).
  function syncForm() {
    const nr = newState();
    if (!nr || typeof document === 'undefined') return;
    const f = nr.form;
    const val = function (id) { const el = document.getElementById(id); return el ? el.value : null; };
    if (val('nr-team') != null) f.teamId = val('nr-team');
    if (val('nr-event') != null) f.event = val('nr-event');
    if (val('nr-date') != null) f.date = val('nr-date');
    if (val('nr-plan') != null) f.plan = val('nr-plan');
    if (val('nr-time') != null) f.time = val('nr-time');
    if (val('nr-zone') != null) f.zone = val('nr-zone');
    if (val('nr-title') != null) f.title = val('nr-title');
    if (val('nr-size') != null) f.size = val('nr-size');
    const reports = document.querySelectorAll('.nr-report');
    if (reports.length) f.reports = Array.prototype.map.call(reports, function (el) { return el.value; });
    const mode = document.querySelector('input[name="nr-mode"]:checked');
    if (mode) f.mode = mode.value;
  }

  G.handlers.change['nr-mode'] = function () { syncForm(); G.app.render(); };
  G.handlers.click['nr-add-report'] = function () {
    syncForm();
    const nr = newState();
    if (!nr) return;
    nr.form.reports.push('');
    G.app.render();
    G.ui.focusByKey('nr-report-' + (nr.form.reports.length - 1));
  };
  G.handlers.click['nr-remove-report'] = function (el) {
    syncForm();
    const nr = newState();
    if (!nr || nr.form.reports.length < 2) return;
    nr.form.reports.splice(Number(el.getAttribute('data-idx')), 1);
    G.app.render();
  };
  // Back from a failed create: the form comes back with everything that was typed (the run only held a copy), the error line goes away.
  G.handlers.click['nr-back'] = function () {
    const nr = newState();
    if (!nr || !nr.run || nr.run.running) return;
    nr.run = null;
    nr.error = '';
    G.app.render();
    G.ui.focusByKey('nr-date');
  };
  G.handlers.click['nr-another'] = function () {
    const gd = currentGd();
    if (!gd) return;
    a().nr = null;
    loadNew({ name: 'raidnew' }, gd);
    G.app.render(true);
  };

  function failMessage(err) { return G.api.classify(err).text; }

  // One step of the run. Resolves when the line has its final status; never rejects (a sign-in loss is routed).
  function execLine(run, line) {
    const gid = run.gid;
    const f = run.form;
    const base = A().apiBase(gid);
    line.status = 'running';
    line.message = '';
    line.accept = '';
    line.openRaidId = '';
    let promise;
    if (line.id === 'raid') {
      promise = G.api.post(base + '/raids', createBody(f, run.acceptOtherServer, run.today)).then(function (res) { run.raidId = res.raid.id; });
    } else if (!run.raidId) {
      line.status = 'skipped';
      return Promise.resolve();
    } else if (line.id === 'plan') {
      promise = G.planSource.read(f.plan, { surname: !!currentGd() && currentGd().guild.gameVersion === 'forever' }).then(function (read) {
        if (!read.ok) { const e = new Error(read.error); e.planError = true; throw e; }
        return G.api.put(base + '/raids/' + encodeURIComponent(run.raidId) + '/plan', { label: read.label, players: read.players, live: read.live }).then(function () {
          if (read.skippedText) line.message = read.skippedText;
        }, function (err) {
          const planText = G.planSource.describeError(err, read.players);
          if (planText) { const e = new Error(planText); e.planError = true; throw e; }
          throw err;
        });
      });
    } else {
      line.status = 'skipped';
      return Promise.resolve();
    }
    return promise.then(function () { line.status = 'ok'; }, function (err) {
      line.status = 'error';
      if (err && err.planError) { line.message = err.message; return; }
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      line.message = c.text;
      const rid = err && err.body && err.body.raidId;
      if (err && (err.code === 'raid_exists' || err.code === 'event_exists' || err.code === 'report_exists') && rid) line.openRaidId = rid;
      if (err && err.code === 'other_server') line.accept = 'Import anyway';
    });
  }

  function stillHere() {
    return typeof window !== 'undefined' && G.router.parse(window.location.hash).name === 'raidnew';
  }

  function runPending(run) {
    run.running = true;
    return run.lines.reduce(function (chain, line) {
      return chain.then(function () {
        if (line.status !== 'pending' && line.status !== 'skipped') return null;
        const p = execLine(run, line);
        if (stillHere()) G.app.render();
        return p.then(function () { if (stillHere()) G.app.render(); });
      });
    }, Promise.resolve()).then(function () {
      run.running = false;
      if (run.form.mode === 'manual' && run.raidId && run.lines.every(function (l) { return l.status === 'ok'; })) {
        a().openManual = run.raidId;
        if (stillHere()) G.app.go(raidHref(run.gid, run.raidId));
        return;
      }
      if (stillHere()) G.app.render();
    });
  }

  // The non-blank report sources of the form; none in manual mode.
  function reportSourcesOf(f) {
    if (f.mode !== 'log') return [];
    return f.reports.map(function (v) { return v.trim(); }).filter(Boolean);
  }

  // The body of the one POST /raids: the date comes from the event or the first pull when there is one. With today (the guild's
  // calendar date), a date from today on also sends the start time (not with an event: it sets the time), zone and title.
  function createBody(f, acceptOtherServer, today) {
    const body = { teamId: f.teamId };
    const reports = reportSourcesOf(f);
    if (f.date) body.raidOn = f.date;
    if (f.event.trim()) body.eventSource = f.event.trim();
    if (reports.length) body.reportSources = reports;
    if (today && whenFlags(f, today).showWhen) {
      if (f.time && !f.event.trim()) body.startTime = f.time;
      if (f.zone) body.zone = f.zone;
      if (String(f.title || '').trim()) body.title = String(f.title).trim();
    }
    if (f.size !== '' && f.size != null) body.size = Number(f.size); // Automatic sends nothing: the Worker picks the zone's size, else the team's
    if (acceptOtherServer) body.acceptOtherServer = true;
    return body;
  }

  function buildLines(f) {
    // One create call carries the event and every report, so a failed source writes nothing; only the plan is a second step.
    const reports = reportSourcesOf(f);
    const from = [f.event.trim() ? 'Raid-Helper event' : '', reports.length ? plural(reports.length, 'Warcraft Logs report', 'Warcraft Logs reports') : ''].filter(Boolean).join(' and ');
    const lines = [{ id: 'raid', label: from ? 'Create the raid from the ' + from : 'Create the raid', status: 'pending' }];
    if (f.plan.trim()) lines.push({ id: 'plan', label: 'Raidsmith plan', status: 'pending' });
    return lines;
  }

  G.handlers.submit['nr-create-form'] = function () {
    syncForm();
    const nr = newState();
    const gd = currentGd();
    if (!nr || !gd) return;
    const f = nr.form;
    const today = guildTodayOf(gd);
    const flags = whenFlags(f, today);
    // A raid that has not happened yet has no log and no hand-entered attendance.
    if (flags.future) { f.mode = 'log'; f.reports = ['']; }
    nr.error = '';
    if (!f.teamId) nr.error = 'Choose a team.';
    else if (f.date && !RAID_DATE.test(f.date)) nr.error = 'Enter the raid date as a calendar date.';
    else if (flags.showTime && !RAID_TIME.test(f.time || '')) nr.error = 'Enter the start time of the raid.';
    else if (!f.event.trim() && !f.date && !reportSourcesOf(f).length) nr.error = 'Enter the raid date, a Raid-Helper event, or a Warcraft Logs report that gives it.';
    if (nr.error) { G.app.render(); G.ui.focusByKey(/start time/.test(nr.error) ? 'nr-time' : 'nr-date'); return; }
    nr.run = { gid: gd.guild.id, form: JSON.parse(JSON.stringify(f)), lines: buildLines(f), raidId: null, running: true, acceptOtherServer: false, today: today };
    G.app.render();
    runPending(nr.run);
  };

  G.handlers.click['nr-retry'] = function (el) {
    const nr = newState();
    if (!nr || !nr.run || nr.run.running) return;
    const line = nr.run.lines.filter(function (l) { return l.id === el.getAttribute('data-line'); })[0];
    if (!line) return;
    if (el.getAttribute('data-accept') === '1') {
      if (line.id === 'raid') nr.run.acceptOtherServer = true;
    }
    line.status = 'pending';
    runPending(nr.run);
  };

  G.pages.raids = {
    raidsHtml: raidsHtml, statePillsHtml: statePillsHtml, sourceChipsHtml: sourceChipsHtml, bossesText: bossesText, whenText: whenText, timeNotSetHtml: timeNotSetHtml, momentText: momentText, deadlineHtml: deadlineHtml, closeNoteText: closeNoteText, zoneSizeText: zoneSizeText, signupsText: signupsText, planPillHtml: planPillHtml,
    planInPlanner: planInPlanner, putEvent: putEvent, MOVE_CANCELLED: MOVE_CANCELLED, moveDialogHtml: moveDialogHtml, statusChipHtml: statusChipHtml, cardHtml: cardHtml, fillText: fillText, applySignupView: applySignupView, reloadList: reloadList, load: loadList, main: mainList,
  };
  G.pages.raidNew = { raidNewHtml: raidNewHtml, buildLines: buildLines, createBody: createBody, runLinesHtml: runLinesHtml, load: loadNew, main: mainNew, syncForm: syncForm };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
