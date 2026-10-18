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

  // Every loot call in one place (Phase 4 spec, section 5). They go through G.api.get / post / ... at call time, so a
  // test that replaces those methods sees them.
  function guildPath(gid, tail) { return '/api/guild/' + encodeURIComponent(gid) + tail; }
  function teamQuery(teamId, weeks) {
    return '?team=' + encodeURIComponent(teamId) + (weeks != null ? '&weeks=' + encodeURIComponent(weeks) : '');
  }
  G.api.loot = {
    raid: function (gid, rid) { return G.api.get(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot')); },
    preview: function (gid, rid, awards) { return G.api.post(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot/preview'), { awards: awards }); },
    commit: function (gid, rid, awards, includeOtherDay) {
      return G.api.post(guildPath(gid, '/raids/' + encodeURIComponent(rid) + '/loot'), { awards: awards, includeOtherDay: !!includeOtherDay });
    },
    update: function (gid, aid, body) { return G.api.patch(guildPath(gid, '/loot/' + encodeURIComponent(aid)), body); },
    remove: function (gid, aid) { return G.api.del(guildPath(gid, '/loot/' + encodeURIComponent(aid)), {}); },
    balance: function (gid, teamId, weeks) { return G.api.get(guildPath(gid, '/loot/balance' + teamQuery(teamId, weeks))); },
    raids: function (gid, teamId) { return G.api.get(guildPath(gid, '/loot/raids' + teamQuery(teamId))); },
    items: function (gid, teamId) { return G.api.get(guildPath(gid, '/loot/items' + teamQuery(teamId))); },
    person: function (gid, pid) { return G.api.get(guildPath(gid, '/loot/person/' + encodeURIComponent(pid))); },
    policy: function (gid) { return G.api.get(guildPath(gid, '/loot/policy')); },
    savePolicy: function (gid, teamId, override, version) {
      return G.api.put(guildPath(gid, '/loot/policy'), { teamId: teamId, override: override, version: version });
    },
  };

  // Every sign-up and raid-schedule call in one place (tasks/guild-phase6-signups-spec.md, "API (as built)"). Like the loot calls they go
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
  G.api.publicPage = {
    get: function (gid) { return G.api.get(guildPath(gid, '/public')); },
    save: function (gid, body) { return G.api.put(guildPath(gid, '/public'), body); },
    view: function (gid) { return G.api.get('/api/public/' + encodeURIComponent(gid)); },
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
