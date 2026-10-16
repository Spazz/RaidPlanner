// ── PAGE: REVIEW QUEUE (+ the Decide and Unmatched dialogs the raid page shares) ──
// Flags grouped by raid, each a compact row with Decide (no show, late, left early) or the two unmatched actions
// (link the character as a new Alt, or mark it a guest). GET /attendance/review?team= . A decision is
// POST /raids/:rid/decisions with the flags the officer saw (expectedFlags): a 409 flags_changed reloads the data.
(function (G) {
  'use strict';

  const LATE_TYPES = ['late', 'left_early', 'late_left'];
  const REASON_MIN = 3;
  const REASON_MAX = 200;
  const FILTERS = [
    { value: 'all', label: 'All flags' }, { value: 'no_show', label: 'No shows' },
    { value: 'late', label: 'Late or left early' }, { value: 'unmatched', label: 'Unmatched characters' },
  ];

  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }
  function isUnmatched(item) { return !!item && !item.playerId && typeof item.key === 'string'; }
  function raidHref(gid, rid) { return G.router.format({ name: 'raid', gid: gid, rid: rid }); }

  // ── decide: options per flag (spec: Consolidation, officer decisions) ──
  function lateOutcomeFor(flags) {
    const late = flags.indexOf('late') >= 0;
    const left = flags.indexOf('left_early') >= 0;
    return late && left ? 'late_left' : late ? 'late' : 'left_early';
  }

  function decideOptions(row) {
    const flags = Array.isArray(row && row.flags) ? row.flags : [];
    if (flags.indexOf('no_show') >= 0) return ['missed', 'missed_notice', 'bench', 'present'];
    if (flags.indexOf('late') >= 0 || flags.indexOf('left_early') >= 0) return [lateOutcomeFor(flags), 'present'];
    return ['present', 'bench', 'missed', 'missed_notice', 'late', 'left_early', 'late_left'];
  }

  function needsCredit(outcome) { return LATE_TYPES.indexOf(outcome) >= 0; }

  function creditValuesOf(policyView, teamId) {
    const r = policyView && policyView.resolved && policyView.resolved[teamId];
    const v = r && r.credit && Array.isArray(r.credit.values) ? r.credit.values : null;
    return v && v.length ? v : A().DEFAULT_CREDITS;
  }

  // "In 8 of 17 pulls; missed the first pull." / "Signed up, not in the log."
  function evidenceText(row) {
    if (!row) return '';
    const p = row.pulls || {};
    const flags = Array.isArray(row.flags) ? row.flags : [];
    const parts = [];
    if (flags.indexOf('no_show') >= 0) {
      const kind = row.signup && row.signup !== 'signed' ? ' (' + (A().KIND_LABELS[row.signup] || row.signup).toLowerCase() + ')' : '';
      parts.push((row.signup ? 'Signed up' + kind : 'Expected') + ', not in the log');
    } else if (p.total > 0) {
      parts.push('In ' + p.present + ' of ' + p.total + ' pulls');
      if (p.missedFirst) parts.push('missed the first pull');
      if (p.missedLast) parts.push('missed the last pull');
    }
    return parts.join('; ');
  }

  function unmatchedEvidence(u) {
    const cls = u.class ? G.ui.className(u.class) + (u.realm ? ' on ' + u.realm : '') : (u.realm || '');
    const pulls = typeof u.pullsPresent === 'number' ? 'in ' + plural(u.pullsPresent, 'pull', 'pulls') : '';
    return [cls, pulls, 'no linked person'].filter(Boolean).join(', ');
  }

  // opts: { raid: {id, raidOn}, row, credits: [{id,label,value}], where: 'raid'|'review' }
  function decideDialogHtml(opts) {
    const row = opts.row;
    const options = decideOptions(row);
    const first = options[0];
    const credits = opts.credits || A().DEFAULT_CREDITS;
    const raidLabel = G.ui.weekdayDay(opts.raid && opts.raid.raidOn) || '';
    const undo = row.decision
      ? '<form class="gs-dialog-form gs-dialog-sub" data-submit="undo-decision-form" data-rid="' + esc(opts.raid.id) + '" data-pid="' + esc(row.playerId) + '" data-where="' + esc(opts.where) + '" novalidate>' +
        '<h3 class="gs-h3">Undo the earlier decision</h3>' + (row.decision.reason ? '<p class="gs-fine">Decided: ' + esc(row.decision.reason) + (row.decision.by ? ' (' + esc(row.decision.by) + ')' : '') + '</p>' : '') +
        '<div class="gs-field"><label class="gs-label" for="undo-reason">Reason (required)</label><input class="gs-input" type="text" id="undo-reason" name="reason" maxlength="' + REASON_MAX + '" autocomplete="off">' +
        '<p class="gs-field-error" id="undo-err" role="alert" hidden></p></div>' +
        '<div class="gs-dialog-actions"><button type="submit" class="gs-btn">Undo decision</button></div></form>' : '';
    return '<form class="gs-dialog-form" data-submit="decide-form" data-rid="' + esc(opts.raid.id) + '" data-pid="' + esc(row.playerId) + '" data-where="' + esc(opts.where) + '" data-flags="' + esc(JSON.stringify(row.flags || [])) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Decide: ' + esc(row.name) + '</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(raidLabel) + '. ' + esc(evidenceText(row)) + '</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-outcome">Outcome</label><select class="gs-input" id="dlg-outcome" name="outcome" data-change="decide-outcome">' +
      G.ui.optionsHtml(options.map(function (o) { return { value: o, label: A().labelOf(o) }; }), first) + '</select></div>' +
      '<div class="gs-field" id="dlg-credit-field"' + (needsCredit(first) ? '' : ' hidden') + '><label class="gs-label" for="dlg-credit">Credit</label><select class="gs-input" id="dlg-credit" name="creditId">' +
      G.ui.optionsHtml(credits.map(function (c) { return { value: c.id, label: c.label + ' ' + Math.round(c.value * 100) + '%' }; }), credits[0].id) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-reason">Reason (required)</label><textarea class="gs-input gs-textarea" id="dlg-reason" name="reason" rows="2" maxlength="' + REASON_MAX + '" data-field="reason"></textarea>' +
      '<p class="gs-field-error" id="dlg-err-reason" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save decision</button></div></form>' + undo;
  }

  // people: the roster rows of the raid's team (GET /roster?team=); unm: the unmatched entry.
  function linkDialogHtml(opts) {
    const u = opts.unm;
    const people = Array.isArray(opts.people) ? opts.people : [];
    const list = people.map(function (p) {
      const shown = p.shown || {};
      const main = p.main || {};
      const name = main.name || shown.name || '';
      return '<li class="gs-pick-item" data-name="' + esc(String(name).toLowerCase()) + '"><div class="gs-check"><input type="radio" name="personId" id="pick-' + esc(p.id) + '" value="' + esc(p.id) + '"><label for="pick-' + esc(p.id) + '">' +
        G.ui.classNameHtml(name, main.class || shown.class) + ' <span class="gs-fine">' + esc(G.ui.statusLabel(p.status)) + (main.class ? ' &middot; ' + esc(G.ui.className(main.class)) : '') + '</span></label></div></li>';
    }).join('');
    return '<form class="gs-dialog-form" data-submit="unm-link-form" data-rid="' + esc(opts.raidId) + '" data-key="' + esc(u.key) + '" data-name="' + esc(u.name) + '" data-where="' + esc(opts.where) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Link ' + esc(u.name) + ' as an Alt</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(unmatchedEvidence(u)) + '. Pick the person this character belongs to; it is added to their record as a new Alt.</p>' +
      '<div class="gs-field"><label class="gs-label" for="unm-search">Search people</label><input class="gs-input" type="search" id="unm-search" data-input="unm-search" autocomplete="off"></div>' +
      '<ul class="gs-pick-list" aria-label="People">' + (list || '<li class="gs-fine">No one on this roster yet.</li>') + '</ul>' +
      '<p class="gs-field-error" id="dlg-err-personId" role="alert" hidden></p><p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Add as Alt</button></div></form>';
  }

  function guestDialogHtml(opts) {
    const u = opts.unm;
    return '<form class="gs-dialog-form" data-submit="unm-guest-form" data-rid="' + esc(opts.raidId) + '" data-key="' + esc(u.key) + '" data-name="' + esc(u.name) + '" data-where="' + esc(opts.where) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Mark ' + esc(u.name) + ' as a guest</h2>' +
      '<p class="gs-fine" id="dlg-text">Guests are ignored in attendance on every raid, now and later. ' + esc(unmatchedEvidence(u)) + '.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Mark as guest</button></div></form>';
  }

  // ── review page ──
  function flagKind(item) {
    if (isUnmatched(item)) return 'unmatched';
    const flags = item.flags || [];
    return flags.indexOf('no_show') >= 0 ? 'no_show' : 'late';
  }

  function itemActionsHtml(raidId, item, where) {
    if (isUnmatched(item)) {
      return '<button type="button" class="gs-btn gs-btn-sm" data-action="unm-link" data-rid="' + esc(raidId) + '" data-ukey="' + esc(item.key) + '" data-where="' + esc(where) + '" data-key="unm-link-' + esc(raidId + item.key) + '">Link as Alt...</button>' +
        '<button type="button" class="gs-btn gs-btn-sm" data-action="unm-guest" data-rid="' + esc(raidId) + '" data-ukey="' + esc(item.key) + '" data-where="' + esc(where) + '" data-key="unm-guest-' + esc(raidId + item.key) + '">Mark as guest</button>';
    }
    return '<button type="button" class="gs-btn gs-btn-sm" data-action="decide-open" data-rid="' + esc(raidId) + '" data-pid="' + esc(item.playerId) + '" data-where="' + esc(where) + '" data-key="decide-' + esc(raidId + item.playerId) + '">Decide</button>';
  }

  function itemHtml(gid, raidId, item) {
    if (isUnmatched(item)) {
      return '<li class="gs-review-item"><div class="gs-review-who">' + G.ui.classNameHtml(item.name, item.class) + A().flagChipsHtml(['unmatched']) +
        '<span class="gs-char-sub">' + esc(unmatchedEvidence(item)) + '</span></div><div class="gs-row-actions">' + itemActionsHtml(raidId, item, 'review') + '</div></li>';
    }
    return '<li class="gs-review-item"><div class="gs-review-who"><a class="gs-char-link ' + G.ui.classClass(item.class) + '" href="' + esc(G.router.format({ name: 'personatt', gid: gid, pid: item.playerId })) + '">' + esc(item.name) + '</a>' + A().flagChipsHtml(item.flags) +
      '<span class="gs-char-sub">' + esc(evidenceText(item)) + '</span></div><div class="gs-row-actions">' + itemActionsHtml(raidId, item, 'review') + '</div></li>';
  }

  function noteHtml(note) {
    return note ? '<div class="gs-notice" role="status"><span>' + esc(note) + '</span><button type="button" class="gs-linkbtn" data-action="att-note-dismiss" data-key="att-note-dismiss">Dismiss</button></div>' : '';
  }

  // opts: { guildData, teamId, data (GET /attendance/review), filter, progress, alert, note }
  function reviewHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || { raids: [], stale: [] };
    const filter = opts.filter || 'all';
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = A().teamOf(gd, opts.teamId);
    const groups = (Array.isArray(data.raids) ? data.raids : []).map(function (g) {
      return { raid: g.raid, items: (g.items || []).filter(function (i) { return filter === 'all' || flagKind(i) === filter; }) };
    }).filter(function (g) { return g.items.length; });
    const total = (data.raids || []).reduce(function (n, g) { return n + (g.items || []).length; }, 0);
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', opts.teamId);
    const sub = (several && team ? esc(team.name) + ' &middot; ' : '') + esc(plural(total, 'open flag', 'open flags')) + ' on ' + esc(plural((data.raids || []).length, 'raid', 'raids'));
    const filterField = total
      ? '<div class="gs-roster-status"><label class="gs-label" for="review-filter">Flag type</label><select class="gs-input" id="review-filter" data-change="review-filter" data-key="review-filter">' + G.ui.optionsHtml(FILTERS, filter) + '</select></div>' : '';
    let body;
    if (!total) {
      body = '<section class="gs-empty-card" aria-labelledby="review-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('check', 28) + '</span><h2 class="gs-h2 gs-h2-lg" id="review-empty-h">Nothing to review</h2>' +
        '<p class="gs-lead gs-lead-sm">Every raid is reviewed. New flags show up here after a raid\'s log is added.</p></section>';
    } else if (!groups.length) {
      body = '<p class="gs-empty">No flags of that type.</p>';
    } else {
      body = groups.map(function (g) {
        const r = g.raid || {};
        return '<section class="gs-card-sec" aria-labelledby="rv-' + esc(r.id) + '"><div class="gs-card-sec-head"><h2 class="gs-h2" id="rv-' + esc(r.id) + '">' + esc(G.ui.weekdayDay(r.raidOn) || '') + (r.zone ? ' - ' + esc(r.zone) : '') + '</h2>' +
          '<span class="gs-head-tools"><span class="gs-fine">' + esc(plural(g.items.length, 'flag', 'flags')) + '</span><a class="gs-btn gs-btn-sm" href="' + esc(raidHref(gid, r.id)) + '">Open raid</a></span></div>' +
          '<ul class="gs-review-list">' + g.items.map(function (i) { return itemHtml(gid, r.id, i); }).join('') + '</ul></section>';
      }).join('');
    }
    return '<div class="gs-page"><div class="gs-roster-head"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Review queue</h1><p class="gs-sub">' + sub + '</p></div>' + filterField + '</div>' +
      noteHtml(opts.note) + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + A().staleBannerHtml((data.stale || []).length, canEdit, opts.progress) + body + '</div>';
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    a().note = '';
    if (!teamId) { a().review = { gid: gid, teamId: null, data: null }; return null; }
    if (!G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', teamId)) {
      return Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'The review queue is for the officers and team leads of this team.' }));
    }
    return G.api.get(A().apiBase(gid) + '/attendance/review?team=' + encodeURIComponent(teamId)).then(function (data) {
      a().review = { gid: gid, teamId: teamId, data: data, filter: a().review && a().review.gid === gid && a().review.teamId === teamId ? a().review.filter : 'all' };
      return null;
    });
  }

  function main(r, gd) {
    const x = a().review;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return reviewHtml({ guildData: gd, teamId: x.teamId, data: x.data, filter: x.filter, progress: a().recalc, alert: st().pageAlert, note: a().note });
  }

  // ── behaviour shared by the review page and the raid page ──
  // Finds the row a Decide button belongs to: the raid page's people, or the review page's items.
  function findRow(where, rid, pid) {
    const s = a();
    if (where === 'raid') {
      const d = s.raid && s.raid.data;
      if (!d || !d.raid || d.raid.id !== rid) return null;
      const row = (d.people || []).filter(function (p) { return p.playerId === pid; })[0];
      return row ? { raid: d.raid, row: row } : null;
    }
    const rv = s.review && s.review.data;
    const g = rv ? (rv.raids || []).filter(function (x) { return x.raid && x.raid.id === rid; })[0] : null;
    const row = g ? (g.items || []).filter(function (i) { return i.playerId === pid; })[0] : null;
    return row ? { raid: g.raid, row: row } : null;
  }

  function findUnmatched(where, rid, key) {
    const s = a();
    if (where === 'raid') {
      const d = s.raid && s.raid.data;
      return d && d.raid && d.raid.id === rid ? (d.unmatched || []).filter(function (u) { return u.key === key; })[0] || null : null;
    }
    const rv = s.review && s.review.data;
    const g = rv ? (rv.raids || []).filter(function (x) { return x.raid && x.raid.id === rid; })[0] : null;
    return g ? (g.items || []).filter(function (i) { return isUnmatched(i) && i.key === key; })[0] || null : null;
  }

  function reloadReview() {
    const gd = currentGd();
    if (!gd) return Promise.resolve();
    return load(null, gd).then(function () { G.app.render(); }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  // After a successful write: the raid page takes the new detail, the review page reloads its queue.
  function afterWrite(where, gid, res, note) {
    G.app.applyFlags(gid, res);
    a().note = note || '';
    st().pageAlert = '';
    if (where === 'raid') {
      const detail = res && res.raid && res.raid.raid ? res.raid : res;
      if (detail && detail.raid && a().raid) a().raid.data = detail;
      G.app.render();
      return;
    }
    reloadReview();
  }

  G.handlers.click['att-note-dismiss'] = function () { a().note = ''; G.app.render(); };
  G.handlers.change['review-filter'] = function (el) {
    if (a().review) a().review.filter = el.value;
    G.app.render();
  };

  G.handlers.click['decide-open'] = function (el) {
    const gd = currentGd();
    const where = el.getAttribute('data-where');
    const hit = findRow(where, el.getAttribute('data-rid'), el.getAttribute('data-pid'));
    if (!gd || !hit) return;
    const teamId = idOf(hit.raid.team) || G.app.teamFor(gd);
    A().loadPolicy(gd.guild.id).then(function (view) {
      G.ui.openDialog(decideDialogHtml({ raid: hit.raid, row: hit.row, credits: creditValuesOf(view, teamId), where: where }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const sel = document.getElementById('dlg-reason');
      if (sel) sel.focus();
    });
  };

  G.handlers.change['decide-outcome'] = function (el) {
    const field = document.getElementById('dlg-credit-field');
    if (field) field.hidden = !needsCredit(el.value);
  };

  // flags_changed means the row moved under the officer: treat it like a conflict (reload, say why).
  function asConflict(promise) {
    return promise.catch(function (err) {
      if (err && err.code === 'flags_changed') { err.code = 'conflict'; }
      throw err;
    });
  }

  function reasonOf(value) { return String(value == null ? '' : value).trim(); }

  G.handlers.submit['decide-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const where = form.getAttribute('data-where');
    const rid = form.getAttribute('data-rid');
    const outcome = form.elements.outcome.value;
    const reason = reasonOf(form.elements.reason.value);
    G.ui.setText('dlg-err-reason', '');
    G.ui.setText('dlg-error', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      G.ui.setText('dlg-err-reason', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.');
      form.elements.reason.focus();
      return;
    }
    const body = { playerId: form.getAttribute('data-pid'), outcome: outcome, reason: reason, expectedFlags: JSON.parse(form.getAttribute('data-flags') || '[]') };
    if (needsCredit(outcome)) body.creditId = form.elements.creditId.value;
    const onConflict = function (err) {
      a().note = '';
      st().pageAlert = (err && err.message) || 'This row changed while you were deciding. The page now shows the current state.';
      if (where === 'raid') { G.pages.raid.reload(); } else { reloadReview(); }
    };
    G.ui.runDialog(form, asConflict(G.api.post(A().apiBase(gid) + '/raids/' + encodeURIComponent(rid) + '/decisions', body)), function (res) {
      afterWrite(where, gid, res, 'Decision saved.');
    }, onConflict);
  };

  G.handlers.submit['undo-decision-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const where = form.getAttribute('data-where');
    const reason = reasonOf(form.elements.reason.value);
    G.ui.setText('undo-err', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      G.ui.setText('undo-err', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.');
      form.elements.reason.focus();
      return;
    }
    G.ui.runDialog(form, G.api.del(A().apiBase(gid) + '/raids/' + encodeURIComponent(form.getAttribute('data-rid')) + '/decisions/' + encodeURIComponent(form.getAttribute('data-pid')), { reason: reason }), function (res) {
      afterWrite(where, gid, res, 'Decision undone.');
    });
  };

  // ── unmatched ──
  G.handlers.click['unm-link'] = function (el) {
    const gd = currentGd();
    const where = el.getAttribute('data-where');
    const rid = el.getAttribute('data-rid');
    const unm = findUnmatched(where, rid, el.getAttribute('data-ukey'));
    if (!gd || !unm) return;
    const teamId = G.app.teamFor(gd);
    el.disabled = true;
    G.api.get(A().apiBase(gd.guild.id) + '/roster?team=' + encodeURIComponent(teamId)).then(function (res) {
      el.disabled = false;
      G.ui.openDialog(linkDialogHtml({ unm: unm, people: res && res.people, raidId: rid, where: where }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const s = document.getElementById('unm-search');
      if (s) s.focus();
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  G.handlers.input['unm-search'] = function (el) {
    const q = String(el.value || '').trim().toLowerCase();
    const items = el.closest('form').querySelectorAll('.gs-pick-item');
    for (let i = 0; i < items.length; i++) items[i].hidden = !!q && items[i].getAttribute('data-name').indexOf(q) < 0;
  };

  G.handlers.click['unm-guest'] = function (el) {
    const where = el.getAttribute('data-where');
    const rid = el.getAttribute('data-rid');
    const unm = findUnmatched(where, rid, el.getAttribute('data-ukey'));
    if (!unm) return;
    G.ui.openDialog(guestDialogHtml({ unm: unm, raidId: rid, where: where }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  function unmatchedNote(res, text) {
    const n = res && res.staleRaids > 0 ? ' ' + plural(res.staleRaids, 'other raid needs', 'other raids need') + ' recalculating.' : '';
    return text + n;
  }

  G.handlers.submit['unm-link-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const picked = form.querySelector('input[name="personId"]:checked');
    G.ui.setText('dlg-err-personId', '');
    if (!picked) { G.ui.setText('dlg-err-personId', 'Pick the person this character belongs to.'); return; }
    const name = form.getAttribute('data-name');
    const where = form.getAttribute('data-where');
    G.ui.runDialog(form, G.api.post(A().apiBase(gid) + '/raids/' + encodeURIComponent(form.getAttribute('data-rid')) + '/unmatched', { key: form.getAttribute('data-key'), action: 'alt', personId: picked.value }), function (res) {
      afterWrite(where, gid, res, unmatchedNote(res, 'Added ' + name + ' as an Alt.'));
    });
  };

  G.handlers.submit['unm-guest-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const name = form.getAttribute('data-name');
    const where = form.getAttribute('data-where');
    G.ui.runDialog(form, G.api.post(A().apiBase(gid) + '/raids/' + encodeURIComponent(form.getAttribute('data-rid')) + '/unmatched', { key: form.getAttribute('data-key'), action: 'guest' }), function (res) {
      afterWrite(where, gid, res, unmatchedNote(res, 'Marked ' + name + ' as a guest.'));
    });
  };

  G.pages.review = {
    FILTERS: FILTERS,
    decideOptions: decideOptions,
    needsCredit: needsCredit,
    evidenceText: evidenceText,
    decideDialogHtml: decideDialogHtml,
    linkDialogHtml: linkDialogHtml,
    guestDialogHtml: guestDialogHtml,
    reviewHtml: reviewHtml,
    itemActionsHtml: itemActionsHtml,
    isUnmatched: isUnmatched,
    noteHtml: noteHtml,
    unmatchedEvidence: unmatchedEvidence,
    creditValuesOf: creditValuesOf,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
