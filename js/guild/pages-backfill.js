// ── PAGE: BACKFILL FROM WARCRAFT LOGS ───────────────────────────
// Lists the team's Warcraft Logs reports (25 per page, GET /attendance/backfill/reports), lets an officer tick some,
// groups the ticked ones by guild-local date ("3 raids from 4 reports") and creates the raids in a loop: create the raid,
// add its reports, then the optional Raid-Helper event. Afterwards: people whose join date is later than their first
// attended raid (UNTICKED by default; "Move join date back" writes the roster) and a link to the review queue.
(function (G) {
  'use strict';

  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function raidHref(gid, rid) { return G.router.format({ name: 'raid', gid: gid, rid: rid }); }

  // ── pure helpers ──
  // Ticked reports grouped by raid date, oldest first: [{ raidOn, reports: [report] }].
  function groupByDate(reports, ticked) {
    const by = {};
    (Array.isArray(reports) ? reports : []).forEach(function (r) {
      if (!ticked[r.code] || r.alreadyAdded) return;
      if (!by[r.raidOn]) by[r.raidOn] = [];
      by[r.raidOn].push(r);
    });
    return Object.keys(by).sort().map(function (d) {
      return { raidOn: d, reports: by[d].sort(function (x, y) { return (x.startTime || 0) - (y.startTime || 0); }) };
    });
  }

  function previewText(groups) {
    const reports = groups.reduce(function (n, g) { return n + g.reports.length; }, 0);
    return plural(groups.length, 'raid', 'raids') + ' from ' + plural(reports, 'report', 'reports');
  }

  // People whose join date is later than the day of their first attended raid.
  // att: GET /attendance/team?window=all ; roster: GET /roster?team= . Returns [{ id, name, class, joinedOn, first, version }].
  function joinCandidates(att, roster) {
    const byId = {};
    (roster && Array.isArray(roster.people) ? roster.people : []).forEach(function (p) { byId[p.id] = p; });
    const out = [];
    (att && Array.isArray(att.people) ? att.people : []).forEach(function (p) {
      const rp = byId[p.id];
      if (!rp || !rp.joinedOn) return;
      let first = '';
      (Array.isArray(p.cells) ? p.cells : []).forEach(function (c) {
        const d = c.date || c.raidOn || '';
        if (d && A().ATTENDED_OUTCOMES.indexOf(c.outcome) >= 0 && (!first || d < first)) first = d;
      });
      if (first && rp.joinedOn > first) out.push({ id: p.id, name: p.name, class: p.class, joinedOn: rp.joinedOn, first: first, version: rp.version });
    });
    return out.sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'en'); });
  }

  // ── view ──
  function uploaderNote(uploaders) {
    return uploaders.length ? 'Only reports uploaded by ' + uploaders.join(', ') + '.' : '';
  }

  function reportRowsHtml(gid, reports, ticked) {
    return reports.map(function (r) {
      const added = !!r.alreadyAdded;
      const id = 'bf-' + esc(r.code);
      return '<tr><td class="gs-tick-cell"><label class="gs-tick" for="' + id + '"><span class="gs-sr">' + (added ? 'Already added: ' : 'Add ') + esc(r.title || r.code) + '</span><input type="checkbox" id="' + id + '" data-change="bf-tick" data-code="' + esc(r.code) + '" data-key="' + id + '"' +
        (added ? ' disabled' : '') + (ticked[r.code] && !added ? ' checked' : '') + '></label></td>' +
        '<th scope="row" class="gs-cell-strong gs-nowrap">' + esc(G.ui.weekdayDay(r.raidOn) || r.raidOn) + '</th><td>' + esc(r.title || '') + '</td><td>' + (r.zone ? esc(r.zone) : '<span class="gs-muted">-</span>') + '</td><td>' + (r.owner ? esc(r.owner) : '<span class="gs-muted">-</span>') + '</td>' +
        '<td>' + (added ? '<a href="' + esc(raidHref(gid, r.alreadyAdded)) + '">Already added</a>' : '<span class="gs-muted">-</span>') + '</td></tr>';
    }).join('');
  }

  function previewHtml(groups, events) {
    if (!groups.length) return '';
    return '<section class="gs-card-sec" aria-labelledby="bf-prev-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="bf-prev-h">' + esc(previewText(groups)) + '</h2></div><div class="gs-card-sec-body"><ul class="gs-source-list">' + groups.map(function (g, i) {
      return '<li class="gs-source-row"><div><strong>' + esc(G.ui.weekdayDay(g.raidOn) || g.raidOn) + '</strong><span class="gs-fine"> ' + esc(plural(g.reports.length, 'report', 'reports')) + '</span></div>' +
        '<div class="gs-field"><label class="gs-label" for="bf-ev-' + i + '">Raid-Helper event for this raid (optional)</label><input class="gs-input bf-event" type="text" id="bf-ev-' + i + '" data-date="' + esc(g.raidOn) + '" data-key="bf-ev-' + i + '" placeholder="Event link or ID" autocomplete="off" value="' + esc(events[g.raidOn] || '') + '"></div></li>';
    }).join('') + '</ul><div class="gs-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="bf-create" data-key="bf-create">Create ' + esc(plural(groups.length, 'raid', 'raids')) + '</button></div></div></section>';
  }

  function joinStepHtml(gid, js) {
    if (!js) return '';
    if (js.loading) return '<section class="gs-card-sec"><div class="gs-card-sec-body"><p class="gs-fine" role="status">Checking join dates...</p></div></section>';
    const list = js.people || [];
    const head = '<div class="gs-card-sec-head"><h2 class="gs-h2" id="bf-join-h">Join dates</h2></div>';
    if (!list.length) {
      return '<section class="gs-card-sec" aria-labelledby="bf-join-h">' + head + '<div class="gs-card-sec-body"><p class="gs-fine">' + esc(js.message || 'No one has a join date later than their first attended raid.') + '</p>' + reviewLinkHtml(gid) + '</div></section>';
    }
    return '<section class="gs-card-sec" aria-labelledby="bf-join-h">' + head + '<div class="gs-card-sec-body"><p class="gs-fine">These people attended before their join date, so those raids would not count. Tick the ones to move back to their first raid.</p>' +
      '<ul class="gs-pick-list">' + list.map(function (p) {
        return '<li class="gs-pick-item"><div class="gs-check"><input type="checkbox" id="bj-' + esc(p.id) + '" data-change="bf-join-tick" data-pid="' + esc(p.id) + '" data-key="bj-' + esc(p.id) + '"' + (js.ticked[p.id] ? ' checked' : '') + '><label for="bj-' + esc(p.id) + '">' +
          G.ui.classNameHtml(p.name, p.class) + ' <span class="gs-fine">joined ' + esc(G.ui.formatDay(p.joinedOn)) + ', first raid ' + esc(G.ui.formatDay(p.first)) + '</span></label></div></li>';
      }).join('') + '</ul><div class="gs-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="bf-join-all" data-key="bf-join-all">Select all</button>' +
      '<button type="button" class="gs-btn gs-btn-molten" data-action="bf-join-move" data-key="bf-join-move"' + (Object.keys(js.ticked).some(function (k) { return js.ticked[k]; }) ? '' : ' disabled') + '>Move join date back</button></div>' +
      (js.message ? '<p class="gs-fine" role="status">' + esc(js.message) + '</p>' : '') + reviewLinkHtml(gid) + '</div></section>';
  }

  function reviewLinkHtml(gid) {
    return '<p class="gs-fine">Raids from before sign-ups were used show no-show flags. <a href="' + esc(G.router.format({ name: 'review', gid: gid })) + '">Open the review queue</a> to settle them as Bench or Missed.</p>';
  }

  // opts: { guildData, teamId, bf (state), uploaders: [names] , alert }
  function backfillHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const bf = opts.bf;
    const team = A().teamOf(gd, opts.teamId);
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const filterOn = bf.filterUploaders && opts.uploaders.length > 0;
    const reports = (bf.reports || []).filter(function (r) { return !filterOn || r.matchesUploader !== false; });
    const running = bf.run;
    const sub = (several && team ? esc(team.name) + ' &middot; ' : '') + 'Past reports from the guild\'s Warcraft Logs, newest first';
    let body;
    if (running) {
      const done = !running.running;
      body = '<section class="gs-card-sec" aria-labelledby="bf-run-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="bf-run-h">' + (done ? 'Backfill finished' : 'Creating raids') + '</h2></div><div class="gs-card-sec-body">' +
        G.pages.raidNew.runLinesHtml(gid, running, 'bf-retry') + (done ? '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'section', gid: gid, section: 'raids' })) + '">Open Raids</a><button type="button" class="gs-btn" data-action="bf-again" data-key="bf-again">Back to the list</button></div>' : '') +
        '</div></section>' + (done ? joinStepHtml(gid, bf.join) : '');
    } else {
      const ticked = bf.ticked || {};
      const groups = groupByDate(bf.reports, ticked);
      const note = filterOn ? '<div class="gs-check"><input type="checkbox" id="bf-filter" data-change="bf-filter" checked><label for="bf-filter">' + esc(uploaderNote(opts.uploaders)) + '</label></div>'
        : (opts.uploaders.length ? '<div class="gs-check"><input type="checkbox" id="bf-filter" data-change="bf-filter"><label for="bf-filter">' + esc(uploaderNote(opts.uploaders)) + '</label></div>' : '');
      body = note + (reports.length
        ? '<div class="gs-table-wrap gs-bf-table"><table class="gs-table gs-table-backfill" aria-label="Warcraft Logs reports"><thead><tr><th scope="col"><span class="gs-sr">Add</span></th><th scope="col">Date</th><th scope="col">Report</th><th scope="col">Zone</th><th scope="col">Uploader</th><th scope="col">Status</th></tr></thead><tbody>' + reportRowsHtml(gid, reports, ticked) + '</tbody></table></div>'
        : '<p class="gs-empty">' + (bf.loaded ? 'No reports found for this guild.' : 'Loading reports...') + '</p>') +
        (bf.hasMore ? '<div class="gs-actions"><button type="button" class="gs-btn" data-action="bf-more" data-key="bf-more">Show more reports</button></div>' : '') +
        previewHtml(groups, bf.events || {});
    }
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Backfill from Warcraft Logs</h1><p class="gs-sub">' + sub + '</p></div>' + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</div>';
  }

  // ── data ──
  function url(gid, teamId, page) {
    return A().apiBase(gid) + '/attendance/backfill/reports?team=' + encodeURIComponent(teamId) + '&page=' + page;
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId || !G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', teamId)) {
      return Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'Backfilling is for the officers and team leads of this team.' }));
    }
    return Promise.all([G.api.get(url(gid, teamId, 1)), A().loadPolicy(gid)]).then(function (res) {
      a().backfill = { gid: gid, teamId: teamId, reports: res[0].reports || [], hasMore: !!res[0].hasMore, page: 1, ticked: {}, events: {}, filterUploaders: true, loaded: true, run: null, join: null };
      return null;
    });
  }

  function uploadersOf(gid, teamId) {
    const view = a().policy && a().policy[gid];
    const list = view && view.wcl && view.wcl.uploaders && view.wcl.uploaders[teamId];
    return Array.isArray(list) ? list : [];
  }

  function main(r, gd) {
    const bf = a().backfill;
    if (!bf || bf.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return backfillHtml({ guildData: gd, teamId: bf.teamId, bf: bf, uploaders: uploadersOf(bf.gid, bf.teamId), alert: st().pageAlert });
  }

  function stillHere() { return typeof window !== 'undefined' && G.router.parse(window.location.hash).name === 'backfill'; }

  G.handlers.change['bf-tick'] = function (el) {
    const bf = a().backfill;
    if (!bf) return;
    syncEvents();
    if (el.checked) bf.ticked[el.getAttribute('data-code')] = true; else delete bf.ticked[el.getAttribute('data-code')];
    G.app.render();
  };

  G.handlers.change['bf-filter'] = function (el) {
    const bf = a().backfill;
    if (!bf) return;
    bf.filterUploaders = !!el.checked;
    G.app.render();
  };

  G.handlers.click['bf-more'] = function (el) {
    const bf = a().backfill;
    if (!bf) return;
    el.disabled = true;
    G.api.get(url(bf.gid, bf.teamId, bf.page + 1)).then(function (res) {
      bf.page += 1;
      bf.reports = bf.reports.concat(res.reports || []);
      bf.hasMore = !!res.hasMore;
      G.app.render();
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  function syncEvents() {
    const bf = a().backfill;
    if (!bf || typeof document === 'undefined') return;
    Array.prototype.forEach.call(document.querySelectorAll('.bf-event'), function (el) { bf.events[el.getAttribute('data-date')] = el.value; });
  }

  // ── the run ──
  function buildLines(groups, events) {
    const lines = [];
    groups.forEach(function (g) {
      const day = G.ui.weekdayDay(g.raidOn) || g.raidOn;
      lines.push({ id: 'raid:' + g.raidOn, group: g.raidOn, kind: 'raid', label: day + ': create the raid', status: 'pending' });
      g.reports.forEach(function (r) { lines.push({ id: 'report:' + g.raidOn + ':' + r.code, group: g.raidOn, kind: 'report', code: r.code, label: day + ': report ' + (r.title || r.code), status: 'pending' }); });
      if (String(events[g.raidOn] || '').trim()) lines.push({ id: 'event:' + g.raidOn, group: g.raidOn, kind: 'event', src: String(events[g.raidOn]).trim(), label: day + ': Raid-Helper event', status: 'pending' });
    });
    return lines;
  }

  function execLine(run, line) {
    const base = A().apiBase(run.gid);
    line.status = 'running';
    line.message = '';
    line.accept = '';
    line.openRaidId = '';
    let p;
    if (line.kind === 'raid') {
      p = G.api.post(base + '/raids', { teamId: run.teamId, raidOn: line.group }).then(function (res) { run.raidIds[line.group] = res.raid.id; run.created += 1; }, function (err) {
        if (err && err.code === 'raid_exists' && err.body && err.body.raidId) { run.raidIds[line.group] = err.body.raidId; line.message = 'A raid already exists on this date; adding to it.'; return; }
        throw err;
      });
    } else if (!run.raidIds[line.group]) {
      line.status = 'skipped';
      return Promise.resolve();
    } else if (line.kind === 'report') {
      const body = { source: line.code };
      if (line.confirmFar) body.confirmFar = true;
      p = G.api.put(base + '/raids/' + encodeURIComponent(run.raidIds[line.group]) + '/reports', body);
    } else {
      p = G.api.put(base + '/raids/' + encodeURIComponent(run.raidIds[line.group]) + '/event', { source: line.src, acceptOtherServer: !!line.acceptOtherServer });
    }
    return p.then(function () { line.status = 'ok'; }, function (err) {
      line.status = 'error';
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      line.message = c.text;
      if (err && err.code === 'report_not_same_night') line.accept = 'Add anyway';
      if (err && err.code === 'other_server') line.accept = 'Import anyway';
    });
  }

  function finish(bf) {
    bf.run.running = false;
    if (bf.run.created > 0 || bf.run.lines.some(function (l) { return l.status === 'ok'; })) loadJoinStep(bf);
    if (stillHere()) G.app.render();
  }

  function runPending(bf) {
    const run = bf.run;
    run.running = true;
    return run.lines.reduce(function (chain, line) {
      return chain.then(function () {
        if (line.status !== 'pending' && line.status !== 'skipped') return null;
        const p = execLine(run, line);
        if (stillHere()) G.app.render();
        return p.then(function () { if (stillHere()) G.app.render(); });
      });
    }, Promise.resolve()).then(function () { finish(bf); });
  }

  G.handlers.click['bf-create'] = function () {
    const bf = a().backfill;
    if (!bf || bf.run) return;
    syncEvents();
    const groups = groupByDate(bf.reports, bf.ticked);
    if (!groups.length) return;
    bf.run = { gid: bf.gid, teamId: bf.teamId, lines: buildLines(groups, bf.events), raidIds: {}, created: 0, running: true };
    G.app.render();
    runPending(bf);
  };

  G.handlers.click['bf-retry'] = function (el) {
    const bf = a().backfill;
    if (!bf || !bf.run || bf.run.running) return;
    const line = bf.run.lines.filter(function (l) { return l.id === el.getAttribute('data-line'); })[0];
    if (!line) return;
    if (el.getAttribute('data-accept') === '1') { if (line.kind === 'report') line.confirmFar = true; if (line.kind === 'event') line.acceptOtherServer = true; }
    line.status = 'pending';
    runPending(bf);
  };

  G.handlers.click['bf-again'] = function () {
    const gd = currentGd();
    if (!gd) return;
    load(null, gd).then(function () { G.app.render(true); }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  };

  // ── join dates ──
  function loadJoinStep(bf) {
    bf.join = { loading: true, people: [], ticked: {}, message: '' };
    const base = A().apiBase(bf.gid);
    return Promise.all([
      G.api.get(base + '/attendance/team?team=' + encodeURIComponent(bf.teamId) + '&window=all'),
      G.api.get(base + '/roster?team=' + encodeURIComponent(bf.teamId)),
    ]).then(function (res) {
      bf.join = { loading: false, people: joinCandidates(res[0], res[1]), ticked: {}, message: '' };
      if (stillHere()) G.app.render();
    }, function () {
      bf.join = { loading: false, people: [], ticked: {}, message: 'Could not check join dates. You can change them on each person\'s record.' };
      if (stillHere()) G.app.render();
    });
  }

  G.handlers.change['bf-join-tick'] = function (el) {
    const bf = a().backfill;
    if (!bf || !bf.join) return;
    bf.join.ticked[el.getAttribute('data-pid')] = !!el.checked;
    G.app.render();
  };

  G.handlers.click['bf-join-all'] = function () {
    const bf = a().backfill;
    if (!bf || !bf.join) return;
    bf.join.people.forEach(function (p) { bf.join.ticked[p.id] = true; });
    G.app.render();
  };

  G.handlers.click['bf-join-move'] = function (el) {
    const bf = a().backfill;
    if (!bf || !bf.join) return;
    const chosen = bf.join.people.filter(function (p) { return bf.join.ticked[p.id]; });
    if (!chosen.length) return;
    el.disabled = true;
    let moved = 0;
    chosen.reduce(function (chain, p) {
      return chain.then(function () {
        return G.api.patch(A().apiBase(bf.gid) + '/roster/' + encodeURIComponent(p.id), { expectedVersion: p.version, joinedOn: p.first }).then(function () { moved++; }, function () { /* counted below */ });
      });
    }, Promise.resolve()).then(function () {
      const failed = chosen.length - moved;
      return loadJoinStep(bf).then(function () {
        bf.join.message = 'Moved ' + plural(moved, 'join date', 'join dates') + ' back.' + (failed ? ' ' + plural(failed, 'person', 'people') + ' could not be changed; open their record.' : '');
        if (stillHere()) G.app.render();
      });
    });
  };

  G.pages.backfill = {
    groupByDate: groupByDate,
    previewText: previewText,
    joinCandidates: joinCandidates,
    buildLines: buildLines,
    backfillHtml: backfillHtml,
    joinStepHtml: joinStepHtml,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
