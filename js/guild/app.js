// ── GUILD APP (state, routing, events) ──────────────────────────
// Loads /auth/me, resolves the hash route, fetches what the route needs, renders the page as one HTML string
// (the page modules build it, every data string escaped) and dispatches delegated events to G.handlers.
// Only runs on guild.html (it needs #guild-root); tests load the pure modules without it.
(function (G) {
  'use strict';

  const TEAM_KEY = 'raidsmith.guild.team.';
  const state = {
    loaded: false,
    bootError: '',
    me: null,
    guilds: {},        // gid -> GET /api/guild/:gid
    people: {},        // gid -> GET /api/guild/:gid/people
    teamByGuild: {},
    currentGid: null,
    failure: null,     // { title, text, retry }
    notice: '',
    pageAlert: '',
    privacyMessage: '',
    signinNotice: '',
    peopleSort: { column: G.peopleSort.DEFAULT_SORT.column, dir: G.peopleSort.DEFAULT_SORT.dir },
    peopleQuery: '',
  };
  const app = G.app = { state: state };
  let root = null;
  let routeToken = 0;
  let firstRender = true;
  let zoneCache = null;

  // ── data ──
  function loadMe() {
    return G.api.get('/auth/me').then(function (me) {
      state.me = me;
      state.loaded = true;
      state.bootError = '';
      return me;
    }, function (err) {
      if (err.status === 401) { state.me = null; state.loaded = true; return null; }
      if (!state.loaded) { state.loaded = true; state.bootError = G.api.classify(err).text; }
      return null;
    });
  }

  function fetchGuild(gid) {
    return G.api.get('/api/guild/' + encodeURIComponent(gid)).then(function (res) {
      state.guilds[gid] = res;
      return res;
    });
  }

  function patchPrefs(body) {
    if (!state.me) return;
    G.api.patch('/auth/prefs', body).then(function (res) {
      if (res && res.prefs && state.me) state.me.user.prefs = res.prefs;
    }, function () { /* a preference that did not save is not worth a message */ });
  }

  function prefs() {
    return (state.me && state.me.user && state.me.user.prefs) || {};
  }

  // ── team choice (per-viewer convenience) ──
  function teamFor(gd) {
    const gid = gd.guild.id;
    const active = G.shell.activeTeams(gd.teams);
    if (!active.length) return null;
    let id = state.teamByGuild[gid];
    if (id === undefined) {
      try { id = window.localStorage.getItem(TEAM_KEY + gid); } catch (e) { id = null; }
    }
    if (!active.some(function (t) { return t.id === id; })) id = active[0].id;
    state.teamByGuild[gid] = id;
    return id;
  }

  // ── navigation ──
  function normalizedHash() { return window.location.hash || '#/'; }

  function go(hash, replace) {
    if (normalizedHash() === hash) { route(); return; }
    if (replace && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
      route();
      return;
    }
    window.location.hash = hash;
  }

  function resetSession() {
    state.me = null;
    state.guilds = {};
    state.people = {};
    state.failure = null;
    state.notice = '';
  }

  function failWith(title, text, retry) {
    state.failure = { title: title, text: text, retry: !!retry };
  }

  function handleLoadError(err) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { resetSession(); return; }
    if (c.view === 'message') { failWith(c.title, c.text, false); return; }
    failWith('Could not load this page', c.text, true);
  }

  // A route change leaves nothing open behind it: every dialog (the More drawer too) and the avatar menu.
  // `doc` is injectable for tests.
  function closeOverlays(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return;
    const open = d.querySelectorAll('dialog[open]');
    for (let i = 0; i < open.length; i++) open[i].close();
    const menu = d.getElementById('gs-account-menu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      const btn = d.querySelector('[data-action="toggle-menu"]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  function route() {
    const token = ++routeToken;
    closeOverlays();
    const r = G.router.parse(window.location.hash);
    state.failure = null;
    state.pageAlert = '';
    state.privacyMessage = r.name === 'privacy' ? state.privacyMessage : '';
    state.currentGid = r.gid || null;
    if (!(r.name === 'settings' && r.tab === 'people')) state.notice = '';

    const ready = state.loaded ? Promise.resolve() : (render(), loadMe());
    return ready.then(function () {
      if (token !== routeToken) return null;
      if (state.bootError || !state.me) return null;
      return resolveSignedIn(r, token);
    }).then(function () {
      if (token !== routeToken) return;
      render(true);
    });
  }

  function resolveSignedIn(r, token) {
    const me = state.me;
    const guilds = Array.isArray(me.guilds) ? me.guilds : [];

    if (r.name === 'home' || r.name === 'signin') {
      if (!guilds.length) return null;
      const last = prefs().lastGuildId;
      const target = guilds.filter(function (g) { return g.id === last; })[0] || guilds[0];
      window.history.replaceState(null, '', window.location.pathname + window.location.search + G.router.format({ name: 'section', gid: target.id, section: 'roster' }));
      return route();
    }
    if (r.name === 'privacy') {
      return loadMe().then(function () { return null; });
    }
    if (!r.gid) return null;

    state.currentGid = r.gid;
    const needFetch = !state.guilds[r.gid] || r.name === 'settings';
    const loadGuild = needFetch ? fetchGuild(r.gid) : Promise.resolve(state.guilds[r.gid]);
    return loadGuild.then(function (gd) {
      if (token !== routeToken) return null;
      if (prefs().lastGuildId !== r.gid) {
        if (state.me && state.me.user) state.me.user.prefs = Object.assign({}, prefs(), { lastGuildId: r.gid });
        patchPrefs({ lastGuildId: r.gid });
      }
      if (r.name !== 'settings') return null;
      const tabs = G.shell.settingsTabs(gd.me && gd.me.can);
      if (!tabs.length) { failWith('You cannot open this', 'Guild settings are for the people who run the guild.', false); return null; }
      let tab = r.tab;
      if (!tab) {
        tab = tabs[0].tab;
        window.history.replaceState(null, '', window.location.pathname + window.location.search + G.router.format({ name: 'settings', gid: r.gid, tab: tab }));
      }
      if (!tabs.some(function (t) { return t.tab === tab; })) { failWith('You cannot open this', 'Your role does not include this part of Guild settings.', false); return null; }
      if (tab !== 'people') return null;
      return G.api.get('/api/guild/' + encodeURIComponent(r.gid) + '/people').then(function (res) {
        state.people[r.gid] = res;
        return null;
      });
    }).catch(function (err) {
      if (token !== routeToken) return null;
      handleLoadError(err);
      return null;
    });
  }

  // ── rendering ──
  function titleFor(r, gd) {
    const base = 'Raidsmith guild';
    let page = '';
    if (r.name === 'privacy') page = 'Privacy & my data';
    else if (r.name === 'new') page = 'Create a guild';
    else if (r.name === 'section') page = { roster: 'Roster', nights: 'Raid nights', attendance: 'Attendance', loot: 'Loot' }[r.section] || '';
    else if (r.name === 'settings') page = 'Guild settings';
    if (gd && gd.guild && page) page += ' - ' + gd.guild.name;
    return page ? page + ' - ' + base : base;
  }

  function timeZones() {
    if (!zoneCache) zoneCache = G.pages.create.allTimeZones();
    return zoneCache;
  }

  function mainFor(r, gd, ctx) {
    const P = G.pages;
    if (state.failure) return P.signin.messageHtml(state.failure.title, state.failure.text, { retry: state.failure.retry });
    switch (r.name) {
      case 'home':
      case 'signin':
        return state.me.guilds && state.me.guilds.length ? P.signin.loadingHtml() : P.signin.noGuildHtml(state.me);
      case 'new':
        return P.create.createHtml({ me: state.me, timeZones: timeZones(), defaultTimeZone: P.create.browserTimeZone(), alert: state.pageAlert });
      case 'privacy':
        return P.privacy.privacyHtml({ me: state.me, message: state.privacyMessage });
      case 'section':
        return gd ? P.empty.emptyHtml(r.section) : P.signin.loadingHtml();
      case 'settings': {
        if (!gd) return P.signin.loadingHtml();
        const tab = r.tab;
        if (tab === 'teams') return G.shell.settingsFrameHtml(ctx, 'teams', P.teams.teamsHtml({ guildData: gd, alert: state.pageAlert }));
        if (tab === 'people') {
          if (!state.people[gd.guild.id]) return P.signin.loadingHtml();
          return G.shell.settingsFrameHtml(ctx, 'people', P.people.peopleHtml({ guildData: gd, data: state.people[gd.guild.id], sort: state.peopleSort, query: state.peopleQuery, notice: state.notice, alert: state.pageAlert, now: Date.now() }));
        }
        return P.signin.loadingHtml();
      }
      default:
        return P.signin.messageHtml('Page not found', 'That address does not match a Raidsmith guild page.', {});
    }
  }

  function view(r) {
    if (!state.loaded) return { html: G.pages.signin.loadingHtml(), title: titleFor(r, null) };
    if (state.bootError) return { html: '<main class="gs-main gs-main-center" id="gs-main">' + G.pages.signin.messageHtml('Could not load Raidsmith', state.bootError, { retry: true }) + '</main>', title: titleFor(r, null) };
    if (!state.me) {
      if (r.name === 'privacy') {
        return { html: G.shell.publicHeaderHtml() + '<main class="gs-main" id="gs-main">' + G.pages.privacy.privacyHtml({ me: null }) + '</main>', title: titleFor(r, null) };
      }
      const html = G.pages.signin.signinHtml({ error: r.name === 'signin' ? r.error : null, notice: state.signinNotice });
      state.signinNotice = '';
      return { html: html, title: titleFor(r, null) };
    }
    const gd = r.gid ? state.guilds[r.gid] || null : null;
    const ctx = { me: state.me, route: r, guildData: gd, teamId: gd ? teamFor(gd) : null, collapsed: prefs().sidebarCollapsed === true };
    return { html: G.shell.render(ctx, mainFor(r, gd, ctx)), title: titleFor(r, gd) };
  }

  function render(focusHeading) {
    if (!root) return;
    const r = G.router.parse(window.location.hash);
    const active = document.activeElement;
    const key = active && active.getAttribute ? active.getAttribute('data-key') : null;
    const v = view(r);
    root.innerHTML = v.html;
    document.title = v.title;
    document.body.classList.toggle('is-signed-out', !state.me);
    if (focusHeading === true && !firstRender) {
      const h = root.querySelector('#gs-main h1');
      if (h) h.focus();
    } else if (key) {
      G.ui.focusByKey(key);
    }
    if (state.loaded) firstRender = false;
  }

  // ── actions other modules call ──
  app.render = render;
  app.go = go;
  app.closeOverlays = closeOverlays;
  app.loadMe = loadMe;

  app.requireSignin = function () {
    resetSession();
    go('#/', true);
  };

  app.showFailure = function (title, text) {
    failWith(title, text, false);
    render();
  };

  app.handleError = function (err, opts) {
    const o = opts || {};
    const c = G.api.classify(err);
    if (c.view === 'signin') { app.requireSignin(); return; }
    if (c.view === 'message') { app.showFailure(c.title, c.text); return; }
    if (err && err.code === 'conflict') { app.reloadAfterConflict(c.text); return; }
    if (o.pageAlert) { state.pageAlert = c.text; render(); return; }
    if (o.sinkId) G.ui.setText(o.sinkId, c.text);
  };

  // 409 conflict: a guarded write lost a race. Show the server's message and re-read what the page shows.
  app.reloadAfterConflict = function (text) {
    const r = G.router.parse(window.location.hash);
    const jobs = [loadMe()];
    if (r.gid) {
      jobs.push(fetchGuild(r.gid));
      if (r.name === 'settings' && r.tab === 'people') {
        jobs.push(G.api.get('/api/guild/' + encodeURIComponent(r.gid) + '/people').then(function (res) { state.people[r.gid] = res; return res; }));
      }
    }
    return Promise.all(jobs.map(function (p) { return p.catch(function () { return null; }); })).then(function () {
      state.pageAlert = text;
      render();
    });
  };

  app.refreshGuild = function (gid) {
    return fetchGuild(gid).then(function () { render(); }, function () { /* the mutation already worked; keep the old copy */ });
  };

  app.afterGuildCreated = function (res, noticeText) {
    state.guilds[res.guild.id] = res;
    state.notice = noticeText;
    loadMe().then(function () {
      go(G.router.format({ name: 'settings', gid: res.guild.id, tab: 'people' }));
    });
  };

  app.afterGuildClaimed = function (res, guildName) {
    app.afterGuildCreated(res, 'You are now Guild Master of ' + guildName + '.');
  };

  app.afterAccountDeleted = function () {
    resetSession();
    state.signinNotice = 'Your data has been deleted.';
    go('#/', true);
  };

  function signOut() {
    const done = function () {
      resetSession();
      go('#/', true);
    };
    G.api.post('/auth/logout', {}).then(done, done);
  }

  // ── event handlers ──
  function closeMenu(refocus) {
    const menu = document.getElementById('gs-account-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const btn = root && root.querySelector('[data-action="toggle-menu"]');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
  }

  G.handlers.click['toggle-menu'] = function (btn) {
    const menu = document.getElementById('gs-account-menu');
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const first = menu.querySelector('[role="menuitem"]'); if (first) first.focus(); }
  };

  G.handlers.click['toggle-sidebar'] = function () {
    if (!state.me) return;
    const next = !prefs().sidebarCollapsed;
    state.me.user.prefs = Object.assign({}, prefs(), { sidebarCollapsed: next });
    render();
    patchPrefs({ sidebarCollapsed: next });
  };

  G.handlers.click['open-drawer'] = function () {
    const d = document.getElementById('gs-drawer');
    if (d && !d.open && d.showModal) d.showModal();
  };

  G.handlers.click['close-drawer'] = function () {
    const d = document.getElementById('gs-drawer');
    if (d && d.open) d.close();
  };

  G.handlers.click['sign-out'] = signOut;
  G.handlers.click.retry = function () { go(normalizedHash()); };

  G.handlers.change['team-pick'] = function (sel) {
    const gid = state.currentGid;
    if (!gid) return;
    state.teamByGuild[gid] = sel.value;
    try { window.localStorage.setItem(TEAM_KEY + gid, sel.value); } catch (e) { /* storage may be blocked */ }
    const drawer = document.getElementById('gs-drawer');
    if (drawer && drawer.open) drawer.close();
    render();
  };

  function dispatch(kind, attr, ev) {
    const t = ev.target;
    if (!t || !t.closest) return false;
    const el = t.closest('[' + attr + ']');
    if (!el) return false;
    const fn = G.handlers[kind][el.getAttribute(attr)];
    if (!fn) return false;
    if (kind === 'click') app.lastActionEl = el;
    fn(el, ev);
    return true;
  }

  function onClick(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('.gs-account')) closeMenu(false);
    else if (t.closest('.gs-menu a')) closeMenu(false);
    if (t.closest('.gs-drawer a')) G.handlers.click['close-drawer']();
    dispatch('click', 'data-action', ev);
  }

  function onKeydown(ev) {
    const menu = document.getElementById('gs-account-menu');
    if (!menu || menu.hidden) return;
    if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(true); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
      if (!items.length) return;
      ev.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next = ev.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[next].focus();
    }
  }

  function onSubmit(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    const form = t.closest('[data-submit]');
    if (!form) return;
    ev.preventDefault();
    const fn = G.handlers.submit[form.getAttribute('data-submit')];
    if (fn) fn(form, ev);
  }

  app.start = function () {
    root = document.getElementById('guild-root');
    if (!root) return;
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', function (ev) { dispatch('change', 'data-change', ev); });
    document.addEventListener('input', function (ev) { dispatch('input', 'data-input', ev); });
    window.addEventListener('hashchange', route);
    route();
  };

  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('guild-root')) app.start();
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
