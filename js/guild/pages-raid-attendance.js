// ── PAGE PIECE: THE ATTENDANCE BOARD OF A FINISHED RAID ─────────
// Raids revamp lane 3b (design-spec 2, 4, 5). The "Attendance" Forge panel of a past raid and the "Unmatched characters" panel under it. It keeps the id
// raid-people (the next-step bar's Review attendance filters the panel and scrolls to it) and reuses the people board of lane 3a (pages-raid-signups.js, CSS gs-rb-).
//   Head      "Attendance", "25 attended", then Needs review N / Everyone N (today's default: Needs review while anything is flagged, else Everyone).
//   Everyone  Tanks / Healers / Melee / Ranged columns (gold group heads with counts) of everyone who counts as there (Attended, Late, Left early, Late + left, Bench,
//             Other team), A-Z, with a grey chip for a non-default outcome and a rose "Needs review" chip on a flagged row. Under them one line per other group: No role,
//             Missed (with "(with notice)" per name), Not counted (no sign-up), and a line of its own for any other outcome. Every person appears exactly once.
//   Names     a reviewer's name is a button (Decide on a flagged row, Change outcome on the others, the dialogs of pages-review.js); with attendance.view only a link to the
//             person's attendance page; otherwise plain. The viewer's row is tinted and tagged "You".
//   Review    a short list instead of the columns: spec icon, name, the provisional outcome, the evidence and a Decide button.
// The people rows are the raid detail's `people` (worker/attendance-view.js, with `role`). No pull bars here: the Decide dialog keeps "In 8 of 12 pulls".
(function (G) {
  'use strict';

  const ROLES = ['tank', 'healer', 'melee', 'ranged'];
  const ROLE_LABELS = { tank: 'Tanks', healer: 'Healers', melee: 'Melee', ranged: 'Ranged' };
  // Outcomes that sit in the role columns, and the grey chip each non-default one carries.
  const COLUMN_OUTCOMES = ['present', 'fill_in', 'late', 'left_early', 'late_left', 'bench'];
  const CHIP_WORDS = { late: 'Late', left_early: 'Left early', late_left: 'Late + left', bench: 'Bench' };
  const LINE_ORDER = ['missed', 'no_signup'];

  function A() { return G.pages.attendance; }
  function R() { return G.pages.review; }
  function P() { return G.pages.raid; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function chip(tone, label) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(label) + '</span>'; }

  function byName(x, y) { return String(x.name).localeCompare(String(y.name), 'en') || String(x.playerId).localeCompare(String(y.playerId)); }
  function needsReview(row) { return P().needsReview(row); }

  // ── what a row shows ──
  function signupRowOf(data) {
    const m = {};
    (Array.isArray(data.signups) ? data.signups : []).forEach(function (s) { if (s && s.playerId && !m[s.playerId]) m[s.playerId] = s; });
    return m;
  }

  // The spec each person signed up with: the Sign-ups panel's list has it normalised ("Protection" for Raid-Helper's "Protection1"), else the raid's own sign-up row
  // (only when it names the same class: Late / Bench / Absence rows carry a meta class instead).
  function specTextOf(row, bySignupList, signupRows) {
    if (bySignupList[row.playerId]) return bySignupList[row.playerId];
    const s = signupRows[row.playerId];
    if (s && s.specName && row.class && String(s.className || '').toUpperCase() === String(row.class).toUpperCase()) return String(s.specName).replace(/\d+$/, '');
    return '';
  }

  function specsOfList(signupState) {
    const view = signupState && signupState.status === 'ok' ? signupState.data : null;
    const out = {};
    (view && Array.isArray(view.entries) ? view.entries : []).forEach(function (e) { if (e && e.personId && e.spec && !out[e.personId]) out[e.personId] = e.spec; });
    return out;
  }

  function outcomeWord(outcome) {
    const labels = A().OUTCOME_LABELS;
    return Object.prototype.hasOwnProperty.call(labels, outcome) ? labels[outcome] : String(outcome == null || outcome === '' ? 'No outcome' : outcome);
  }

  // "In 3 of 12 pulls, missed the first pull" / "Signed up, not in the log".
  function evidenceOf(row) {
    const p = row.pulls || {};
    if (p.total > 0 && p.present > 0) {
      return 'In ' + p.present + ' of ' + plural(p.total, 'pull', 'pulls') + (p.missedFirst ? ', missed the first pull' : '') + (p.missedLast ? ', missed the last pull' : '');
    }
    if (p.total > 0) return 'In 0 of ' + plural(p.total, 'pull', 'pulls') + (row.signup ? ', signed up' : '');
    return row.signup ? 'Signed up, not in the log' : 'Not in the log';
  }

  // ── a name ──
  function nameHtml(ctx, row) {
    const decide = ctx.review && row.outcome;
    if (decide) {
      const flagged = needsReview(row);
      return '<button type="button" class="gs-rb-id gs-rb-btn" data-action="decide-open" data-rid="' + esc(ctx.rid) + '" data-pid="' + esc(row.playerId) + '" data-where="raid" data-key="decide-' + esc(row.playerId) + '"' +
        ' aria-label="' + esc((flagged ? 'Decide for ' : 'Change outcome for ') + row.name) + '">' + ctx.textHtml(row, G.ui.classNameHtml(row.name, row.class)) + '</button>';
    }
    if (ctx.see) {
      const link = '<a class="gs-char-link ' + G.ui.classClass(row.class) + '" href="' + esc(G.router.format({ name: 'personatt', gid: ctx.gid, pid: row.playerId })) + '">' + esc(row.name) + '</a>';
      return '<span class="gs-rb-id">' + ctx.textHtml(row, link) + '</span>';
    }
    return '<span class="gs-rb-id">' + ctx.textHtml(row, G.ui.classNameHtml(row.name, row.class)) + '</span>';
  }

  function textHtmlOf(ctx) {
    return function (row, nameMarkup) {
      const spec = specTextOf(row, ctx.specs, ctx.signupRows);
      return '<span class="gs-rb-nm">' + nameMarkup + '</span>' + (spec ? '<span class="gs-rb-sp">' + esc(spec) + '</span>' : '');
    };
  }

  function iconHtml(ctx, row) { return row.class ? G.ui.specIconHtml(row.class, specTextOf(row, ctx.specs, ctx.signupRows), 20) : ''; }
  function youHtml(ctx, row) { return ctx.me && ctx.me === row.playerId ? '<span class="gs-you">You</span>' : ''; }

  // ── the columns ──
  function rowHtml(ctx, row) {
    const chips = (CHIP_WORDS[row.outcome] ? '<span class="gs-hd-chip is-grey">' + esc(CHIP_WORDS[row.outcome]) + '</span>' : '') + (needsReview(row) ? chip('rose', 'Needs review') : '');
    return '<li class="gs-rb-row' + (ctx.me && ctx.me === row.playerId ? ' is-you' : '') + '" data-pid="' + esc(row.playerId) + '">' + iconHtml(ctx, row) + nameHtml(ctx, row) +
      (chips ? '<span class="gs-rb-chips">' + chips + '</span>' : '') + youHtml(ctx, row) + '</li>';
  }

  function headHtml(title, count, tag) { return G.pages.raidSignups.groupHeadHtml(title, count, tag); }

  function columnHtml(ctx, role, list) {
    return '<section class="gs-rb-col" aria-label="' + esc(ROLE_LABELS[role]) + '">' + headHtml(ROLE_LABELS[role], list.length, 'h3') +
      '<ul class="gs-rb-list">' + list.map(function (r) { return rowHtml(ctx, r); }).join('') + '</ul></section>';
  }

  // A group of names under the columns: a gold head with its count and the names in a row ("(with notice)" per name is muted text).
  function lineNameHtml(ctx, row) {
    const decide = ctx.review && row.outcome;
    const name = G.ui.classNameHtml(row.name, row.class);
    let inner;
    if (decide) {
      inner = '<button type="button" class="gs-rb-btn gs-rb-lbtn" data-action="decide-open" data-rid="' + esc(ctx.rid) + '" data-pid="' + esc(row.playerId) + '" data-where="raid" data-key="decide-' + esc(row.playerId) + '"' +
        ' aria-label="' + esc((needsReview(row) ? 'Decide for ' : 'Change outcome for ') + row.name) + '">' + name + '</button>';
    } else if (ctx.see) {
      inner = '<a class="gs-char-link ' + G.ui.classClass(row.class) + '" href="' + esc(G.router.format({ name: 'personatt', gid: ctx.gid, pid: row.playerId })) + '">' + esc(row.name) + '</a>';
    } else inner = name;
    return '<li' + (ctx.me && ctx.me === row.playerId ? ' class="is-you"' : '') + '>' + inner + (row.outcome === 'missed_notice' ? ' <span class="gs-rb-mut">(with notice)</span>' : '') +
      (needsReview(row) ? ' ' + chip('rose', 'Needs review') : '') + youHtml(ctx, row) + '</li>';
  }

  function lineHtml(ctx, title, list) {
    return '<div class="gs-rb-line">' + headHtml(title, list.length, 'h3') + '<ul class="gs-rb-names">' + list.map(function (r) { return lineNameHtml(ctx, r); }).join('') + '</ul></div>';
  }

  // Missed and Missed with notice share a line, Not counted is no sign-up, every other outcome (Tentative, anything new) gets a line with today's label.
  function extraLines(ctx, rows) {
    const groups = [];
    const place = function (key, title, row) {
      let g = groups.filter(function (x) { return x.key === key; })[0];
      if (!g) { g = { key: key, title: title, list: [] }; groups.push(g); }
      g.list.push(row);
    };
    rows.forEach(function (row) {
      const o = row.outcome;
      if (COLUMN_OUTCOMES.indexOf(o) >= 0 && ROLES.indexOf(row.role) >= 0) return;
      if (COLUMN_OUTCOMES.indexOf(o) >= 0) place('norole', 'No role', row);
      else if (o === 'missed' || o === 'missed_notice') place('missed', 'Missed', row);
      else if (o === 'no_signup') place('no_signup', 'Not counted', row);
      else place('o:' + o, outcomeWord(o), row);
    });
    const rank = function (g) { return g.key === 'norole' ? 0 : g.key === 'missed' ? 1 : g.key === 'no_signup' ? 2 : 3; };
    groups.sort(function (x, y) { return rank(x) - rank(y); });
    return groups.map(function (g) { return lineHtml(ctx, g.title, g.list.sort(byName)); }).join('');
  }

  function everyoneHtml(ctx, rows) {
    const inColumns = rows.filter(function (r) { return COLUMN_OUTCOMES.indexOf(r.outcome) >= 0; });
    const cols = ROLES.map(function (role) {
      return columnHtml(ctx, role, inColumns.filter(function (r) { return r.role === role; }).sort(byName));
    }).join('');
    return '<div class="gs-rb-cols">' + cols + '</div>' + extraLines(ctx, rows);
  }

  // ── Needs review ──
  function reviewRowHtml(ctx, row) {
    const decideBtn = ctx.review && row.outcome
      ? '<button type="button" class="gs-btn gs-btn-sm gs-rba-decide" data-action="decide-open" data-rid="' + esc(ctx.rid) + '" data-pid="' + esc(row.playerId) + '" data-where="raid" data-key="decide-btn-' + esc(row.playerId) + '"' +
        ' aria-label="' + esc('Decide for ' + row.name) + '">Decide</button>'
      : '';
    return '<li class="gs-rb-row gs-rba-rev' + (ctx.me && ctx.me === row.playerId ? ' is-you' : '') + '" data-pid="' + esc(row.playerId) + '">' + iconHtml(ctx, row) + nameHtml(ctx, row) +
      '<span class="gs-rb-chips"><span class="gs-hd-chip is-grey">' + esc(outcomeWord(row.outcome)) + '</span></span><span class="gs-rb-sp gs-rba-ev">' + esc(evidenceOf(row)) + '</span>' +
      youHtml(ctx, row) + decideBtn + '</li>';
  }

  function reviewListHtml(ctx, flagged) {
    if (!flagged.length) return '<p class="gs-empty">Nothing needs review on this raid.</p>';
    return '<ul class="gs-rb-list gs-rba-list" aria-label="Needs review">' + flagged.map(function (r) { return reviewRowHtml(ctx, r); }).join('') + '</ul>';
  }

  // ── the panel ──
  function segHtml(filter, flagged, everyone) {
    return '<div class="gs-segs gs-rba-segs" role="group" aria-label="Show"><button type="button" class="gs-seg" data-action="raid-filter" data-filter="review" data-key="rf-review" aria-pressed="' + (filter === 'review' ? 'true' : 'false') + '">Needs review <span class="gs-seg-count">' + flagged + '</span></button>' +
      '<button type="button" class="gs-seg" data-action="raid-filter" data-filter="all" data-key="rf-all" aria-pressed="' + (filter === 'all' ? 'true' : 'false') + '">Everyone <span class="gs-seg-count">' + everyone + '</span></button></div>';
  }

  function panelShell(headExtra, bodyHtml) {
    return '<section class="gs-hd-panel gs-rb gs-rba" id="raid-people" tabindex="-1" aria-labelledby="rba-h"><div class="gs-rb-ph"><h2 class="gs-pr-h" id="rba-h">Attendance</h2>' + headExtra + '</div><div class="gs-rb-pb">' + bodyHtml + '</div></section>';
  }

  // o: { guildData, data (raid detail), filter, signups (the Sign-ups panel's state), summary (a muted bosses / pulls line, optional) }
  function panelHtml(o) {
    const data = o.data;
    const gid = o.guildData.guild.id;
    const people = Array.isArray(data.people) ? data.people : null;
    if (people === null) return panelShell('', '<p class="gs-empty">Attendance for this raid is visible to the team\'s members.</p>');
    const hasLog = !!(data.sources && Array.isArray(data.sources.reports) && data.sources.reports.length) || !!(data.raid && (data.raid.state === 'manual' || data.raid.manual));
    if (!people.length) {
      return panelShell('', '<p class="gs-empty">' + (hasLog ? 'No one is on this raid yet.' : 'Awaiting log. Add a Warcraft Logs report, or mark the raid as No log and enter attendance by hand.') + '</p>');
    }
    const everyone = people.filter(P().onRosterThatDay);
    const hidden = people.length - everyone.length;
    const flaggedAll = people.filter(needsReview);
    const filter = o.filter || (flaggedAll.length ? 'review' : 'all');
    const signupView = o.signups && o.signups.status === 'ok' && o.signups.data ? o.signups.data : null;
    const ctx = {
      gid: gid, rid: data.raid.id, review: !!(data.can && data.can.review), see: !!(data.can && data.can.seeAttendance),
      me: signupView && signupView.me ? signupView.me.personId : null,
      specs: specsOfList(o.signups), signupRows: signupRowOf(data),
    };
    ctx.textHtml = textHtmlOf(ctx);
    const attended = everyone.filter(function (p) { return p.outcome === 'present' || p.outcome === 'fill_in'; }).length;
    const head = '<span class="gs-rb-fig">' + attended + ' <span class="gs-rb-of">attended</span></span>' + (o.summary ? '<span class="gs-rb-mut">' + esc(o.summary) + '</span>' : '') +
      '<span class="gs-rb-acts">' + segHtml(filter, flaggedAll.length, everyone.length) + '</span>';
    let body;
    if (filter === 'review') body = reviewListHtml(ctx, flaggedAll.slice().sort(byName));
    else {
      body = everyoneHtml(ctx, everyone) +
        (hidden > 0 ? '<p class="gs-fine" id="raid-later-note">' + esc(hidden === 1 ? '1 person who joined' : hidden + ' people who joined') + ' the guild after this raid ' + (hidden === 1 ? 'is' : 'are') + ' not listed.</p>' : '');
    }
    return panelShell(head, body);
  }

  // ── Unmatched characters ──
  function unmatchedHtml(data) {
    const list = Array.isArray(data.unmatched) ? data.unmatched : [];
    if (!list.length) return '';
    const review = !!(data.can && data.can.review);
    return '<section class="gs-hd-panel gs-rb gs-rba-unm" aria-labelledby="unm-h"><div class="gs-rb-ph"><h2 class="gs-pr-h" id="unm-h">Unmatched characters</h2></div><div class="gs-rb-pb"><ul class="gs-rb-list">' +
      list.map(function (u) {
        return '<li class="gs-rb-row gs-rba-unmrow"><span class="gs-rb-id"><span class="gs-rb-nm">' + G.ui.classNameHtml(u.name, u.class) + '</span><span class="gs-rb-sp">' + esc(R().unmatchedEvidence(u)) + '</span></span>' +
          (review ? '<span class="gs-rba-acts">' + R().itemActionsHtml(data.raid.id, Object.assign({}, u), 'raid') + '</span>' : '') + '</li>';
      }).join('') + '</ul></div></section>';
  }

  G.pages.raidAttendance = { panelHtml: panelHtml, unmatchedHtml: unmatchedHtml, evidenceOf: evidenceOf };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
