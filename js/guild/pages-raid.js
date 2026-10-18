// ── PAGE: RAID DETAIL ───────────────────────────────────────────
// One raid: the header (title, one summary line, one Actions menu), the source strip (one slim chip each for the Raid-Helper event, Warcraft Logs
// reports and plan, with a "..." menu of that source's actions), the people table (class badge, sign-up tag, plan, boss-pull bar, outcome pill, Change
// button; stacked cards on a phone), the unmatched characters, and the dialogs that change the raid (event, report, plan, manual attendance, delete).
// The menus are ui.menuHtml / ui.menu. GET /raids/:rid; every write answers with the detail.
// The Decide and Unmatched dialogs live in pages-review.js and work here too (where = 'raid').
// A raid that has not started (raid.upcoming) shows its start time ("Time not set" for a date-only raid), sign-ups, event and plan instead, with
// a note that attendance starts after the raid. The title carries the zone and the raid's size; officers get a Raid settings card (the raid's own
// size and sign-up deadline, PATCH /raids/:rid). Every raid carries the Sign-ups panel (pages-raid-signups.js; a past raid's only for officers or when there
// are sign-ups) and a past raid also the Loot card (pages-raid-loot.js), both loaded with the detail.
(function (G) {
  'use strict';

  const REASON_MIN = 3;
  const REASON_MAX = 200;
  const MAX_PRESENT = 80;
  const OK_MANUAL = ['present', 'fill_in'];

  function A() { return G.pages.attendance; }
  function R() { return G.pages.review; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }
  function raidBase(gid, rid) { return A().apiBase(gid) + '/raids/' + encodeURIComponent(rid); }
  function cur() {
    const x = a().raid;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id && x.data ? { gid: gd.guild.id, gd: gd, rid: x.rid, data: x.data, x: x } : null;
  }

  // ── pure view helpers ──
  function bossCounts(data) {
    const pulls = Array.isArray(data.pulls) ? data.pulls : [];
    return { kills: pulls.filter(function (p) { return p.kill; }).length, pulls: pulls.length };
  }

  function statePill(data) {
    const r = data.raid || {};
    const flags = r.openFlags > 0 ? r.openFlags : 0;
    return G.pages.raids.statePillsHtml({ state: r.upcoming ? 'upcoming' : r.state, openFlags: flags, stale: !!r.stale });
  }

  function isUpcoming(data) { return !!(data.raid && data.raid.upcoming); }

  // The Sign-ups panel (native Raidsmith sign-ups merged with Raid-Helper's); nothing while its data is not loaded.
  function signupsPanelHtml(gd, data, signups) {
    return G.pages.raidSignups ? G.pages.raidSignups.panelHtml({ guildData: gd, data: data, state: signups }) : '';
  }

  function isManual(data) { return !!(data.raid && data.raid.state === 'manual') || !!(data.raid && data.raid.manual); }

  function hasReports(data) { return !!(data.sources && Array.isArray(data.sources.reports) && data.sources.reports.length); }

  function signupOf(data) {
    const m = {};
    (Array.isArray(data.signups) ? data.signups : []).forEach(function (s) { if (s && s.playerId && !m[s.playerId]) m[s.playerId] = s; });
    return m;
  }

  // Flagged rows first (they need a decision), then by name.
  function sortedPeople(people) {
    return people.slice().sort(function (x, y) {
      const fx = needsReview(x) ? 0 : 1;
      const fy = needsReview(y) ? 0 : 1;
      return fx - fy || String(x.name).localeCompare(String(y.name), 'en');
    });
  }

  // The Worker sends needsReview; decided rows keep their flags, so flags alone do not mean "open".
  function needsReview(row) { return !!(row && (row.needsReview || row.pending)); }

  function planText(p) { return p === 'bench' ? 'Bench' : p ? String(p) : '-'; }

  // ── people table and cards ──
  // One row, two shapes built from the same cell pieces: the table (fixed column widths) and, on a phone, stacked cards. Colour is never the only
  // signal: every chip carries its words (and the outcome its letter), and the tones differ in lightness (guild.css, --gs-tone-*).
  const CLASS_CODES = { WARRIOR: 'WR', PALADIN: 'PL', HUNTER: 'HN', ROGUE: 'RG', PRIEST: 'PR', SHAMAN: 'SH', MAGE: 'MG', WARLOCK: 'WL', DRUID: 'DR' };
  const SIGNUP_TONES = { signed: 'signed', late: 'late', tentative: 'tentative', standby: 'tentative', bench: 'tentative', absence: 'absence' };
  const PULL_SEGMENTS = 12;

  function tagHtml(tone, text) { return '<span class="gs-tag gs-tag-' + tone + '">' + esc(text) + '</span>'; }

  // The spec each person signed up with, by player id: the Sign-ups panel's list has it normalised ("Protection" for Raid-Helper's "Protection1").
  function specIndex(signupState) {
    const view = signupState && signupState.status === 'ok' ? signupState.data : null;
    const out = {};
    (view && Array.isArray(view.entries) ? view.entries : []).forEach(function (e) { if (e && e.personId && e.spec && !out[e.personId]) out[e.personId] = e.spec; });
    return out;
  }

  // The spec line under a name: the class and the spec the player signed up with, else the class alone. Without the panel's list the raid's own
  // sign-up row gives it (Raid-Helper's name without its trailing digit), and only when that row names the same class: Raid-Helper's Late /
  // Bench / Absence rows carry a meta class instead.
  function specLineHtml(row, signup, specs) {
    if (!row.class) return '';
    let spec = specs[row.playerId] || '';
    if (!spec && signup && signup.specName && String(signup.className || '').toUpperCase() === String(row.class).toUpperCase()) spec = String(signup.specName).replace(/\d+$/, '');
    return G.ui.specLineHtml(row.class, spec);
  }

  function playerCellHtml(gid, row, see, signups, specs) {
    const code = Object.prototype.hasOwnProperty.call(CLASS_CODES, row.class) ? CLASS_CODES[row.class] : '?';
    const spec = specLineHtml(row, signups[row.playerId], specs);
    return '<span class="gs-who"><span class="gs-classbadge ' + G.ui.classClass(row.class) + '" aria-hidden="true">' + esc(code) + '</span><span class="gs-who-text">' + personLinkHtml(gid, row, see) +
      (spec ? '<span class="gs-char-sub">' + spec + '</span>' : '') + '</span></span>';
  }

  // The sign-up kind as a coloured chip (Signed green, Late amber, Tentative / Standby / Bench muted, Absence red); no sign-up is grey.
  function signupCellHtml(row, signups) {
    if (!row.signup) return tagHtml('none', 'No sign-up');
    const s = signups[row.playerId];
    const tone = Object.prototype.hasOwnProperty.call(SIGNUP_TONES, row.signup) ? SIGNUP_TONES[row.signup] : 'tentative';
    return tagHtml(tone, A().KIND_LABELS[row.signup] || row.signup) + (s && s.nickname ? '<span class="gs-char-sub">' + esc(s.nickname) + '</span>' : '');
  }

  function planCellHtml(plan) {
    if (!plan) return '<span class="gs-muted">-</span>';
    return '<span class="gs-plan' + (plan === 'bench' ? ' is-bench' : '') + '">' + esc(planText(plan)) + '</span>';
  }

  // A bar of up to PULL_SEGMENTS cells, the first ones filled: present of total (a long night is scaled down, never to 0 or full unless it is).
  function pullBarHtml(p) {
    const segs = Math.min(p.total, PULL_SEGMENTS);
    let on = p.total <= PULL_SEGMENTS ? p.present : Math.round(p.present / p.total * PULL_SEGMENTS);
    if (p.present > 0) on = Math.max(on, 1);
    if (p.present < p.total) on = Math.min(on, segs - 1);
    let cells = '';
    for (let i = 0; i < segs; i++) cells += '<span' + (i < on ? ' class="is-on"' : '') + '></span>';
    return '<span class="gs-pullbar" aria-hidden="true">' + cells + '</span>';
  }

  function pullsCellHtml(row) {
    const p = row.pulls || {};
    if (!(p.total > 0)) return '<span class="gs-muted">-</span>';
    return '<span class="gs-pulls">' + pullBarHtml(p) + '<span class="gs-nowrap gs-pull-num">' + esc(p.present) + '/' + esc(p.total) + '</span></span>' +
      (p.present > 0 && p.missedFirst ? '<span class="gs-chip gs-chip-flag">missed first</span>' : '') + (p.present > 0 && p.missedLast ? '<span class="gs-chip gs-chip-flag">missed last</span>' : '');
  }

  // The outcome as a pill: its letter box (the Attendance colours) and its words.
  function outcomePillHtml(outcome, pending) {
    const known = Object.prototype.hasOwnProperty.call(A().LETTERS, outcome);
    const id = known ? outcome : 'none';
    const label = known ? A().OUTCOME_LABELS[outcome] : String(outcome == null ? '' : outcome);
    return '<span class="gs-opill gs-opill-' + id + '"><span class="gs-cell gs-out-' + id + (pending ? ' is-pending' : '') + '" aria-hidden="true">' + esc(known ? A().LETTERS[outcome] : '?') + (pending ? '?' : '') + '</span>' +
      '<span>' + esc(label) + (pending ? ' (awaiting review)' : '') + '</span></span>';
  }

  function outcomeCellHtml(row, canReview) {
    // A stored decision whose flags no longer match is not applied: no "Decided" note, only a muted hint for reviewers.
    let decided = '';
    if (row.decision && row.decision.applied) decided = '<span class="gs-char-sub">Decided' + (row.decision.reason ? ': ' + esc(row.decision.reason) : '') + (row.decision.by ? ' (' + esc(row.decision.by) + ')' : '') + '</span>';
    else if (row.decision && canReview) decided = '<span class="gs-char-sub gs-muted">An earlier decision no longer applies</span>';
    return '<div class="gs-outcell">' + outcomePillHtml(row.outcome, row.pending) + '<span class="gs-fine">' + esc(A().creditText(row.credit, row.pending)) + '</span>' + A().flagChipsHtml(row.flags) + '</div>' + decided;
  }

  // Reviewers: "Decide" (words) on a flagged row, a compact pencil button on the others.
  function changeButtonHtml(row, canReview, rid) {
    if (!canReview || !row.outcome) return '';
    const attrs = ' data-action="decide-open" data-rid="' + esc(rid) + '" data-pid="' + esc(row.playerId) + '" data-where="raid" data-key="decide-' + esc(row.playerId) + '"';
    if (needsReview(row)) return '<button type="button" class="gs-btn gs-btn-sm"' + attrs + '>Decide</button>';
    return '<button type="button" class="gs-iconbtn"' + attrs + ' aria-label="Change outcome for ' + esc(row.name) + '" title="Change outcome">' + G.icons.icon('edit', 16) + '</button>';
  }

  function personLinkHtml(gid, row, seeAttendance) {
    if (!seeAttendance) return G.ui.classNameHtml(row.name, row.class);
    return '<a class="gs-char-link ' + G.ui.classClass(row.class) + '" href="' + esc(G.router.format({ name: 'personatt', gid: gid, pid: row.playerId })) + '">' + esc(row.name) + '</a>';
  }

  function peopleTableHtml(gid, data, rows, signupState) {
    const signups = signupOf(data);
    const specs = specIndex(signupState);
    const rid = data.raid.id;
    const canReview = !!(data.can && data.can.review);
    const see = !!(data.can && data.can.seeAttendance);
    const body = rows.map(function (row) {
      return '<tr><th scope="row" class="gs-cell-strong">' + playerCellHtml(gid, row, see, signups, specs) + '</th><td>' + signupCellHtml(row, signups) + '</td><td>' + planCellHtml(row.plan) + '</td><td>' + pullsCellHtml(row) +
        '</td><td>' + outcomeCellHtml(row, canReview) + '</td><td class="gs-col-act">' + changeButtonHtml(row, canReview, rid) + '</td></tr>';
    }).join('');
    const cards = rows.map(function (row) {
      return '<li class="gs-roster-card gs-pcard"><div class="gs-pcard-top">' + playerCellHtml(gid, row, see, signups, specs) + changeButtonHtml(row, canReview, rid) + '</div>' +
        '<div class="gs-pcard-meta"><span class="gs-pcard-su">' + signupCellHtml(row, signups) + '</span>' + (row.plan ? '<span class="gs-pcard-plan"><span class="gs-fine">Plan</span>' + planCellHtml(row.plan) + '</span>' : '') + pullsCellHtml(row) + '</div>' +
        outcomeCellHtml(row, canReview) + '</li>';
    }).join('');
    return '<div class="gs-table-wrap gs-raid-people"><table class="gs-table gs-table-raidpeople" aria-label="People on this raid"><thead><tr><th scope="col" class="gs-col-player">Player</th><th scope="col" class="gs-col-signup">Sign-up</th><th scope="col" class="gs-col-plan">Plan</th>' +
      '<th scope="col" class="gs-col-pulls">Boss pulls</th><th scope="col">Outcome</th><th scope="col" class="gs-col-act"><span class="gs-sr">Change</span></th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<ul class="gs-roster-cards gs-raid-cards" aria-label="People on this raid">' + cards + '</ul>';
  }

  // Present (fill-ins too), Bench and Missed (with notice too), counted from the people list.
  function countsOf(people) {
    const count = function (f) { return people.filter(f).length; };
    return {
      present: count(function (p) { return p.outcome === 'present' || p.outcome === 'fill_in'; }),
      bench: count(function (p) { return p.outcome === 'bench'; }),
      missed: count(function (p) { return p.outcome === 'missed' || p.outcome === 'missed_notice'; }),
    };
  }

  function countsText(c) { return c.present + ' present, ' + c.bench + ' bench, ' + c.missed + ' missed'; }

  // The Needs review / Everyone switch on the left, the totals in their colours on the right.
  function peopleToolbarHtml(people, filter) {
    const c = countsOf(people);
    const segs = '<div class="gs-segs" role="group" aria-label="Show"><button type="button" class="gs-seg" data-action="raid-filter" data-filter="review" data-key="rf-review" aria-pressed="' + (filter === 'review' ? 'true' : 'false') + '">Needs review <span class="gs-seg-count">' + people.filter(needsReview).length + '</span></button>' +
      '<button type="button" class="gs-seg" data-action="raid-filter" data-filter="all" data-key="rf-all" aria-pressed="' + (filter === 'all' ? 'true' : 'false') + '">Everyone <span class="gs-seg-count">' + people.length + '</span></button></div>';
    const tally = '<p class="gs-tally"><span class="gs-tally-present"><b>' + c.present + '</b> present</span><span class="gs-tally-bench"><b>' + c.bench + '</b> bench</span><span class="gs-tally-missed"><b>' + c.missed + '</b> missed</span></p>';
    return '<div class="gs-ptoolbar">' + segs + tally + '</div>';
  }

  function unmatchedBlockHtml(data) {
    const list = Array.isArray(data.unmatched) ? data.unmatched : [];
    if (!list.length) return '';
    const canReview = !!(data.can && data.can.review);
    return '<section class="gs-card-sec" aria-labelledby="unm-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="unm-h">Unmatched characters</h2></div><ul class="gs-review-list">' + list.map(function (u) {
      return '<li class="gs-review-item"><div class="gs-review-who">' + G.ui.classNameHtml(u.name, u.class) + A().flagChipsHtml(['unmatched']) + '<span class="gs-char-sub">' + esc(R().unmatchedEvidence(u)) + '</span></div>' +
        (canReview ? '<div class="gs-row-actions">' + R().itemActionsHtml(data.raid.id, Object.assign({}, u), 'raid') + '</div>' : '') + '</li>';
    }).join('') + '</ul></section>';
  }

  // The Loot card of a past raid; nothing while its data is not loaded (or the viewer does not see loot).
  function lootCardHtml(gd, data, loot) {
    return G.pages.raidLoot ? G.pages.raidLoot.cardHtml({ guildData: gd, data: data, state: loot }) : '';
  }

  // The Loot board card (PM wave 5) of an upcoming or a past raid; nothing while its data is not loaded, when the loot visibility keeps the viewer out, or
  // when nothing was pasted and the viewer cannot paste.
  function boardCardHtml(gd, data, board) {
    return G.pages.raidBoard ? G.pages.raidBoard.cardHtml({ guildData: gd, data: data, state: board }) : '';
  }

  // ── source strip ──
  // One slim chip per source (Raid-Helper event, Warcraft Logs reports, Raidsmith plan), all the same height: a status dot, the source, one line of
  // what it holds and, for those who may edit, a "..." menu with that source's actions. A source with nothing linked is a dashed chip whose one
  // action ("Link an event", "Add report", "Link a plan") is a button. Every action is still a raid-op: the dialogs are the ones they always were.
  function btn(op, label, extra, key) {
    return '<button type="button" class="gs-btn gs-btn-sm" data-action="raid-op" data-op="' + op + '"' + (extra || '') + ' data-key="' + esc(key || op) + '">' + esc(label) + '</button>';
  }

  function opItem(op, label, extra, danger) {
    return { label: label, danger: !!danger, key: 'mi-' + op + (extra && extra.code ? '-' + extra.code : ''), data: Object.assign({ action: 'raid-op', op: op }, extra || {}) };
  }

  function sourceMenuHtml(id, ariaLabel, items) {
    return G.ui.menuHtml({ id: 'src-' + id, icon: 'more', ariaLabel: ariaLabel, triggerClass: 'gs-btn gs-btn-sm', items: items });
  }

  // o: { id, name, title, detail, linked, actions (html) }
  function sourceChipHtml(o) {
    return '<div class="gs-src' + (o.linked ? '' : ' is-empty') + '" data-src="' + o.id + '"><span class="gs-src-dot" aria-hidden="true"></span><span class="gs-src-name">' + esc(o.name) + '</span>' +
      '<span class="gs-src-title">' + esc(o.title) + '</span>' + (o.detail ? '<span class="gs-src-detail">' + esc(o.detail) + '</span>' : '') + (o.actions || '') + '</div>';
  }

  function eventChipHtml(data, edit) {
    const ev = data.sources && data.sources.event;
    if (!ev) {
      return sourceChipHtml({ id: 'event', name: 'Raid-Helper', title: 'none', linked: false, actions: edit ? btn('event-replace', 'Link an event') : '' });
    }
    const detail = plural(ev.signups || 0, 'sign-up', 'sign-ups') + (ev.syncedAt ? ', synced ' + G.ui.relativeTime(ev.syncedAt).toLowerCase() : '') + (ev.otherServer ? ', from another Discord server' : '');
    return sourceChipHtml({ id: 'event', name: 'Raid-Helper', title: ev.title || 'Raid-Helper event', detail: detail, linked: true,
      actions: edit ? sourceMenuHtml('event', 'Raid-Helper event actions', [opItem('event-refresh', 'Refresh sign-ups'), opItem('event-replace', 'Replace event'), { separator: true }, opItem('event-remove', 'Remove event', null, true)]) : '' });
  }

  function reportsChipHtml(data, edit) {
    const list = data.sources && Array.isArray(data.sources.reports) ? data.sources.reports : [];
    const manual = isManual(data);
    if (!list.length) {
      return sourceChipHtml({ id: 'logs', name: 'Warcraft Logs', title: 'none', detail: manual ? 'attendance entered by hand' : '', linked: false, actions: edit && !manual ? btn('report-add', 'Add report') : '' });
    }
    const pulls = list.reduce(function (sum, r) { return sum + (r.pulls || 0); }, 0);
    const items = [];
    list.forEach(function (r, i) {
      if (i) items.push({ separator: true });
      items.push(opItem('report-refresh', 'Refresh ' + r.code, { code: r.code }));
      items.push(opItem('report-remove', 'Remove ' + r.code, { code: r.code }, true));
    });
    if (!manual) items.push({ separator: true }, opItem('report-add', 'Add report'));
    return sourceChipHtml({ id: 'logs', name: 'Warcraft Logs', title: plural(list.length, 'report', 'reports'), detail: plural(pulls, 'boss pull', 'boss pulls'), linked: true,
      actions: edit ? sourceMenuHtml('logs', 'Warcraft Logs actions', items) : '' });
  }

  function planChipHtml(data, edit) {
    const p = data.sources && data.sources.plan;
    if (!p) {
      return sourceChipHtml({ id: 'plan', name: 'Plan', title: 'none', linked: false, actions: edit ? btn('plan-replace', 'Link a plan') : '' });
    }
    return sourceChipHtml({ id: 'plan', name: 'Plan', title: p.label || 'Plan', detail: plural(p.players || 0, 'player', 'players'), linked: true,
      actions: edit ? sourceMenuHtml('plan', 'Plan actions', [opItem('plan-replace', 'Replace plan'), { separator: true }, opItem('plan-remove', 'Remove plan', null, true)]) : '' });
  }

  // A raid that has not started has no log: the event and the plan only.
  function sourceStripHtml(data, edit, upcoming) {
    return '<div class="gs-srcstrip" role="group" aria-label="Sources">' + eventChipHtml(data, edit) + (upcoming ? '' : reportsChipHtml(data, edit)) + planChipHtml(data, edit) + '</div>';
  }

  function manualLineHtml(data, edit) {
    if (!isManual(data)) return '';
    const m = data.raid.manual || {};
    // Who entered it and why are for reviewers; the server leaves them out for everyone else, and then the date goes too.
    const detailed = !!(m.by || m.reason);
    const who = detailed ? [m.by ? 'by ' + m.by : '', m.at ? 'on ' + G.ui.formatDate(m.at) : ''].filter(Boolean).join(' ') : '';
    return '<div class="gs-notice gs-manual-line" role="status"><span><strong>No log - attendance entered by hand</strong>' + (who ? ' ' + esc(who) : '') + (m.reason ? '. Reason: ' + esc(m.reason) : '') + '.</span>' +
      (edit ? '<span class="gs-row-actions">' + btn('manual-edit', 'Edit') + btn('manual-remove', 'Remove') + '</span>' : '') + '</div>';
  }

  // The one Actions menu of the page, for those who may edit the raid. Every action of the old button row and the cards is in it or on a source chip;
  // Delete raid (the only destructive one) is set apart at the bottom. ctx: { loot, roster } (the loot and roster card states).
  function actionsMenuHtml(data, ctx) {
    if (!(data.can && data.can.edit)) return '';
    const upcoming = isUpcoming(data);
    const loot = G.pages.raidLoot;
    const roster = G.pages.raidRoster;
    const items = [];
    if (!upcoming) {
      items.push({ label: 'Recalculate attendance', key: 'mi-recompute', data: { action: 'raid-op', op: 'recompute' } });
      if (!isManual(data) && !hasReports(data)) items.push({ label: 'Mark as No log', key: 'mi-manual-open', data: { action: 'raid-op', op: 'manual-open' } });
      if (loot && loot.canImport(ctx.loot)) items.push({ label: 'Import loot from Gargul', key: 'mi-loot-import', data: { action: 'loot-import-open' } });
      if (loot && loot.canAdd(ctx.loot)) items.push({ label: 'Add loot award', key: 'mi-loot-add', data: { action: 'loot-add-open' } });
    }
    const board = G.pages.raidBoard;
    if (board) {
      if (board.canPaste(ctx.board, 'tmb')) items.push({ label: board.LISTS.tmb.label, key: 'mi-board-tmb', data: { action: 'board-open', list: 'tmb' } });
      if (board.canPaste(ctx.board, 'softres')) items.push({ label: board.LISTS.softres.label, key: 'mi-board-softres', data: { action: 'board-open', list: 'softres' } });
    }
    items.push({ label: 'Open in Planner', key: 'mi-plan-in-planner', data: { action: 'raid-op', op: 'plan-in-planner' } });
    if (roster && roster.canPublish(data, ctx.roster)) items.push({ label: 'Publish roster', key: 'mi-ro-publish', data: { action: 'roster-publish', op: 'publish' } });
    items.push({ separator: true }, { label: 'Delete raid', key: 'mi-raid-delete', danger: true, data: { action: 'raid-op', op: 'raid-delete' } });
    return G.ui.menuHtml({ id: 'raid-actions', label: 'Actions', key: 'raid-actions', items: items });
  }

  // Title, one summary line (team, bosses, present / bench / missed or the start time, status chips) and the Actions menu.
  function headHtml(gd, data, ctx) {
    const r = data.raid;
    const team = A().teamOf(gd, idOf(r.team));
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const upcoming = isUpcoming(data);
    const people = Array.isArray(data.people) ? data.people : null;
    const where = G.pages.raids.zoneSizeText(r.zone, r.size);
    const parts = [];
    if (several && team) parts.push(esc(team.name));
    if (upcoming) {
      parts.push((r.title ? esc(r.title) + ' &middot; ' : '') + 'Starts ' + esc(G.pages.raids.whenText(r, gd)) + (r.timeKnown === false ? ' &middot; <span class="gs-time-unset">Time not set</span>' : ''));
    } else {
      const bosses = G.pages.raids.bossesText(bossCounts(data));
      if (bosses !== '-') parts.push(esc(bosses));
      if (people && people.length) parts.push(esc(countsText(countsOf(people))));
    }
    const line = parts.map(function (p) { return '<span>' + p + '</span>'; }).join('<span class="gs-sumsep" aria-hidden="true"></span>');
    const chips = '<span class="gs-sumchips">' + statePill(data) + (upcoming ? G.pages.raids.planPillHtml({ planned: !!(data.sources && data.sources.plan) }) : '') + '</span>';
    return '<div class="gs-roster-head gs-raidhead"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">' + esc(G.ui.weekdayDay(r.raidOn) || r.raidOn) + (where ? ' - ' + esc(where) : '') + '</h1>' +
      '<div class="gs-sub gs-sumline">' + line + (line ? '<span class="gs-sumsep" aria-hidden="true"></span>' : '') + chips + '</div></div>' + actionsMenuHtml(data, ctx) + '</div>';
  }

  // ── Raid settings (officers): the raid's own size and sign-up deadline ──
  const MAX_CLOSE_HOURS = 72;
  const AUTO_SIZE = 'Automatic - from the zone, else the team\'s size';

  function hoursText(n) { return plural(n, 'hour', 'hours'); }

  // The team's own deadline: the raid's when it has no override of its own; else the Raids list's copy of the team (it carries it), else unknown.
  function teamCloseHours(data) {
    const r = data.raid;
    if (r.closeHoursOverride == null) return typeof r.closeHours === 'number' ? r.closeHours : null;
    const list = a().raids;
    const team = list && list.data && list.data.team;
    return team && team.id === idOf(r.team) && typeof team.signupCloseHours === 'number' ? team.signupCloseHours : null;
  }

  // What is in effect now, in a sentence each.
  function sizeInEffectText(r) {
    if (typeof r.size !== 'number') return '';
    return 'In effect: ' + plural(r.size, 'player', 'players') + (r.sizeOverride != null ? ', set for this raid.' : ', picked from the zone, else the team\'s size.');
  }

  function deadlineInEffectText(r, gd) {
    if (typeof r.closeHours !== 'number') return '';
    const own = r.closeHoursOverride != null;
    const source = own ? ', set for this raid.' : ', the team\'s setting.';
    // A raid with only a date has no start to count from: the Worker says when it closes instead, and why.
    if (r.closesSource && typeof r.closesAt === 'number') {
      return 'In effect: members can change their sign-up until ' + G.pages.raids.momentText(r.closesAt, gd) + ' (' + G.pages.raids.closeNoteText(r) + ')' + source;
    }
    if (!(r.closeHours > 0)) return 'In effect: members can change their sign-up until the raid starts' + source;
    const when = typeof r.closesAt === 'number' ? G.pages.raids.momentText(r.closesAt, gd) : '';
    return 'In effect: members can change their sign-up until ' + hoursText(r.closeHours) + ' before the start' + (when ? ' (' + when + ')' : '') + source;
  }

  function settingsCardHtml(gd, data) {
    const r = data.raid;
    if (!(data.can && data.can.edit)) return '';
    const own = r.closeHoursOverride != null;
    const teamHours = teamCloseHours(data);
    const sizeField = '<div class="gs-field"><label class="gs-label" for="rs-size">Raid size</label><select class="gs-input" id="rs-size" name="size" data-key="rs-size" aria-describedby="rs-size-help">' +
      G.ui.optionsHtml(G.ui.sizeChoices(AUTO_SIZE), r.sizeOverride == null ? '' : r.sizeOverride) + '</select>' +
      '<p class="gs-fine" id="rs-size-help">' + esc(sizeInEffectText(r)) + '</p><p class="gs-field-error" id="rs-err-size" role="alert" hidden></p></div>';
    // The deadline only means something until the raid starts.
    const hoursField = !isUpcoming(data) ? '' :
      '<div class="gs-field"><label class="gs-label" for="rs-hours-mode">Sign-up deadline</label><select class="gs-input" id="rs-hours-mode" name="hoursMode" data-change="rs-hours-mode" data-key="rs-hours-mode" aria-describedby="rs-hours-help">' +
      G.ui.optionsHtml([{ value: '', label: 'Team default' + (teamHours == null ? '' : ' (' + hoursText(teamHours) + ')') }, { value: 'custom', label: 'Set for this raid' }], own ? 'custom' : '') + '</select>' +
      '<div class="gs-field" id="rs-hours-field"' + (own ? '' : ' hidden') + '><label class="gs-label" for="rs-hours">Hours before the start (0 = when the raid starts)</label>' +
      '<input class="gs-input" type="number" id="rs-hours" name="hours" data-key="rs-hours" min="0" max="' + MAX_CLOSE_HOURS + '" step="1" inputmode="numeric" autocomplete="off" value="' + (own ? esc(r.closeHoursOverride) : '') + '"></div>' +
      '<p class="gs-fine" id="rs-hours-help">' + esc(deadlineInEffectText(r, gd)) + '</p><p class="gs-field-error" id="rs-err-hours" role="alert" hidden></p></div>';
    return '<section class="gs-card-sec gs-rs" aria-labelledby="rs-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="rs-h">Raid settings</h2></div><div class="gs-card-sec-body">' +
      '<form class="gs-su-form" data-submit="raid-settings-form" novalidate><div class="gs-su-fields">' + sizeField + hoursField + '</div>' +
      '<p class="gs-alert" id="rs-error" role="alert" hidden></p>' +
      '<div class="gs-row-actions"><button type="submit" class="gs-btn gs-btn-sm gs-btn-molten" data-key="rs-save">Save settings</button></div></form></div></section>';
  }

  // "Your seat" (members) and the Roster card (officers) of the published roster (pages-raid-roster.js); nothing while its data is not loaded.
  function seatHtml(gd, data, roster) {
    return G.pages.raidRoster ? G.pages.raidRoster.seatHtml({ guildData: gd, data: data, state: roster }) : '';
  }

  function rosterCardHtml(gd, data, roster) {
    return G.pages.raidRoster ? G.pages.raidRoster.cardHtml({ guildData: gd, data: data, state: roster }) : '';
  }

  // opts: { guildData, data (GET /raids/:rid), filter: 'review'|'all'|null, alert, note, progress, loot (G.pages.raidLoot.stateFor), signups (G.pages.raidSignups.stateFor), roster (G.pages.raidRoster.stateFor) }
  function raidHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data;
    const edit = !!(data.can && data.can.edit);
    const people = Array.isArray(data.people) ? data.people : null;
    if (isUpcoming(data)) {
      return '<div class="gs-page gs-raid-page">' + headHtml(gd, data, opts) + G.pages.review.noteHtml(opts.note) + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + sourceStripHtml(data, edit, true) +
        seatHtml(gd, data, opts.roster) + '<div class="gs-notice" role="status"><span>Attendance starts after the raid.</span></div>' +
        signupsPanelHtml(gd, data, opts.signups) + rosterCardHtml(gd, data, opts.roster) + boardCardHtml(gd, data, opts.board) + settingsCardHtml(gd, data) + '</div>';
    }
    let people_html;
    if (people === null) {
      people_html = '<p class="gs-empty">Attendance for this raid is visible to the team\'s members.</p>';
    } else if (!people.length) {
      people_html = '<p class="gs-empty">' + (hasReports(data) || isManual(data) ? 'No one is on this raid yet.' : 'Awaiting log. Add a Warcraft Logs report, or mark the raid as No log and enter attendance by hand.') + '</p>';
    } else {
      const anyFlag = people.some(needsReview);
      const filter = opts.filter || (anyFlag ? 'review' : 'all');
      const shown = sortedPeople(filter === 'review' ? people.filter(needsReview) : people);
      people_html = peopleToolbarHtml(people, filter) +
        (shown.length ? peopleTableHtml(gid, data, shown, opts.signups) : '<p class="gs-empty">Nothing needs review on this raid.</p>');
    }
    return '<div class="gs-page gs-raid-page">' + headHtml(gd, data, opts) + G.pages.review.noteHtml(opts.note) + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      A().staleBannerHtml(data.raid.stale ? 1 : 0, edit, opts.progress).replace('data-action="att-recalc"', 'data-action="raid-op" data-op="recompute"') +
      manualLineHtml(data, edit) + sourceStripHtml(data, edit, false) +
      '<section class="gs-card-sec" aria-labelledby="ppl-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="ppl-h">People</h2></div><div class="gs-card-sec-body">' + people_html + '</div></section>' +
      signupsPanelHtml(gd, data, opts.signups) + rosterCardHtml(gd, data, opts.roster) + boardCardHtml(gd, data, opts.board) + lootCardHtml(gd, data, opts.loot) + unmatchedBlockHtml(data) + settingsCardHtml(gd, data) + '</div>';
  }

  // ── dialogs ──
  function sourceDialogHtml(o) {
    return '<form class="gs-dialog-form" data-submit="' + o.submit + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + esc(o.title) + '</h2>' + (o.help ? '<p class="gs-fine" id="dlg-help">' + esc(o.help) + '</p>' : '') +
      '<div class="gs-field"><label class="gs-label" for="dlg-source">' + esc(o.label) + '</label>' + (o.multiline
        ? '<textarea class="gs-input gs-textarea" id="dlg-source" name="source" rows="3" data-field="source" autocomplete="off"></textarea>'
        : '<input class="gs-input" type="text" id="dlg-source" name="source" data-field="source" autocomplete="off">') +
      '<p class="gs-field-error" id="dlg-err-source" role="alert" hidden></p></div>' +
      '<input type="hidden" name="confirm" value="">' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="dlg-submit">' + esc(o.button) + '</button></div></form>';
  }

  function confirmDialogHtml(o) {
    return '<form class="gs-dialog-form" data-submit="raid-confirm-form" data-op="' + esc(o.op) + '"' + (o.code ? ' data-code="' + esc(o.code) + '"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + esc(o.title) + '</h2><p class="gs-confirm-text" id="dlg-text">' + esc(o.text) + '</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn ' + (o.danger ? 'gs-btn-danger' : 'gs-btn-molten') + '">' + esc(o.button) + '</button></div></form>';
  }

  // Candidates for the manual dialog: this raid's people (sign-ups, plan), the team roster, and, found by search, anyone else.
  // rosters: [{ teamId, people: [GET /roster rows] }]. ticked: ids already present.
  function manualCandidates(data, rosters, ticked) {
    const byId = {};
    const order = [];
    function put(id, name, cls, tags, extra) {
      if (!id) return;
      if (!byId[id]) { byId[id] = { id: id, name: name, class: cls, tags: [], extra: !!extra }; order.push(id); }
      const c = byId[id];
      if (!extra) c.extra = false;
      (tags || []).forEach(function (t) { if (t && c.tags.indexOf(t) < 0) c.tags.push(t); });
    }
    (Array.isArray(data.people) ? data.people : []).forEach(function (p) {
      const tags = [];
      if (p.signup) tags.push(A().KIND_LABELS[p.signup] || p.signup);
      if (p.plan) tags.push(p.plan === 'bench' ? 'Plan: bench' : 'Plan: ' + p.plan);
      put(p.playerId, p.name, p.class, tags, false);
    });
    const teamId = idOf(data.raid.team);
    (rosters || []).forEach(function (r) {
      (Array.isArray(r.people) ? r.people : []).forEach(function (p) {
        const main = p.main || p.shown || {};
        if (p.status === 'inactive' && r.teamId === teamId) return;
        put(p.id, main.name, main.class, [], r.teamId !== teamId);
      });
    });
    return order.map(function (id) { byId[id].ticked = !!ticked[id]; return byId[id]; }).sort(function (x, y) {
      return (x.extra ? 1 : 0) - (y.extra ? 1 : 0) || (y.tags.length ? 1 : 0) - (x.tags.length ? 1 : 0) || String(x.name).localeCompare(String(y.name), 'en');
    });
  }

  function manualTicked(data) {
    const m = data.raid && data.raid.manual;
    const ids = {};
    if (m && Array.isArray(m.presentPlayerIds)) { m.presentPlayerIds.forEach(function (id) { ids[id] = true; }); return ids; }
    if (isManual(data)) (Array.isArray(data.people) ? data.people : []).forEach(function (p) { if (OK_MANUAL.indexOf(p.outcome) >= 0) ids[p.playerId] = true; });
    return ids;
  }

  // opts: { data, candidates, reason, edit }
  function manualDialogHtml(opts) {
    const r = opts.data.raid;
    const list = opts.candidates.map(function (c) {
      return '<li class="gs-pick-item' + (c.extra ? ' is-extra' : '') + '" data-name="' + esc(String(c.name).toLowerCase()) + '"' + (c.extra ? ' hidden' : '') + '><div class="gs-check"><input type="checkbox" name="present" id="mp-' + esc(c.id) + '" value="' + esc(c.id) + '"' + (c.ticked ? ' checked' : '') + '><label for="mp-' + esc(c.id) + '">' +
        G.ui.classNameHtml(c.name, c.class) + c.tags.map(function (t) { return ' <span class="gs-chip gs-chip-signup">' + esc(t) + '</span>'; }).join('') + '</label></div></li>';
    }).join('');
    return '<form class="gs-dialog-form gs-dialog-wide" data-submit="manual-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + (opts.edit ? 'Edit' : 'Enter') + ' attendance by hand</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(G.ui.weekdayDay(r.raidOn)) + '. Tick everyone who was present. Everyone not ticked is handled as if absent from a log: signed up and not ticked is Missed, Bench stays Bench, Absence stays Missed with notice.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-reason">Reason there is no log (required)</label><input class="gs-input" type="text" id="dlg-reason" name="reason" maxlength="' + REASON_MAX + '" autocomplete="off" data-field="reason" value="' + esc(opts.reason || '') + '">' +
      '<p class="gs-field-error" id="dlg-err-reason" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="mp-search">Find a person</label><input class="gs-input" type="search" id="mp-search" data-input="manual-search" autocomplete="off" placeholder="Search to add someone from another team"></div>' +
      '<ul class="gs-pick-list" aria-label="People">' + (list || '<li class="gs-fine">No one to list yet.</li>') + '</ul>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save attendance</button></div></form>';
  }

  function manualRemoveDialogHtml() {
    return '<form class="gs-dialog-form" data-submit="manual-remove-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Remove the hand-entered attendance</h2><p class="gs-fine" id="dlg-help">The raid goes back to Awaiting log. Decisions stay on file.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-reason">Reason (required)</label><input class="gs-input" type="text" id="dlg-reason" name="reason" maxlength="' + REASON_MAX + '" autocomplete="off" data-field="reason"><p class="gs-field-error" id="dlg-err-reason" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove</button></div></form>';
  }

  // ── data ──
  function setDetail(c, res, note) {
    G.app.applyFlags(c.gid, res);
    if (res && res.raid && res.sources) c.x.data = res;
    a().note = note || '';
    st().pageAlert = '';
    if (G.pages.raidRoster) G.pages.raidRoster.invalidate(); // a new plan: the roster is read again after the draw ("The plan changed since you published")
    G.app.render();
    // The event, the plan or the results changed: the sign-ups panel reads its list again.
    if (G.pages.raidSignups && res && res.raid) {
      G.pages.raidSignups.loadFor(c.gd, res).then(function () { G.app.render(); }, pageError);
    }
  }

  function fetchDetail(gid, rid) {
    return G.api.get(raidBase(gid, rid)).then(function (data) {
      a().raid = { gid: gid, rid: rid, data: data, filter: a().raid && a().raid.rid === rid ? a().raid.filter : null, auto: a().openManual === rid };
      if (a().openManual === rid) a().openManual = null;
      return data;
    });
  }

  function load(r, gd) {
    a().note = '';
    return fetchDetail(gd.guild.id, r.rid).then(function (data) {
      const signups = G.pages.raidSignups ? G.pages.raidSignups.loadFor(gd, data) : Promise.resolve(null);
      return signups.then(function () { return G.pages.raidLoot ? G.pages.raidLoot.loadFor(gd, data) : null; }).then(function () { return G.pages.raidBoard ? G.pages.raidBoard.loadFor(gd, data) : null; });
    }).then(function () { return null; });
  }

  function reload() {
    const gd = currentGd();
    const x = a().raid;
    if (!gd || !x) return Promise.resolve();
    return fetchDetail(gd.guild.id, x.rid).then(function () { G.app.render(); }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  function main(r, gd) {
    const x = a().raid;
    if (!x || x.gid !== gd.guild.id || x.rid !== r.rid) return G.pages.signin.loadingHtml();
    return raidHtml({ guildData: gd, data: x.data, filter: x.filter, alert: st().pageAlert, note: a().note, progress: a().recalc, loot: G.pages.raidLoot ? G.pages.raidLoot.stateFor(gd.guild.id, r.rid) : null, board: G.pages.raidBoard ? G.pages.raidBoard.stateFor(gd.guild.id, r.rid) : null, signups: G.pages.raidSignups ? G.pages.raidSignups.stateFor(gd.guild.id, r.rid) : null, roster: G.pages.raidRoster ? G.pages.raidRoster.stateFor(gd.guild.id, r.rid) : null });
  }

  function openManualDialog(c) {
    const data = c.data;
    const teams = G.shell.activeTeams(c.gd.teams);
    Promise.all(teams.map(function (t) {
      return G.api.get(A().apiBase(c.gid) + '/roster?team=' + encodeURIComponent(t.id)).then(function (res) { return { teamId: t.id, people: res && res.people }; }, function () { return { teamId: t.id, people: [] }; });
    })).then(function (rosters) {
      const m = data.raid.manual || {};
      G.ui.openDialog(manualDialogHtml({ data: data, candidates: manualCandidates(data, rosters, manualTicked(data)), reason: m.reason || '', edit: isManual(data) }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const input = document.getElementById('dlg-reason');
      if (input) input.focus();
    });
  }

  // Called by the app after each render: the New raid page asks for the manual dialog to open on the new raid.
  function afterRender() {
    const x = a().raid;
    if (!x || !x.auto) return;
    const c = cur();
    if (!c || typeof document === 'undefined' || !document.getElementById('guild-dialogs')) return;
    x.auto = false;
    openManualDialog(c);
  }

  // ── operations ──
  function pageError(err) { G.app.handleError(err, { pageAlert: true }); }

  // A cancelled move question (see G.pages.raids.putEvent) changes nothing: the button just comes back.
  function runDirect(el, promise, c) {
    if (el) el.disabled = true;
    return promise.then(function (res) {
      if (res === G.pages.raids.MOVE_CANCELLED) { if (el) el.disabled = false; return; }
      setDetail(c, res);
    }, function (err) { if (el) el.disabled = false; pageError(err); });
  }

  G.handlers.click['raid-filter'] = function (el) {
    const c = cur();
    if (!c) return;
    c.x.filter = el.getAttribute('data-filter');
    G.app.render();
  };

  G.handlers.click['raid-op'] = function (el) {
    const c = cur();
    if (!c) return;
    const op = el.getAttribute('data-op');
    const code = el.getAttribute('data-code');
    const base = raidBase(c.gid, c.rid);
    const ev = c.data.sources && c.data.sources.event;
    switch (op) {
      case 'recompute': runDirect(el, G.api.post(base + '/recompute', {}), c); break;
      case 'event-refresh': if (ev) runDirect(el, G.pages.raids.putEvent(c.gid, c.rid, ev.id, ev.otherServer), c); break;
      case 'plan-in-planner':
        el.disabled = true;
        G.pages.raids.planInPlanner(c.gid, c.rid, isUpcoming(c.data) ? ev : null).then(function (opened) { if (!opened) el.disabled = false; }, function (err) { el.disabled = false; pageError(err); });
        break;
      case 'report-refresh': runDirect(el, G.api.put(base + '/reports', { source: code }), c); break;
      case 'event-replace':
        G.ui.openDialog(sourceDialogHtml({ submit: 'event-form', title: ev ? 'Replace the Raid-Helper event' : 'Link a Raid-Helper event', label: 'Event link or ID', button: ev ? 'Replace event' : 'Link event', help: 'The sign-ups are read from the event. Decisions already made are kept.' }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        focusSource();
        break;
      case 'report-add':
        G.ui.openDialog(sourceDialogHtml({ submit: 'report-form', title: 'Add a Warcraft Logs report', label: 'Report link or code', button: 'Add report', help: 'Only who was present in each boss pull is kept, never the report.' }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        focusSource();
        break;
      case 'plan-replace':
        G.ui.openDialog(sourceDialogHtml({ submit: 'plan-form', title: c.data.sources && c.data.sources.plan ? 'Replace the plan' : 'Link a plan', label: 'Plan link or share code', button: 'Save plan', multiline: true, help: 'Paste a Raidsmith plan link or share code. Only names and groups are sent to Raidsmith; the link itself is not kept.' }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        focusSource();
        break;
      case 'event-remove':
        G.ui.openDialog(confirmDialogHtml({ op: op, title: 'Remove the Raid-Helper event?', text: 'Its sign-ups are removed from this raid and the attendance is recalculated. Decisions are kept.', button: 'Remove event', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'report-remove':
        G.ui.openDialog(confirmDialogHtml({ op: op, code: code, title: 'Remove this report?', text: 'Its boss pulls and who was present are removed from this raid and the attendance is recalculated.', button: 'Remove report', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'plan-remove':
        G.ui.openDialog(confirmDialogHtml({ op: op, title: 'Remove the plan?', text: 'Plan placements stop counting as sign-ups on this raid.', button: 'Remove plan', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'raid-delete':
        G.ui.openDialog(confirmDialogHtml({ op: op, title: 'Delete this raid?', text: 'Removes the raid with its sign-ups, presence, plan and attendance, including decisions. This cannot be undone.', button: 'Delete raid', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'manual-open':
      case 'manual-edit': openManualDialog(c); break;
      case 'manual-remove':
        G.ui.openDialog(manualRemoveDialogHtml(), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        break;
      default: break;
    }
  };

  function focusSource() {
    const input = typeof document !== 'undefined' ? document.getElementById('dlg-source') : null;
    if (input) input.focus();
  }

  // The deadline's mode select shows the hours box only for "Set for this raid" (in place: a re-render could swallow the click on Save).
  G.handlers.change['rs-hours-mode'] = function (el) {
    if (typeof document === 'undefined') return;
    const custom = el.value === 'custom';
    const field = document.getElementById('rs-hours-field');
    if (field) field.hidden = !custom;
    const input = document.getElementById('rs-hours');
    if (custom && input) input.focus();
  };

  // Raid settings: only what changed is sent (a key left out is kept by the Worker, so two officers changing different settings do not undo each other);
  // Automatic and Team default send null, which clears the raid's own value.
  G.handlers.submit['raid-settings-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const r = c.data.raid;
    ['rs-err-size', 'rs-err-hours', 'rs-error'].forEach(function (id) { G.ui.setText(id, ''); });
    const body = {};
    const size = form.elements.size.value === '' ? null : Number(form.elements.size.value);
    if (size !== null && G.ui.RAID_SIZES.indexOf(size) < 0) { G.ui.setText('rs-err-size', 'Choose Automatic or one of the sizes.'); form.elements.size.focus(); return; }
    if (size !== (r.sizeOverride == null ? null : r.sizeOverride)) body.size = size;
    if (form.elements.hoursMode) {
      let hours = null;
      if (form.elements.hoursMode.value === 'custom') {
        const text = String(form.elements.hours.value == null ? '' : form.elements.hours.value).trim();
        if (!/^\d{1,2}$/.test(text) || Number(text) > MAX_CLOSE_HOURS) { G.ui.setText('rs-err-hours', 'Enter whole hours from 0 to ' + MAX_CLOSE_HOURS + '.'); form.elements.hours.focus(); return; }
        hours = Number(text);
      }
      if (hours !== (r.closeHoursOverride == null ? null : r.closeHoursOverride)) body.signupCloseHours = hours;
    }
    if (!Object.keys(body).length) { G.ui.setText('rs-error', 'Nothing to save: the settings are already as shown.'); return; }
    G.ui.setBusy(form, true);
    G.api.patch(raidBase(c.gid, c.rid), body).then(function (res) {
      setDetail(c, res, 'Raid settings saved.');
    }, function (err) {
      G.ui.setBusy(form, false);
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      if (err && err.code === 'conflict') { G.app.handleError(err); return; }
      const sink = err && err.field === 'size' ? 'rs-err-size' : err && err.field === 'signupCloseHours' ? 'rs-err-hours' : 'rs-error';
      G.ui.setText(sink, cl.text);
      const input = sink === 'rs-err-size' ? form.elements.size : sink === 'rs-err-hours' ? (form.elements.hours || form.elements.hoursMode) : null;
      if (input && input.focus) input.focus();
    });
  };

  G.handlers.submit['raid-confirm-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const op = form.getAttribute('data-op');
    const base = raidBase(c.gid, c.rid);
    let promise;
    if (op === 'event-remove') promise = G.api.del(base + '/event', {});
    else if (op === 'report-remove') promise = G.api.del(base + '/reports/' + encodeURIComponent(form.getAttribute('data-code')), {});
    else if (op === 'plan-remove') promise = G.api.del(base + '/plan', {});
    else if (op === 'raid-delete') {
      G.ui.runDialog(form, G.api.del(base, {}), function (res) {
        G.app.applyFlags(c.gid, res);
        a().raid = null;
        a().raids = null;
        G.app.go(G.router.format({ name: 'section', gid: c.gid, section: 'raids' }));
      });
      return;
    } else return;
    G.ui.runDialog(form, promise, function (res) { setDetail(c, res); });
  };

  // The dialogs that take one source string. A second try after other_server / report_not_same_night confirms it.
  function sourceSubmit(form, build) {
    const c = cur();
    if (!c) return;
    const src = String(form.elements.source.value || '').trim();
    G.ui.setText('dlg-err-source', '');
    G.ui.setText('dlg-error', '');
    if (!src) { G.ui.setText('dlg-err-source', 'Enter a link or code.'); form.elements.source.focus(); return; }
    const confirmed = form.elements.confirm.value === '1';
    const call = build(c, src, confirmed);
    if (!call) return;
    G.ui.setBusy(form, true);
    call.then(function (res) {
      if (res === G.pages.raids.MOVE_CANCELLED) { G.ui.setBusy(form, false); return; } // the officer said no to moving the raid: the dialog stays open
      G.ui.closeDialogOf(form);
      setDetail(c, res);
    }, function (err) {
      G.ui.setBusy(form, false);
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.ui.closeDialogOf(form); G.app.showFailure(cl.title, cl.text); return; }
      G.ui.setText('dlg-error', cl.text);
      if (err && (err.code === 'other_server' || err.code === 'report_not_same_night')) {
        form.elements.confirm.value = '1';
        const b = document.getElementById('dlg-submit');
        if (b) b.textContent = err.code === 'other_server' ? 'Import anyway' : 'Add anyway';
      }
    });
  }

  G.handlers.submit['event-form'] = function (form) {
    sourceSubmit(form, function (c, src, confirmed) {
      return G.pages.raids.putEvent(c.gid, c.rid, src, confirmed);
    });
  };

  G.handlers.submit['report-form'] = function (form) {
    sourceSubmit(form, function (c, src, confirmed) {
      return G.api.put(raidBase(c.gid, c.rid) + '/reports', confirmed ? { source: src, confirmFar: true } : { source: src });
    });
  };

  G.handlers.submit['plan-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const text = String(form.elements.source.value || '').trim();
    G.ui.setText('dlg-err-source', '');
    G.ui.setText('dlg-error', '');
    if (!text) { G.ui.setText('dlg-err-source', 'Paste a plan link or share code.'); form.elements.source.focus(); return; }
    G.ui.setBusy(form, true);
    G.planSource.read(text, {}).then(function (read) {
      if (!read.ok) { G.ui.setBusy(form, false); G.ui.setText('dlg-err-source', read.error); form.elements.source.focus(); return null; }
      return G.api.put(raidBase(c.gid, c.rid) + '/plan', { label: read.label, players: read.players, live: read.live }).then(function (res) {
        G.ui.closeDialogOf(form);
        setDetail(c, res, read.skippedText);
      }, function (err) {
        const planText = G.planSource.describeError(err, read.players);
        if (planText) { const e = new Error(planText); e.planText = planText; throw e; }
        throw err;
      });
    }).catch(function (err) {
      G.ui.setBusy(form, false);
      G.ui.setText('dlg-error', err && err.planText ? err.planText : G.api.classify(err).text);
    });
  };

  G.handlers.submit['manual-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const reason = String(form.elements.reason.value || '').trim();
    const ids = Array.prototype.map.call(form.querySelectorAll('input[name="present"]:checked'), function (i) { return i.value; });
    G.ui.setText('dlg-err-reason', '');
    G.ui.setText('dlg-error', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) { G.ui.setText('dlg-err-reason', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.'); form.elements.reason.focus(); return; }
    if (ids.length > MAX_PRESENT) { G.ui.setText('dlg-error', 'At most ' + MAX_PRESENT + ' people can be ticked.'); return; }
    G.ui.runDialog(form, G.api.put(raidBase(c.gid, c.rid) + '/manual', { reason: reason, presentPlayerIds: ids }), function (res) { setDetail(c, res); });
  };

  G.handlers.submit['manual-remove-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const reason = String(form.elements.reason.value || '').trim();
    G.ui.setText('dlg-err-reason', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) { G.ui.setText('dlg-err-reason', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.'); form.elements.reason.focus(); return; }
    G.ui.runDialog(form, G.api.del(raidBase(c.gid, c.rid) + '/manual', { reason: reason }), function (res) { setDetail(c, res); });
  };

  // Search in the manual dialog: filters the list by name; people from other teams show only while the query matches.
  G.handlers.input['manual-search'] = function (el) {
    const q = String(el.value || '').trim().toLowerCase();
    const items = el.closest('form').querySelectorAll('.gs-pick-item');
    for (let i = 0; i < items.length; i++) {
      const extra = items[i].classList.contains('is-extra');
      const hit = !q || items[i].getAttribute('data-name').indexOf(q) >= 0;
      items[i].hidden = extra ? (!q || !hit) : !hit;
    }
  };

  G.pages.raid = {
    raidHtml: raidHtml,
    settingsCardHtml: settingsCardHtml,
    manualDialogHtml: manualDialogHtml,
    manualCandidates: manualCandidates,
    manualTicked: manualTicked,
    sourceDialogHtml: sourceDialogHtml,
    confirmDialogHtml: confirmDialogHtml,
    sortedPeople: sortedPeople,
    needsReview: needsReview,
    reload: reload,
    afterRender: afterRender,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
