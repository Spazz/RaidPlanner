// ── PAGES: RAIDS LIST and NEW RAID ──────────────────────────────
// The list of one team's raids (GET /raids?team=, newest first) with status pills, and the New raid page, which
// runs its calls in order (create raid, event, each report, plan) with a status line per source. A failure stops that
// source only: the raid exists, the page links to it and offers Retry. Dates are the guild's calendar dates.
(function (G) {
  'use strict';

  const REPORT_SHORT = 28;
  const RAID_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function raidHref(gid, rid) { return G.router.format({ name: 'raid', gid: gid, rid: rid }); }

  // ── list ──
  function pillHtml(kind, text) { return '<span class="gs-pill gs-pill-' + kind + '">' + esc(text) + '</span>'; }

  // The status pills of one list row: the state, plus open flags on a manual raid, plus "Recalculate" when stale.
  function statePillsHtml(r) {
    const pills = [];
    const flags = r.openFlags > 0 ? r.openFlags : 0;
    switch (r.state) {
      case 'awaiting_log': pills.push(pillHtml('muted', 'Awaiting log')); break;
      case 'manual':
        pills.push(pillHtml('info', 'No log - by hand'));
        if (flags) pills.push(pillHtml('warn', flags + ' to review'));
        break;
      case 'to_review': pills.push(pillHtml('warn', flags + ' to review')); break;
      case 'reviewed': pills.push(pillHtml('ok', 'Reviewed')); break;
      case 'stale': pills.push(pillHtml('warn', 'Needs recalculation')); break;
      default: pills.push(pillHtml('muted', String(r.state == null ? '' : r.state).replace(/_/g, ' ')));
    }
    if (r.stale && r.state !== 'stale') pills.push(pillHtml('warn', 'Recalculate'));
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

  function rowHtml(gid, r) {
    return '<tr><th scope="row" class="gs-cell-strong gs-nowrap"><a href="' + esc(raidHref(gid, r.id)) + '">' + esc(G.ui.weekdayDay(r.raidOn) || r.raidOn) + '</a></th>' +
      '<td>' + (r.zone ? esc(r.zone) : '<span class="gs-muted">-</span>') + '</td><td class="gs-nowrap">' + esc(bossesText(r.bosses)) + '</td><td>' + sourceChipsHtml(r.sources) + '</td>' +
      '<td class="gs-nowrap">' + esc(countsText(r.counts)) + '</td><td>' + statePillsHtml(r) + '</td></tr>';
  }

  function cardHtml(gid, r) {
    return '<li class="gs-roster-card"><div class="gs-card-top"><a class="gs-raid-link" href="' + esc(raidHref(gid, r.id)) + '">' + esc(G.ui.weekdayDay(r.raidOn) || r.raidOn) + '</a>' + statePillsHtml(r) + '</div>' +
      '<div class="gs-card-line">' + (r.zone ? esc(r.zone) + ' &middot; ' : '') + esc(bossesText(r.bosses)) + '</div>' +
      '<div class="gs-card-meta">' + sourceChipsHtml(r.sources) + (r.counts ? '<span class="gs-fine">Present ' + esc(r.counts.present || 0) + ' &middot; Bench ' + esc(r.counts.bench || 0) + ' &middot; Missed ' + esc(r.counts.missed || 0) + '</span>' : '') + '</div></li>';
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
      ? '<p class="gs-lead gs-lead-sm">A raid is one team\'s raid on one date. Add one from its Raid-Helper event and Warcraft Logs report, or backfill past reports.</p>' +
        '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'raidnew', gid: gid })) + '">New raid</a>' +
        '<a class="gs-btn" href="' + esc(G.router.format({ name: 'backfill', gid: gid })) + '">Backfill from Warcraft Logs</a></div>'
      : '<p class="gs-lead gs-lead-sm">Your officers haven\'t added a raid yet.</p>';
    return '<section class="gs-empty-card" aria-labelledby="raids-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('raids', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="raids-empty-h">No raids yet</h2>' + body + '</section>';
  }

  // opts: { guildData, teamId, data (GET /raids?team=) , progress, alert, more (bool) }
  function raidsHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || { raids: [] };
    const raids = Array.isArray(data.raids) ? data.raids : [];
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', opts.teamId);
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = A().teamOf(gd, opts.teamId);
    const sub = (several && team ? esc(team.name) : esc(gd.guild.name)) + ' &middot; ' + esc(plural(raids.length, 'raid', 'raids')) + ', newest first';
    const staleCount = raids.filter(function (r) { return r.stale; }).length;
    const actions = canEdit ? '<div class="gs-roster-actions"><a class="gs-btn" href="' + esc(G.router.format({ name: 'backfill', gid: gid })) + '">Backfill from Warcraft Logs</a>' +
      '<a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'raidnew', gid: gid })) + '">New raid</a></div>' : '';
    let body;
    if (!raids.length) {
      body = emptyHtml(gd, canEdit);
    } else {
      body = '<div class="gs-table-wrap gs-raids-table"><table class="gs-table gs-table-raids" aria-label="Raids"><thead><tr><th scope="col">Date</th><th scope="col">Zone</th><th scope="col">Bosses</th><th scope="col">Sources</th>' +
        '<th scope="col">Present / Bench / Missed</th><th scope="col">Status</th></tr></thead><tbody>' + raids.map(function (r) { return rowHtml(gid, r); }).join('') + '</tbody></table></div>' +
        '<ul class="gs-roster-cards gs-raids-cards" aria-label="Raids">' + raids.map(function (r) { return cardHtml(gid, r); }).join('') + '</ul>' +
        (opts.more ? '<div class="gs-actions"><button type="button" class="gs-btn" data-action="raids-older" data-key="raids-older">Show older raids</button></div>' : '');
    }
    return '<div class="gs-page"><div class="gs-roster-head"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Raids</h1><p class="gs-sub">' + sub + '</p></div>' + actions + '</div>' +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + A().staleBannerHtml(staleCount, canEdit, opts.progress) + flagBannerHtml(gd, opts.teamId, raids) + body + '</div>';
  }

  function loadList(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().raids = { gid: gid, teamId: null, data: null }; return null; }
    return G.api.get(A().apiBase(gid) + '/raids?team=' + encodeURIComponent(teamId)).then(function (data) {
      a().raids = { gid: gid, teamId: teamId, data: data, more: !!(data && data.hasMore) };
      return null;
    });
  }

  function mainList(r, gd) {
    const x = a().raids;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return raidsHtml({ guildData: gd, teamId: x.teamId, data: x.data, more: x.more, progress: a().recalc, alert: st().pageAlert });
  }

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
    return { teamId: G.app.teamFor(gd) || '', event: '', reports: [''], plan: '', mode: 'log', date: '' };
  }

  function editableTeams(gd) {
    return G.shell.activeTeams(gd.teams).filter(function (t) { return G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', t.id); });
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

  function runLinesHtml(gid, run, retryAction) {
    const retry = retryAction || 'nr-retry';
    const words = { pending: 'Waiting', running: 'Working...', ok: 'Done', error: 'Failed', skipped: 'Waiting for the raid' };
    return '<ul class="gs-run-lines" aria-live="polite">' + run.lines.map(function (l) {
      let actions = '';
      if (l.status === 'error') {
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
    const manual = f.mode === 'manual';
    const teamField = teams.length > 1
      ? '<div class="gs-field"><label class="gs-label" for="nr-team">Team</label><select class="gs-input" id="nr-team" data-key="nr-team">' + G.ui.optionsHtml(teams.map(function (t) { return { value: t.id, label: t.name }; }), f.teamId) + '</select></div>' : '';
    const done = run && !run.running;
    const raidId = run && run.raidId;
    const runBlock = run
      ? '<section class="gs-card-sec" aria-labelledby="nr-run-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="nr-run-h">Creating the raid</h2></div><div class="gs-card-sec-body">' + runLinesHtml(gid, run) +
        (raidId ? '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(raidHref(gid, raidId)) + '">Open raid</a>' + (done ? '<button type="button" class="gs-btn" data-action="nr-another" data-key="nr-another">Add another raid</button>' : '') + '</div>' : '') + '</div></section>'
      : '';
    const form = run ? '' : '<form class="gs-card-sec" data-submit="nr-create-form" novalidate><div class="gs-card-sec-body">' + teamField +
      '<fieldset class="gs-fieldset"><legend class="gs-legend">Attendance source</legend><div class="gs-radios">' +
      '<div class="gs-check"><input type="radio" id="nr-mode-log" name="nr-mode" value="log"' + (manual ? '' : ' checked') + ' data-change="nr-mode"><label for="nr-mode-log">Warcraft Logs report</label></div>' +
      '<div class="gs-check"><input type="radio" id="nr-mode-manual" name="nr-mode" value="manual"' + (manual ? ' checked' : '') + ' data-change="nr-mode"><label for="nr-mode-manual">No log - enter attendance by hand</label></div></div></fieldset>' +
      '<div class="gs-field"><label class="gs-label" for="nr-event">Raid-Helper event (optional)</label><input class="gs-input" type="text" id="nr-event" data-key="nr-event" placeholder="Event link or ID" autocomplete="off" value="' + esc(f.event) + '" aria-describedby="nr-event-help">' +
      '<p class="gs-fine" id="nr-event-help">The sign-ups. The event\'s start time also sets the raid date.</p></div>' +
      '<div class="gs-field"><label class="gs-label" for="nr-date">Raid date' + (f.event.trim() ? ' (optional)' : '') + '</label><input class="gs-input" type="date" id="nr-date" data-key="nr-date" value="' + esc(f.date) + '" aria-describedby="nr-date-help">' +
      '<p class="gs-fine" id="nr-date-help">Needed unless a Raid-Helper event gives the date. The guild\'s calendar date.</p></div>' +
      (manual ? '<p class="gs-fine">After the raid is created you tick who was present and give a reason.</p>'
        : '<fieldset class="gs-fieldset" id="nr-reports"><legend class="gs-legend">Warcraft Logs reports (optional)</legend>' + f.reports.map(function (v, i) { return reportRowHtml(v, i, f.reports.length); }).join('') +
          '<div><button type="button" class="gs-btn gs-btn-sm" data-action="nr-add-report" data-key="nr-add-report">Add another report</button></div></fieldset>') +
      '<div class="gs-field"><label class="gs-label" for="nr-plan">Raidsmith plan (optional)</label><textarea class="gs-input gs-textarea" id="nr-plan" data-key="nr-plan" rows="2" placeholder="Plan link or share code" autocomplete="off">' + esc(f.plan) + '</textarea></div>' +
      '<p class="gs-alert" id="nr-error" role="alert"' + (nr.error ? '' : ' hidden') + '>' + esc(nr.error) + '</p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten">Create raid</button><a class="gs-btn" href="' + esc(G.router.format({ name: 'section', gid: gid, section: 'raids' })) + '">Cancel</a></div></div></form>';
    return '<div class="gs-page gs-page-narrow"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">New raid</h1><p class="gs-sub">One team\'s raid on one date. Add what you have; the rest can be added later.</p></div>' + form + runBlock + '</div>';
  }

  function mainNew(r, gd) {
    const nr = newState();
    if (!nr || nr.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return raidNewHtml({ guildData: gd, state: nr });
  }

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
      const body = { teamId: f.teamId };
      if (f.date) body.raidOn = f.date;
      if (f.event.trim() && !f.date) body.eventSource = f.event.trim();
      if (run.acceptOtherServer) body.acceptOtherServer = true;
      promise = G.api.post(base + '/raids', body).then(function (res) { run.raidId = res.raid.id; });
    } else if (!run.raidId) {
      line.status = 'skipped';
      return Promise.resolve();
    } else if (line.id === 'event') {
      promise = G.api.put(base + '/raids/' + encodeURIComponent(run.raidId) + '/event', { source: f.event.trim(), acceptOtherServer: !!line.acceptOtherServer });
    } else if (line.id === 'plan') {
      promise = G.planSource.read(f.plan, {}).then(function (read) {
        if (!read.ok) { const e = new Error(read.error); e.planError = true; throw e; }
        return G.api.put(base + '/raids/' + encodeURIComponent(run.raidId) + '/plan', { label: read.label, players: read.players }).then(function () {
          if (read.skippedText) line.message = read.skippedText;
        }, function (err) {
          const planText = G.planSource.describeError(err, read.players);
          if (planText) { const e = new Error(planText); e.planError = true; throw e; }
          throw err;
        });
      });
    } else {
      const body = { source: line.src.trim() };
      if (line.confirmFar) body.confirmFar = true;
      promise = G.api.put(base + '/raids/' + encodeURIComponent(run.raidId) + '/reports', body);
    }
    return promise.then(function () { line.status = 'ok'; }, function (err) {
      line.status = 'error';
      if (err && err.planError) { line.message = err.message; return; }
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      line.message = c.text;
      const rid = err && err.body && err.body.raidId;
      if (err && (err.code === 'raid_exists' || err.code === 'event_exists') && rid) line.openRaidId = rid;
      if (err && err.code === 'other_server') line.accept = 'Import anyway';
      if (err && err.code === 'report_not_same_night') line.accept = 'Add anyway';
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

  function buildLines(f) {
    const lines = [{ id: 'raid', label: f.event.trim() && !f.date ? 'Create the raid from the Raid-Helper event' : 'Create the raid', status: 'pending' }];
    if (f.event.trim() && f.date) lines.push({ id: 'event', label: 'Raid-Helper event', status: 'pending' });
    if (f.mode === 'log') {
      f.reports.forEach(function (v, i) {
        if (v.trim()) lines.push({ id: 'report-' + i, label: 'Warcraft Logs report: ' + shorten(v), src: v, status: 'pending' });
      });
    }
    if (f.plan.trim()) lines.push({ id: 'plan', label: 'Raidsmith plan', status: 'pending' });
    return lines;
  }

  G.handlers.submit['nr-create-form'] = function () {
    syncForm();
    const nr = newState();
    const gd = currentGd();
    if (!nr || !gd) return;
    const f = nr.form;
    nr.error = '';
    if (!f.teamId) nr.error = 'Choose a team.';
    else if (f.date && !RAID_DATE.test(f.date)) nr.error = 'Enter the raid date as a calendar date.';
    else if (!f.event.trim() && !f.date) nr.error = 'Enter the raid date, or a Raid-Helper event that has one.';
    if (nr.error) { G.app.render(); G.ui.focusByKey('nr-date'); return; }
    nr.run = { gid: gd.guild.id, form: JSON.parse(JSON.stringify(f)), lines: buildLines(f), raidId: null, running: true, acceptOtherServer: false };
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
      if (line.id === 'event') line.acceptOtherServer = true;
      if (line.id.indexOf('report-') === 0) line.confirmFar = true;
    }
    line.status = 'pending';
    runPending(nr.run);
  };

  G.pages.raids = { raidsHtml: raidsHtml, statePillsHtml: statePillsHtml, sourceChipsHtml: sourceChipsHtml, bossesText: bossesText, load: loadList, main: mainList };
  G.pages.raidNew = { raidNewHtml: raidNewHtml, buildLines: buildLines, runLinesHtml: runLinesHtml, load: loadNew, main: mainNew, syncForm: syncForm };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
