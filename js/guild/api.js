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
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
