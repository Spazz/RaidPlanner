// ── GUILD API CLIENT ────────────────────────────────────────────
// One fetch wrapper for /auth/* and /api/guild/*. Every non-GET sends a JSON body ({} when empty),
// errors become ApiError objects, and classify() maps them to what the page should do.
(function (G) {
  'use strict';

  const MESSAGE_PAGE_TITLES = {
    access_removed: 'Access removed',
    not_member: 'You are not in this guild',
    forbidden: 'You cannot open this',
  };

  function defaultMessage(status) {
    if (status === 0) return 'Could not reach Raidsmith. Check your connection and try again.';
    if (status === 404) return 'That page or record was not found.';
    return 'Something went wrong. Try again in a moment.';
  }

  function ApiError(status, body) {
    const b = body && typeof body === 'object' ? body : {};
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof b.error === 'string' ? b.error : (status === 0 ? 'network' : 'error');
    this.message = typeof b.message === 'string' && b.message ? b.message : defaultMessage(status);
    this.field = typeof b.field === 'string' ? b.field : null;
    this.index = typeof b.index === 'number' ? b.index : null;
    this.retryAfter = typeof b.retryAfter === 'number' ? b.retryAfter : null;
    this.body = b;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function parseBody(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // fetchFn is injectable for tests; the page uses the global fetch.
  function request(method, path, body, fetchFn) {
    const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!f) return Promise.reject(new ApiError(0, null));
    const init = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body == null ? {} : body);
    }
    return f(path, init).then(function (res) {
      return res.text().then(function (text) {
        const data = parseBody(text);
        if (res.ok) return data;
        const err = new ApiError(res.status, data);
        if (err.retryAfter == null && res.headers && typeof res.headers.get === 'function') {
          const h = Number(res.headers.get('Retry-After'));
          if (isFinite(h) && h > 0) err.retryAfter = h;
        }
        throw err;
      });
    }, function () {
      throw new ApiError(0, null);
    });
  }

  // view: 'signin' (go to the sign-in page), 'message' (a page that says why), 'inline' (text next to the action).
  function classify(err) {
    const status = err && typeof err.status === 'number' ? err.status : 0;
    const code = err && err.code;
    const text = err && err.message ? err.message : defaultMessage(status);
    if (status === 401 || code === 'signed_out') return { view: 'signin', title: '', text: text };
    if (status === 403 && MESSAGE_PAGE_TITLES[code]) return { view: 'message', title: MESSAGE_PAGE_TITLES[code], text: text };
    if (status === 429 || code === 'rate_limited') {
      const n = err && typeof err.retryAfter === 'number' && err.retryAfter > 0 ? Math.ceil(err.retryAfter) : 0;
      const serverText = err && err.body && typeof err.body.message === 'string' ? err.body.message.trim() : '';
      if (serverText) {
        const hint = n >= 60 ? 'Try again in ' + Math.ceil(n / 60) + (Math.ceil(n / 60) === 1 ? ' minute' : ' minutes') : n ? 'Try again in ' + n + (n === 1 ? ' second' : ' seconds') : '';
        return { view: 'inline', title: '', text: serverText + (hint ? (/[.!?]$/.test(serverText) ? ' ' : '. ') + hint + '.' : '') };
      }
      return { view: 'inline', title: '', text: n ? 'Too many changes, try again in ' + n + ' s' : 'Too many changes, try again in a moment' };
    }
    return { view: 'inline', title: '', text: text };
  }

  G.api = {
    ApiError: ApiError,
    classify: classify,
    request: request,
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body); },
    put: function (path, body) { return request('PUT', path, body); },
    patch: function (path, body) { return request('PATCH', path, body); },
    del: function (path, body) { return request('DELETE', path, body); },
  };

  // A team's roster (GET /roster?team=): the manual loot award dialog suggests its character names (PM wave 5).
  G.api.teamRoster = function (gid, teamId) { return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/roster?team=' + encodeURIComponent(teamId)); };

  // Every loot call in one place (Phase 4 spec, section 5). They go through G.api.get / post / ... at call time, so a
  // test that replaces those methods sees them.
  function guildPath(gid, tail) { return '/api/guild/' + encodeURIComponent(gid) + tail; }
  function teamQuery(teamId, weeks) {
    return '?team=' + encodeURIComponent(teamId) + (weeks != null ? '&weeks=' + encodeURIComponent(weeks) : '');
  }
  G.api.loot = {
    raid: function (gid, rid) { return G.api.get(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot')); },
    preview: function (gid, rid, awards) { return G.api.post(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot/preview'), { awards: awards }); },
    // resolutions: { [checksum]: 'export' } for the conflict / deleted rows the officer chose to take from the export (every other row keeps the officer's).
    commit: function (gid, rid, awards, includeOtherDay, resolutions) {
      const body = { awards: awards, includeOtherDay: !!includeOtherDay };
      if (resolutions && Object.keys(resolutions).length) body.resolutions = resolutions;
      return G.api.post(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot'), body);
    },
    // PM wave 5: an award made by hand, the pasted TMB / softres lists of a raid and the board built from them.
    manual: function (gid, rid, body) { return G.api.post(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot/manual'), body); },
    board: function (gid, rid) { return G.api.get(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot-board')); },
    saveList: function (gid, rid, source, rows) { return G.api.put(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot-lists'), { source: source, rows: rows }); },
    update: function (gid, aid, body) { return G.api.patch(guildPath(gid, '/loot/' + encodeURIComponent(aid)), body); },
    remove: function (gid, aid) { return G.api.del(guildPath(gid, '/loot/' + encodeURIComponent(aid)), {}); },
    balance: function (gid, teamId, weeks) { return G.api.get(guildPath(gid, '/loot/balance' + teamQuery(teamId, weeks))); },
    raids: function (gid, teamId) { return G.api.get(guildPath(gid, '/loot/raids' + teamQuery(teamId))); },
    items: function (gid, teamId) { return G.api.get(guildPath(gid, '/loot/items' + teamQuery(teamId))); },
    person: function (gid, pid) { return G.api.get(guildPath(gid, '/loot/person/' + encodeURIComponent(pid))); },
    // The loot page redesign (lane W's contract): the hub, one item, one award record, Needs fixing and its Keep both.
    hub: function (gid, teamId) { return G.api.get(guildPath(gid, '/loot/hub' + teamQuery(teamId))); },
    item: function (gid, teamId, itemId) { return G.api.get(guildPath(gid, '/loot/items/' + encodeURIComponent(itemId) + teamQuery(teamId))); },
    award: function (gid, aid) { return G.api.get(guildPath(gid, '/loot/a/' + encodeURIComponent(aid))); },
    fix: function (gid, teamId) { return G.api.get(guildPath(gid, '/loot/fix' + teamQuery(teamId))); },
    keep: function (gid, raidId, itemId, winnerKey) { return G.api.post(guildPath(gid, '/loot/fix/keep'), { raidId: raidId, itemId: itemId, winnerKey: winnerKey }); },
    policy: function (gid) { return G.api.get(guildPath(gid, '/loot/policy')); },
    savePolicy: function (gid, teamId, override, version) {
      return G.api.put(guildPath(gid, '/loot/policy'), { teamId: teamId, override: override, version: version });
    },
  };

  // Every sign-up and raid-schedule call in one place (tasks/reference/guild-phase6-signups-spec.md, "API (as built)"). Like the loot calls they go
  // through G.api.get / put / ... at call time, so a test that replaces those methods sees them.
  function raidPath(gid, rid, tail) { return guildPath(gid, '/raids/' + encodeURIComponent(rid) + tail); }
  function schedulePath(gid, tid, tail) { return guildPath(gid, '/teams/' + encodeURIComponent(tid) + '/schedule' + (tail || '')); }
  G.api.signups = {
    view: function (gid, rid) { return G.api.get(raidPath(gid, rid, '/signups')); },
    save: function (gid, rid, body) { return G.api.put(raidPath(gid, rid, '/signup'), body); },
    withdraw: function (gid, rid) { return G.api.del(raidPath(gid, rid, '/signup'), {}); },
    savePerson: function (gid, rid, pid, body) { return G.api.put(raidPath(gid, rid, '/signups/' + encodeURIComponent(pid)), body); },
    removePerson: function (gid, rid, pid) { return G.api.del(raidPath(gid, rid, '/signups/' + encodeURIComponent(pid)), {}); },
    lock: function (gid, rid, locked) { return G.api.post(raidPath(gid, rid, locked ? '/signups/lock' : '/signups/unlock'), {}); },
    schedule: function (gid, tid) { return G.api.get(schedulePath(gid, tid)); },
    saveSchedule: function (gid, tid, body) { return G.api.put(schedulePath(gid, tid), body); },
    fill: function (gid, tid, weeks) { return G.api.post(schedulePath(gid, tid, '/raids'), weeks == null ? {} : { weeks: weeks }); },
  };

  // PM wave 1 (officer tools): the Activity log, the Home (needs attention) list, the Trial review card and the calendar link. Same rule as
  // the groups above: pages call these, never a raw path, and they go through G.api.get / post / ... at call time.
  // Activity log filters are { type, actor, from, to }; blank means no filter. The CSV link keeps the same order as the list call.
  const AUDIT_FILTERS = ['type', 'actor', 'from', 'to'];
  function auditQuery(filters, extra) {
    const f = filters || {};
    const parts = [];
    AUDIT_FILTERS.forEach(function (k) { if (typeof f[k] === 'string' && f[k]) parts.push(k + '=' + encodeURIComponent(f[k])); });
    (extra || []).forEach(function (pair) { parts.push(pair[0] + '=' + encodeURIComponent(pair[1])); });
    return parts.length ? '?' + parts.join('&') : '';
  }
  G.api.audit = {
    FILTERS: AUDIT_FILTERS,
    query: auditQuery,
    list: function (gid, filters, before) { return G.api.get(guildPath(gid, '/audit' + auditQuery(filters, before ? [['before', before]] : []))); },
    // A plain download link (the browser sends the session cookie); the Worker caps it at 5000 rows and ignores `before`.
    csvUrl: function (gid, filters) { return guildPath(gid, '/audit' + auditQuery(filters, [['format', 'csv']])); },
  };
  G.api.attention = {
    get: function (gid) { return G.api.get(guildPath(gid, '/attention')); },
    // Another reset week for the Home arrows: { week } for `offset` whole weeks from the current one (an integer -8..8, never auto-jumps).
    week: function (gid, offset) { return G.api.get(guildPath(gid, '/attention/week?offset=' + encodeURIComponent(offset))); },
    // Hide / snooze / mark Reviewed for every officer (the Worker picks the mode from the item's kind) and Restore. itemId is the item's `id`.
    dismiss: function (gid, itemId) { return G.api.post(guildPath(gid, '/attention/dismissals'), { itemId: itemId }); },
    restore: function (gid, itemId) { return G.api.del(guildPath(gid, '/attention/dismissals/' + encodeURIComponent(itemId)), {}); },
  };
  // Phase 8 (other guilds): the Guild Master's copy of the guild's data and deleting the guild, and hiding the setup checklist on Home.
  // exportUrl is a plain download link (the browser sends the session cookie; the Worker answers with a file).
  G.api.guildData = {
    exportUrl: function (gid) { return guildPath(gid, '/export'); },
    remove: function (gid, confirmName) { return G.api.del(guildPath(gid, ''), { confirmName: confirmName }); },
    dismissOnboarding: function (gid) { return G.api.post(guildPath(gid, '/onboarding/dismiss'), {}); },
  };
  function rosterPath(gid, pid, tail) { return guildPath(gid, '/roster/' + encodeURIComponent(pid) + (tail || '')); }
  G.api.trial = {
    get: function (gid, pid) { return G.api.get(rosterPath(gid, pid, '/trial')); },
    // The card's three buttons are PATCH /roster/:pid (status or trialEnd) and, for End trial with a note, PUT /roster/:pid/notes.
    update: function (gid, pid, body) { return G.api.patch(rosterPath(gid, pid), body); },
    saveNotes: function (gid, pid, body) { return G.api.put(rosterPath(gid, pid, '/notes'), body); },
  };
  // PM wave 2: away notices (mine, the team's next four weeks, one person's) and their writes.
  G.api.away = {
    mine: function (gid) { return G.api.get(guildPath(gid, '/away/mine')); },
    team: function (gid, tid) { return G.api.get(guildPath(gid, '/away?team=' + encodeURIComponent(tid))); },
    person: function (gid, pid) { return G.api.get(guildPath(gid, '/away?person=' + encodeURIComponent(pid))); },
    add: function (gid, body) { return G.api.post(guildPath(gid, '/away'), body); },
    save: function (gid, nid, body) { return G.api.put(guildPath(gid, '/away/' + encodeURIComponent(nid)), body); },
    remove: function (gid, nid) { return G.api.del(guildPath(gid, '/away/' + encodeURIComponent(nid)), {}); },
  };
  // PM wave 2: standing sign-ups (mine, per team) and a raid's published roster (officers' publish / unpublish, a member's confirm / decline).
  G.api.standing = {
    get: function (gid) { return G.api.get(guildPath(gid, '/standing')); },
    save: function (gid, tid, body) { return G.api.put(guildPath(gid, '/teams/' + encodeURIComponent(tid) + '/standing'), body); },
  };
  G.api.raidRoster = {
    get: function (gid, rid) { return G.api.get(raidPath(gid, rid, '/roster')); },
    publish: function (gid, rid) { return G.api.post(raidPath(gid, rid, '/roster'), {}); },
    unpublish: function (gid, rid) { return G.api.del(raidPath(gid, rid, '/roster'), {}); },
    confirm: function (gid, rid) { return G.api.post(raidPath(gid, rid, '/roster/confirm'), {}); },
    decline: function (gid, rid) { return G.api.post(raidPath(gid, rid, '/roster/decline'), {}); },
  };
  G.api.calendar = {
    status: function (gid, teamId) { return G.api.get(guildPath(gid, '/calendar?team=' + encodeURIComponent(teamId))); },
    create: function (gid, teamId) { return G.api.post(guildPath(gid, '/calendar'), { teamId: teamId }); },
    revoke: function (gid, teamId) { return G.api.del(guildPath(gid, '/calendar'), { teamId: teamId }); },
  };
  // Roles, Discord role mapping, guest links and the public page (Phase 7). Same rule: through G.api.get / post / ... at call time. Every role
  // mutation answers with the full role list; the guest token comes back once, from guests.create.
  G.api.roles = {
    list: function (gid) { return G.api.get(guildPath(gid, '/roles')); },
    create: function (gid, body) { return G.api.post(guildPath(gid, '/roles'), body); },
    update: function (gid, rid, body) { return G.api.put(guildPath(gid, '/roles/' + encodeURIComponent(rid)), body); },
    reset: function (gid, rid) { return G.api.post(guildPath(gid, '/roles/' + encodeURIComponent(rid) + '/reset'), {}); },
    remove: function (gid, rid) { return G.api.del(guildPath(gid, '/roles/' + encodeURIComponent(rid)), {}); },
  };
  G.api.discord = {
    get: function (gid) { return G.api.get(guildPath(gid, '/discord')); },
    saveMaps: function (gid, maps) { return G.api.put(guildPath(gid, '/discord/maps'), { maps: maps }); },
    syncPerson: function (gid, uid) { return G.api.post(guildPath(gid, '/people/' + encodeURIComponent(uid) + '/sync'), {}); },
    syncAll: function (gid, after) { return G.api.post(guildPath(gid, '/discord/sync'), after ? { after: after } : {}); },
  };
  G.api.guests = {
    list: function (gid) { return G.api.get(guildPath(gid, '/guest-links')); },
    create: function (gid, body) { return G.api.post(guildPath(gid, '/guest-links'), body); },
    revoke: function (gid, linkId) { return G.api.del(guildPath(gid, '/guest-links/' + encodeURIComponent(linkId)), {}); },
    // The visitor's side (no account): redeem a token for the guest cookie, read the view, leave.
    redeem: function (token) { return G.api.post('/auth/guest', { token: token }); },
    view: function () { return G.api.get('/api/guest'); },
    leave: function () { return G.api.del('/auth/guest', {}); },
  };
  // PM wave 3 (recruiting and the WoW Forever launch): the class and spec intent board, recruitment needs, the applications inbox with its public form,
  // and the CSV roster import. Same rule: through G.api.get / post / ... at call time.
  const enc = encodeURIComponent;
  G.api.intent = {
    get: function (gid, teamId, roundId) { return G.api.get(guildPath(gid, '/intent?team=' + enc(teamId) + (roundId ? '&round=' + enc(roundId) : ''))); },
    open: function (gid, teamId, body) { return G.api.post(guildPath(gid, '/teams/' + enc(teamId) + '/intent'), body); },
    close: function (gid, iid) { return G.api.patch(guildPath(gid, '/intent/' + enc(iid)), { status: 'closed' }); },
    pick: function (gid, iid, pid, body) { return G.api.put(guildPath(gid, '/intent/' + enc(iid) + '/picks/' + enc(pid)), body); },
    unpick: function (gid, iid, pid, kind) { return G.api.del(guildPath(gid, '/intent/' + enc(iid) + '/picks/' + enc(pid)), { kind: kind }); },
  };
  G.api.recruiting = {
    get: function (gid, teamId) { return G.api.get(guildPath(gid, '/recruiting?team=' + enc(teamId))); },
    saveTargets: function (gid, teamId, targets) { return G.api.put(guildPath(gid, '/teams/' + enc(teamId) + '/recruiting'), { targets: targets }); },
  };
  G.api.applications = {
    settings: function (gid) { return G.api.get(guildPath(gid, '/applications/settings')); },
    saveSettings: function (gid, body) { return G.api.put(guildPath(gid, '/applications/settings'), body); },
    list: function (gid, status, teamId) {
      const parts = [];
      if (status) parts.push('status=' + enc(status));
      if (teamId) parts.push('team=' + enc(teamId));
      return G.api.get(guildPath(gid, '/applications' + (parts.length ? '?' + parts.join('&') : '')));
    },
    update: function (gid, apid, body) { return G.api.patch(guildPath(gid, '/applications/' + enc(apid)), body); },
    accept: function (gid, apid, body) { return G.api.post(guildPath(gid, '/applications/' + enc(apid) + '/accept'), body || {}); },
    remove: function (gid, apid) { return G.api.del(guildPath(gid, '/applications/' + enc(apid)), {}); },
  };
  // The applicant's side (no account needed): the form, and sending it.
  G.api.apply = {
    form: function (gid) { return G.api.get('/api/apply/' + enc(gid)); },
    submit: function (gid, body) { return G.api.post('/api/apply/' + enc(gid), body); },
  };
  G.api.csvImport = {
    preview: function (gid, body) { return G.api.post(guildPath(gid, '/roster/import/csv/preview'), body); },
    commit: function (gid, body) { return G.api.post(guildPath(gid, '/roster/import/csv/commit'), body); },
  };
  // PM wave 4: a team's Discord channel posts (the webhook address goes in and never comes back) and "Don't mention me in reminders".
  G.api.notifications = {
    get: function (gid) { return G.api.get(guildPath(gid, '/notifications')); },
    save: function (gid, teamId, body) { return G.api.put(guildPath(gid, '/teams/' + enc(teamId) + '/notifications'), body); },
    test: function (gid, teamId) { return G.api.post(guildPath(gid, '/teams/' + enc(teamId) + '/notifications/test'), {}); },
  };
  G.api.reminders = {
    optOut: function (optOut) { return G.api.put('/auth/reminders', { optOut: !!optOut }); },
  };
  // PM wave 7: read-only API keys (Guild settings > Data access; the token comes back once, from dataKeys.create), a team's progress board, and the rank
  // ladder's accept / manual set / dismiss. Same rule: through G.api.get / post / ... at call time.
  G.api.dataKeys = {
    list: function (gid) { return G.api.get(guildPath(gid, '/api-keys')); },
    create: function (gid, body) { return G.api.post(guildPath(gid, '/api-keys'), body); },
    revoke: function (gid, kid) { return G.api.del(guildPath(gid, '/api-keys/' + enc(kid)), {}); },
  };
  G.api.progress = {
    get: function (gid, teamId) { return G.api.get(guildPath(gid, '/teams/' + enc(teamId) + '/progress')); },
  };
  G.api.ranks = {
    set: function (gid, pid, body) { return G.api.put(guildPath(gid, '/roster/' + enc(pid) + '/rank'), body); },
    dismiss: function (gid, pid, body) { return G.api.post(guildPath(gid, '/roster/' + enc(pid) + '/rank/dismiss'), body); },
  };
  // PM wave 8: raid duties, the Launch funnel, guest sign-up links (the officer's side, and the guest's: no account), and a pasted raid roster.
  G.api.duties = {
    get: function (gid, rid) { return G.api.get(raidPath(gid, rid, '/duties')); },
    save: function (gid, rid, duties) { return G.api.put(raidPath(gid, rid, '/duties'), { duties: duties }); },
  };
  G.api.launch = {
    get: function (gid, teamId) { return G.api.get(guildPath(gid, '/launch?team=' + enc(teamId))); },
    set: function (gid, pid, body) { return G.api.put(guildPath(gid, '/launch/' + enc(pid)), body); },
    mark: function (gid, teamId, enabled) { return G.api.put(guildPath(gid, '/teams/' + enc(teamId) + '/launch'), { enabled: !!enabled }); },
  };
  G.api.joinLinks = {
    list: function (gid, rid) { return G.api.get(raidPath(gid, rid, '/join-links')); },
    create: function (gid, rid, body) { return G.api.post(raidPath(gid, rid, '/join-links'), body || {}); },
    revoke: function (gid, rid, jid) { return G.api.del(raidPath(gid, rid, '/join-links/' + enc(jid)), {}); },
    removeGuest: function (gid, rid, signupId) { return G.api.del(raidPath(gid, rid, '/guests/' + enc(signupId)), {}); },
  };
  G.api.join = {
    view: function (token) { return G.api.post('/api/join/view', { token: token }); },
    submit: function (body) { return G.api.post('/api/join', body); },
  };
  G.api.pasteRoster = {
    preview: function (gid, rid, text) { return G.api.post(raidPath(gid, rid, '/manual/paste/preview'), { text: text }); },
    save: function (gid, rid, text, reason) { return G.api.post(raidPath(gid, rid, '/manual/paste'), reason ? { text: text, reason: reason } : { text: text }); },
  };
  // Dev-only "View as" (the Guild Master on a local run with DEV_VIEW_AS=1; every call is a 404 elsewhere).
  G.api.dev = {
    setViewAs: function (gid, roleId, teamId) { return G.api.put('/api/dev/view-as', teamId ? { gid: gid, roleId: roleId, teamId: teamId } : { gid: gid, roleId: roleId }); },
    clearViewAs: function () { return G.api.del('/api/dev/view-as', {}); },
    viewerPreview: function (gid, role) { return G.api.get('/api/dev/guild/' + encodeURIComponent(gid) + '/viewer?role=' + encodeURIComponent(role)); },
  };
  G.api.publicPage = {
    get: function (gid) { return G.api.get(guildPath(gid, '/public')); },
    save: function (gid, body) { return G.api.put(guildPath(gid, '/public'), body); },
    view: function (gid) { return G.api.get('/api/public/' + encodeURIComponent(gid)); },
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
