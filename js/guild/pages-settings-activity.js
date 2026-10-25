// ── PAGE: GUILD SETTINGS > ACTIVITY (the audit log) ─────────────
// A newest-first list of what people changed in this guild (GET /audit): when (in the guild's time zone), who, one plain sentence, and a Details
// toggle with the before / after JSON. The filters (type group, person, from and to date) read the list again from the start; 50 rows per page and
// "Older" appends the next one; "Download CSV" is a plain link built from the current filters. Notes text is never in an audit row, so it is never
// shown here. A table on desktop and cards on a phone. For people with audit.view (the Worker answers 403 to anyone else).
(function (G) {
  'use strict';

  const FILTERS = ['type', 'actor', 'from', 'to'];
  const FORMER_MEMBER = 'Former member';
  const NO_DETAILS = 'No before or after values were recorded.';

  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function blankFilters() { return { type: '', actor: '', from: '', to: '' }; }
  function hasFilters(f) { return FILTERS.some(function (k) { return !!(f && f[k]); }); }

  // ── view ──
  // 'Sat Oct 17, 8:15 PM ET'; the year joins the text when the row is from another year than `now`.
  function whenText(ms, timeZone, now) {
    return G.ui.dateTimeInZone(ms, timeZone, { year: 'auto', now: now });
  }

  function whoText(row) {
    const actor = row && row.actor;
    return actor && actor.displayName ? String(actor.displayName) : FORMER_MEMBER;
  }

  // The before / after values of one row, pretty-printed; the page escapes the text.
  function detailText(row) {
    const parts = [];
    if (row && row.before != null) parts.push('Before\n' + JSON.stringify(row.before, null, 2));
    if (row && row.after != null) parts.push('After\n' + JSON.stringify(row.after, null, 2));
    return parts.length ? parts.join('\n\n') : NO_DETAILS;
  }

  function detailsHtml(row) {
    return '<details class="gs-audit-details"><summary data-key="act-row-' + esc(row.id) + '">Details</summary><div class="gs-audit-detail-body">' +
      '<p class="gs-fine">Action: ' + esc(row.action) + '</p><pre class="gs-audit-json">' + esc(detailText(row)) + '</pre></div></details>';
  }

  function rowHtml(row, zone, now) {
    return '<tr><th scope="row" class="gs-cell-strong gs-nowrap gs-audit-when">' + esc(whenText(row.at, zone, now)) + '</th><td class="gs-audit-who">' + esc(whoText(row)) +
      '</td><td class="gs-audit-what">' + esc(row.text) + '</td><td>' + detailsHtml(row) + '</td></tr>';
  }

  function cardHtml(row, zone, now) {
    return '<li class="gs-roster-card"><div class="gs-card-top"><span class="gs-audit-when">' + esc(whenText(row.at, zone, now)) + '</span><span class="gs-audit-who">' + esc(whoText(row)) + '</span></div>' +
      '<div class="gs-card-line gs-audit-what">' + esc(row.text) + '</div>' + detailsHtml(row) + '</li>';
  }

  function listHtml(rows, zone, now) {
    rows = G.ui.sortItems('settings-activity', rows, { when: function (r) { return r.at; }, who: function (r) { return whoText(r); }, what: function (r) { return r.text; } });
    return '<div class="gs-table-wrap gs-hd-panel gs-audit-table"><table class="gs-table gs-table-audit" aria-label="Activity log"><thead><tr>' + G.ui.sortThHtml('settings-activity', 'when', 'When') + '' + G.ui.sortThHtml('settings-activity', 'who', 'Who') + '' +
      '' + G.ui.sortThHtml('settings-activity', 'what', 'What') + '<th scope="col"><span class="gs-sr">Details</span></th></tr></thead><tbody>' +
      rows.map(function (r) { return rowHtml(r, zone, now); }).join('') + '</tbody></table></div>' +
      '<ul class="gs-roster-cards gs-audit-cards gs-hd-panel" aria-label="Activity log">' + rows.map(function (r) { return cardHtml(r, zone, now); }).join('') + '</ul>';
  }

  function filterBarHtml(gid, s) {
    const f = s.filters;
    const types = [{ value: '', label: 'All activity' }].concat((s.types || []).map(function (t) { return { value: t.id, label: t.label }; }));
    const actors = [{ value: '', label: 'Everyone' }].concat((s.actors || []).map(function (p) { return { value: p.id, label: p.displayName }; }));
    return '<div class="gs-audit-filters gs-hd-panel" role="group" aria-label="Filter activity">' +
      '<div class="gs-field"><label class="gs-label" for="act-type">Type</label><select class="gs-input" id="act-type" data-change="audit-filter" data-filter="type" data-key="act-type">' + G.ui.optionsHtml(types, f.type) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="act-actor">Person</label><select class="gs-input" id="act-actor" data-change="audit-filter" data-filter="actor" data-key="act-actor">' + G.ui.optionsHtml(actors, f.actor) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="act-from">From</label><input class="gs-input" type="date" id="act-from" data-change="audit-filter" data-filter="from" data-key="act-from" value="' + esc(f.from) + '"></div>' +
      '<div class="gs-field"><label class="gs-label" for="act-to">To</label><input class="gs-input" type="date" id="act-to" data-change="audit-filter" data-filter="to" data-key="act-to" value="' + esc(f.to) + '"></div>' +
      '<div class="gs-audit-filter-actions"><button type="button" class="gs-btn" data-action="audit-clear" data-key="audit-clear"' + (hasFilters(f) ? '' : ' disabled') + '>Clear filters</button>' +
      '<a class="gs-btn" href="' + esc(G.api.audit.csvUrl(gid, f)) + '" download data-key="audit-csv">Download CSV</a></div></div>';
  }

  // opts: { guildData, s: state of the page, alert, now }
  function activityHtml(opts) {
    const gd = opts.guildData;
    const s = opts.s;
    const rows = Array.isArray(s.rows) ? s.rows : [];
    let status = '';
    let body;
    if (s.loading) {
      status = 'Loading...';
      body = '';
    } else if (rows.length) {
      status = 'Showing ' + plural(rows.length, 'entry', 'entries') + ', newest first.';
      body = listHtml(rows, s.timeZone, opts.now) +
        (s.next ? '<div class="gs-actions"><button type="button" class="gs-btn" data-action="audit-older" data-key="audit-older"' + (s.olderLoading ? ' disabled' : '') + '>' + (s.olderLoading ? 'Loading...' : 'Older') + '</button></div>' : '');
    } else {
      body = '<p class="gs-empty gs-hd-panel">' + (hasFilters(s.filters) ? 'No activity matches these filters.' : 'Nothing has been logged yet.') + '</p>';
    }
    return '<div class="gs-audit"><p class="gs-fine">What people changed in ' + esc(gd.guild.name) + '. Times are in the guild\'s time zone' + (s.timeZone ? ' (' + esc(s.timeZone) + ')' : '') + '.</p>' +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + filterBarHtml(gd.guild.id, s) +
      '<p class="gs-alert" id="act-error" role="alert"' + (s.error ? '' : ' hidden') + '>' + esc(s.error) + '</p>' +
      '<p class="gs-fine" id="act-status">' + esc(status) + '</p><p class="gs-sr" id="act-live" role="status"></p>' + body +
      (s.olderError ? '<p class="gs-alert" role="alert">' + esc(s.olderError) + '</p>' : '') + '</div>';
  }

  // ── data ──
  function adopt(gid, filters, res, prev) {
    const r = res || {};
    a().settingsActivity = {
      gid: gid,
      filters: Object.assign(blankFilters(), filters),
      rows: Array.isArray(r.rows) ? r.rows : [],
      next: typeof r.next === 'string' && r.next ? r.next : null,
      types: Array.isArray(r.types) ? r.types : (prev ? prev.types : []),
      actors: Array.isArray(r.actors) ? r.actors : (prev ? prev.actors : []),
      timeZone: typeof r.timeZone === 'string' ? r.timeZone : (prev ? prev.timeZone : ''),
      loading: false, olderLoading: false, error: '', olderError: '',
      seq: prev ? prev.seq : 0,
    };
    return a().settingsActivity;
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const prev = a().settingsActivity;
    const filters = prev && prev.gid === gid ? prev.filters : blankFilters();
    return G.api.audit.list(gid, filters).then(function (res) {
      adopt(gid, filters, res, prev && prev.gid === gid ? prev : null);
      return null;
    });
  }

  function main(r, gd, ctx) {
    const s = a().settingsActivity;
    if (!s || s.gid !== gd.guild.id) return G.ui.settingsLoadingHtml();
    return G.shell.settingsFrameHtml(ctx, 'activity', activityHtml({ guildData: gd, s: s, alert: st().pageAlert, now: Date.now() }));
  }

  function cur() { const s = a().settingsActivity; return s && currentGd() ? s : null; }

  // A failed read: sign-in and access problems go where every page sends them, anything else shows next to the list.
  function fail(err, setText) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
    setText(c.text);
    G.app.render();
  }

  // Reads the list from the start with the current filters. A newer read (or a leave) makes an older answer a no-op.
  function refetch(s) {
    s.error = '';
    s.olderError = '';
    if (s.filters.from && s.filters.to && s.filters.from > s.filters.to) {
      s.error = 'The From date is after the To date.';
      G.app.render();
      return Promise.resolve(null);
    }
    const token = ++s.seq;
    s.loading = true;
    G.app.render();
    return G.api.audit.list(s.gid, s.filters).then(function (res) {
      if (token !== s.seq || a().settingsActivity !== s) return null;
      const next = adopt(s.gid, s.filters, res, s);
      st().pageAlert = '';
      G.app.render();
      G.ui.announce('act-live', next.rows.length ? 'Showing ' + plural(next.rows.length, 'entry', 'entries') + '.' : (hasFilters(next.filters) ? 'No activity matches these filters.' : 'Nothing has been logged yet.'));
      return null;
    }, function (err) {
      if (token !== s.seq || a().settingsActivity !== s) return null;
      s.loading = false;
      fail(err, function (text) { s.error = text; });
      return null;
    });
  }

  // ── handlers ──
  G.handlers.change['audit-filter'] = function (el) {
    const s = cur();
    const name = el.getAttribute('data-filter');
    if (!s || FILTERS.indexOf(name) < 0) return null;
    s.filters[name] = String(el.value == null ? '' : el.value);
    return refetch(s);
  };

  G.handlers.click['audit-clear'] = function () {
    const s = cur();
    if (!s || !hasFilters(s.filters)) return null;
    s.filters = blankFilters();
    const p = refetch(s);
    G.ui.focusByKey('act-type', { preventScroll: true });
    return p;
  };

  G.handlers.click['audit-older'] = function () {
    const s = cur();
    if (!s || !s.next || s.olderLoading) return null;
    const token = s.seq;
    s.olderLoading = true;
    s.olderError = '';
    G.app.render();
    return G.api.audit.list(s.gid, s.filters, s.next).then(function (res) {
      if (token !== s.seq || a().settingsActivity !== s) return null;
      const seen = {};
      s.rows.forEach(function (r) { seen[r.id] = true; });
      const more = (res && Array.isArray(res.rows) ? res.rows : []).filter(function (r) { return !seen[r.id]; });
      s.rows = s.rows.concat(more);
      s.next = res && typeof res.next === 'string' && res.next ? res.next : null;
      s.olderLoading = false;
      G.app.render();
      G.ui.announce('act-live', 'Loaded ' + plural(more.length, 'older entry', 'older entries') + '.');
      if (more.length) G.ui.focusByKey('act-row-' + more[0].id);
      return null;
    }, function (err) {
      if (token !== s.seq || a().settingsActivity !== s) return null;
      s.olderLoading = false;
      fail(err, function (text) { s.olderError = text; });
      return null;
    });
  };

  G.pages.settingsActivity = {
    FILTERS: FILTERS,
    FORMER_MEMBER: FORMER_MEMBER,
    blankFilters: blankFilters,
    whenText: whenText,
    whoText: whoText,
    detailText: detailText,
    activityHtml: activityHtml,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
