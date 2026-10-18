// ── GUILD APP (state, routing, events) ──────────────────────────
// The app shell around the planner. routeAll() picks the section from the address (planner, guild or a static help
// page), asks /auth/me only when it can matter, fetches what a guild route needs, and renders the shell's slots
// (the page modules build HTML strings, every data string escaped) into the page skeleton. It never replaces the
// planner's markup. Delegated events go to G.handlers. Runs on index.html, faq.html and whats-new.html (it needs
// #guild-root); tests load the pure modules without it.
(function (G) {
  'use strict';

  const TEAM_KEY = 'raidsmith.guild.team.';
  const HINT_KEY = 'raidsmith.shell.signedIn';
  const COLLAPSE_KEYS = { default: 'raidsmith.shell.sidebarCollapsed', plan: 'raidsmith.shell.planSidebarCollapsed' };
  const COLLAPSE_PREFS = { default: 'sidebarCollapsed', plan: 'planSidebarCollapsed' };
  const COLLAPSE_DEFAULTS = { default: false, plan: true };
  const SESSION_TIMEOUT_MS = 3000;
  const NAV_CLICK_WINDOW_MS = 1000;
  const ATTENTION_MAX_AGE_MS = 60000; // the Home count is read again on a guild route change once it is older than this
  // Actions the planner's own markup may carry too (the compact home's "How it works" link).
  const SHARED_ACTIONS = ['open-planner', 'how-it-works'];
  const SCOPED_SLOTS = ['shell-rail', 'shell-sidebar', 'shell-topbar-lead', 'shell-topbar-account', 'shell-banner', 'shell-tabs', 'shell-drawer', 'gs-main', 'planner-notice', 'guild-dialogs'];

  const state = {
    page: 'app',       // body[data-page]: 'app' (index.html) | 'faq' | 'whats-new'
    section: null,     // 'planner' | 'guild' | 'page' (null until the first routeAll)
    asked: false,      // /auth/me has been asked this page load
    lastGid: null,     // the guild the guild section showed last (the planner / help pages draw its nav)
    chromeTried: {},   // gid -> true: the planner / help pages fetched this guild already
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
    roster: null,      // { gid, teamId, data } - GET /roster?team= for the open roster page
    rosterUi: { sort: { column: G.rosterSort.DEFAULT_SORT.column, dir: G.rosterSort.DEFAULT_SORT.dir }, role: 'all', status: 'active', query: '' },
    rosterNotice: '',
    person: null,      // { gid, pid, record } - GET /roster/p_... for the open person record
    linkable: {},      // gid -> [person] from GET /roster/linkable
    imports: {},       // 'rh' | 'wcl' -> the import page's state (see pages-import.js)
    att: {},           // the attendance pages' state, one key per page module (see pages-attendance.js and its siblings)
    roadmap: null,     // the Future enhancements page's state: filter, form draft, submitted ideas (see pages-roadmap.js)
    providers: null,   // GET /auth/providers: which sign-in buttons the sign-in page shows ({ discord, bnet }), read once while signed out
    bnet: null,        // Linked accounts / My characters: { data: GET /auth/bnet, notice, alert } (see pages-bnet.js)
    bnetSettings: null, // Guild settings > Battle.net: { gid, data: GET /api/guild/:gid/bnet, notice } (see pages-settings-bnet.js)
    attention: {},     // gid -> { data: GET /api/guild/:gid/attention (or null), at: ms }: the Home count for the nav badge (the Home page keeps its own copy in att.attention)
    rolesSettings: null, // Guild settings > Roles: { gid, data: GET /api/guild/:gid/roles, notice } (see pages-settings-roles.js)
    discordSettings: null, // Guild settings > Discord roles: { gid, data: GET /api/guild/:gid/discord, notice } (see pages-settings-discord.js)
    guestSettings: null, // Guild settings > Guest links: { gid, data: GET /api/guild/:gid/guest-links, notice }; the token is never kept here (see pages-settings-guests.js)
    publicSettings: null, // Guild settings > Public page: { gid, data: GET /api/guild/:gid/public, notice } (see pages-settings-public.js)
    rolesList: {},     // gid -> GET /api/guild/:gid/roles, for the People page's "Other roles" (loaded with the People tab for people who can manage roles)
    view: null,        // the read-only guest / public page: { kind, gid, data, error } (see pages-view.js); null while it loads
  };
  const app = G.app = { state: state, started: false };
  // The Guild settings tabs of Phase 7: the state key each keeps its { gid, data, notice } in, and the page module in G.pages that loads and draws it.
  const ROLE_TABS = {
    roles: { state: 'rolesSettings', page: 'settingsRoles' },
    discord: { state: 'discordSettings', page: 'settingsDiscord' },
    guests: { state: 'guestSettings', page: 'settingsGuests' },
    public: { state: 'publicSettings', page: 'settingsPublic' },
  };
  // Attendance pages by route: the module in G.pages that loads (load(r, gd) -> Promise|null) and draws (main(r, gd, ctx)) it.
  const ATT_ROUTE_PAGES = { raidnew: 'raidNew', raid: 'raid', review: 'review', backfill: 'backfill', personatt: 'personAtt', lootperson: 'personLoot', away: 'away' };
  function attPageKey(r) {
    if (r.name === 'section') return r.section === 'raids' ? 'raids' : (r.section === 'attendance' ? 'attendance' : (r.section === 'loot' ? 'loot' : (r.section === 'home' ? 'attention' : null)));
    if (r.name === 'settings') return r.tab === 'attendance' ? 'settingsAtt' : (r.tab === 'loot' ? 'settingsLoot' : (r.tab === 'schedule' ? 'settingsSchedule' : (r.tab === 'activity' ? 'settingsActivity' : null)));
    return Object.prototype.hasOwnProperty.call(ATT_ROUTE_PAGES, r.name) ? ATT_ROUTE_PAGES[r.name] : null;
  }
  app.attPageKey = attPageKey;
  let root = null;
  let routeToken = 0;
  let firstRender = true;
  let zoneCache = null;
  let lastHref = null;
  let sessionPromise = null;
  let originalTitle = '';
  let lastNavClickAt = 0;     // a plain click on a link just happened (its popstate is a navigation, not Back / Forward)
  let lastCollapseContext = null;
  let sessionGen = 0;         // bumped by resetSession: an answer that arrives after a sign-out is dropped
  const attentionReads = {};  // gid -> the GET /attention in flight

  // ── small browser helpers (each guarded: storage may be blocked, the planner may be absent) ──
  function byId(id) { return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null; }
  function storageGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* storage may be blocked */ } }
  function storageRemove(key) { try { window.localStorage.removeItem(key); } catch (e) { /* storage may be blocked */ } }
  function plannerShell() { return typeof window !== 'undefined' && window.PP && window.PP.shell ? window.PP.shell : null; }
  function bodyAttr(name) { return document.body && document.body.getAttribute ? document.body.getAttribute(name) : null; }
  function hasHint() { return storageGet(HINT_KEY) === '1'; }
  function setHint(on) { if (on) storageSet(HINT_KEY, '1'); else storageRemove(HINT_KEY); }

  function whatsNewUnseen() {
    try { return typeof whatsNewSeen === 'function' && !whatsNewSeen(window.localStorage); } catch (e) { return false; }
  }

  function withTimeout(promise, ms) {
    if (!ms) return promise;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new G.api.ApiError(0, null)); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // ── data ──
  function loadMe(timeoutMs) {
    return withTimeout(G.api.get('/auth/me'), timeoutMs).then(function (me) {
      state.me = me;
      state.loaded = true;
      state.bootError = '';
      if (me && me.user) setHint(true);
      return me;
    }, function (err) {
      if (err.status === 401) { state.me = null; state.loaded = true; setHint(false); return null; }
      if (!state.loaded) { state.loaded = true; state.bootError = G.api.classify(err).text; }
      return null;
    });
  }

  // Ends the pre-session look. A visit that arrived on #how-it-works scrolled while the landing's guide was still
  // hidden by the pending state (nothing to scroll to), so it scrolls again now that the guide shows.
  function finishPending() {
    if (typeof document === 'undefined' || !document.body) return;
    const wasPending = document.body.classList.contains('shell-pending');
    document.body.classList.remove('shell-pending');
    if (!wasPending || state.section !== 'planner' || window.location.hash !== '#how-it-works') return;
    const shell = plannerShell();
    if (shell && shell.howItWorks) shell.howItWorks();
  }

  // Asks /auth/me only when it can matter: a guild route (need) or a browser that signed in before (the hint).
  // An anonymous planner or help-page visit never reaches the Worker. The answer is asked once per page load.
  function ensureSession(need) {
    if (state.asked) return sessionPromise || Promise.resolve();
    if (!need && !hasHint()) {
      state.me = null;
      state.loaded = true;
      finishPending();
      return Promise.resolve();
    }
    state.asked = true;
    sessionPromise = loadMe(SESSION_TIMEOUT_MS).then(finishPending, finishPending);
    return sessionPromise;
  }

  // The sign-in page offers Discord always and Battle.net where the server is set up for it. A failed read leaves Discord alone on the card.
  function ensureProviders() {
    if (state.providers) return Promise.resolve();
    return G.api.get('/auth/providers').then(function (res) {
      if (res && typeof res === 'object') state.providers = { discord: res.discord !== false, bnet: res.bnet === true };
    }, function () { /* the card shows the Discord button */ });
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

  // The guild the planner and help pages draw in the nav: the one the guild section showed last, else the
  // person's last guild, else the first.
  function chromeGuildId() {
    const guilds = state.me && Array.isArray(state.me.guilds) ? state.me.guilds : [];
    if (!guilds.length) return null;
    if (state.lastGid && guilds.some(function (g) { return g.id === state.lastGid; })) return state.lastGid;
    const last = prefs().lastGuildId;
    return (guilds.filter(function (g) { return g.id === last; })[0] || guilds[0]).id;
  }

  // Signed in with guilds: fetch that guild once so Roster, its trial badge and Guild settings appear on the planner
  // and the help pages. Until it answers, or if it fails, the nav shows the no-guild items (never an error).
  function ensureChromeGuild() {
    const gid = state.me ? chromeGuildId() : null;
    if (!gid || state.guilds[gid] || state.chromeTried[gid]) return Promise.resolve();
    state.chromeTried[gid] = true;
    return fetchGuild(gid).then(function () {
      // A guild section draws #gs-main itself (a re-render could wipe typed form input) and does not use this guild.
      if (state.section !== 'guild') render();
      ensureAttention(gid, false); // the Home badge, once it arrives
    }, function () { /* the nav stays as it is */ });
  }

  // ── team choice (per-viewer convenience) ──
  function teamFor(gd) {
    const gid = gd.guild.id;
    const active = G.shell.activeTeams(gd.teams);
    if (!active.length) return null;
    let id = state.teamByGuild[gid];
    if (id === undefined) id = storageGet(TEAM_KEY + gid);
    if (!active.some(function (t) { return t.id === id; })) id = active[0].id;
    state.teamByGuild[gid] = id;
    return id;
  }

  function rememberTeam(gid, teamId) {
    state.teamByGuild[gid] = teamId;
    storageSet(TEAM_KEY + gid, teamId);
  }

  // Picks the team the guild pages work on (what the sidebar picker does); false when it is not one of the guild's active teams.
  function selectTeam(gid, teamId) {
    const gd = state.guilds[gid];
    if (!gd || !G.shell.activeTeams(gd.teams).some(function (t) { return t.id === teamId; })) return false;
    rememberTeam(gid, teamId);
    return true;
  }

  // ── needs attention (Home): the count behind the nav badge ──
  // GET /attention for people who can act on its items, kept per guild as { data, at }. It is read after the guild loads without holding the page
  // back, again whenever the Home page opens (the page does that itself), and on a guild route change once the copy is older than a minute.
  // A failed read keeps the last answer and is not tried again before the minute is up.
  function attentionCountFor(gid) {
    const e = state.attention[gid];
    const n = e && e.data ? Number(e.data.total) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function setAttention(gid, data) {
    const before = attentionCountFor(gid);
    state.attention[gid] = { data: data, at: Date.now() };
    if (attentionCountFor(gid) !== before) renderNav();
  }

  function ensureAttention(gid, force) {
    const gd = state.guilds[gid];
    if (!gd || !G.shell.canSeeAttention(gd.me && gd.me.can)) return Promise.resolve(null);
    const known = state.attention[gid];
    if (!force && known && Date.now() - known.at < ATTENTION_MAX_AGE_MS) return Promise.resolve(null);
    if (attentionReads[gid]) return attentionReads[gid];
    const gen = sessionGen;
    const read = G.api.attention.get(gid).then(function (data) {
      if (gen === sessionGen) setAttention(gid, data);
      return null;
    }, function () {
      if (gen === sessionGen) state.attention[gid] = { data: known ? known.data : null, at: Date.now() };
      return null;
    }).then(function () { delete attentionReads[gid]; return null; });
    attentionReads[gid] = read;
    return read;
  }

  // Whether the viewer's roster.edit reaches this team ('guild' or a list of team ids).
  function canEditTeam(gd, teamId) {
    const v = gd && gd.me && gd.me.can ? gd.me.can['roster.edit'] : null;
    return v === 'guild' || (Array.isArray(v) && v.indexOf(teamId) >= 0);
  }

  // ── sidebar collapse ──
  // Two contexts, each remembered on its own: `plan` (the planner section with a plan open) and `default`.
  function collapseContext() {
    return state.section === 'planner' && bodyAttr('data-planner-view') === 'app' ? 'plan' : 'default';
  }

  // Signed in: the server pref. Otherwise (signed out, or the session question still open) the local key, so the
  // first paint has no width jump. No stored choice: sidebarCollapsed is false, planSidebarCollapsed is true.
  function collapsedFor(context) {
    if (state.me && state.me.user) {
      const v = prefs()[COLLAPSE_PREFS[context]];
      if (typeof v === 'boolean') return v;
    }
    const local = storageGet(COLLAPSE_KEYS[context]);
    if (local === '1') return true;
    if (local === '0') return false;
    return COLLAPSE_DEFAULTS[context];
  }

  // ── navigation ──
  function sectionFor() {
    if (state.page !== 'app') return 'page';
    const hash = String(window.location.hash || '');
    return hash.indexOf('#/') === 0 && G.router.parse(hash).name !== 'planner' ? 'guild' : 'planner';
  }

  // The planner opened for a raid (#/planner?raid=<gid>.<rid>) hands the raid to the planner (RaidContext in js/app.js), which
  // loads the plan and shows its banner; any other address leaves the raid. A no-op where the planner is not on the page.
  function syncRaidContext() {
    if (typeof RaidContext === 'undefined' || !RaidContext || typeof RaidContext.route !== 'function') return;
    RaidContext.route(String(window.location.hash || ''));
  }

  function go(hash, replace) {
    if (window.location.hash === hash) { routeAll({ force: true }); return; }
    if (replace && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
      routeAll({ force: true });
      return;
    }
    window.location.hash = hash;
  }

  function resetSession() {
    state.me = null;
    state.guilds = {};
    state.people = {};
    state.chromeTried = {};
    state.lastGid = null;
    state.att = {};
    state.roadmap = null;
    state.bnet = null;
    state.bnetSettings = null;
    state.attention = {};
    sessionGen++;
    state.rolesSettings = null;
    state.discordSettings = null;
    state.guestSettings = null;
    state.publicSettings = null;
    state.rolesList = {};
    state.view = null;
    state.imports = {};
    state.failure = null;
    state.notice = '';
    setHint(false);
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

  // A route change leaves nothing open behind it: the guild dialogs, the phone drawer and the avatar menu. The
  // planner's own dialogs are the planner's (PP.shell.setActive closes them). `doc` is injectable for tests.
  function closeOverlays(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return;
    const open = d.querySelectorAll('#shell-drawer dialog[open], #guild-dialogs dialog[open]');
    for (let i = 0; i < open.length; i++) open[i].close();
    const menu = d.getElementById('gs-account-menu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      const btn = d.querySelector('[data-action="toggle-menu"]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  // The one router. Computes the section from the address and runs on load, hashchange and popstate. Idempotent: a
  // hash-link click fires popstate then hashchange, and the second call (same address) returns at once, unless
  // called with { force: true } (an unchanged address that still needs a pass, such as Retry). { history: true }
  // marks Back / Forward (no scroll or focus move).
  function routeAll(opts) {
    const o = opts || {};
    const href = String(window.location.href);
    if (!o.force && href === lastHref) return Promise.resolve();
    lastHref = href;
    const prev = state.section;
    const section = sectionFor();
    state.section = section;
    if (document.body) {
      ['planner', 'guild', 'page'].forEach(function (name) { document.body.classList.toggle('shell-section-' + name, name === section); });
    }
    showSection(section);
    syncRaidContext();
    if (section === 'guild') {
      if (prev && prev !== 'guild' && !o.history && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      return routeGuild();
    }
    return routePlainSection(section, prev, o);
  }

  function showSection(section) {
    const main = byId('gs-main');
    const planner = byId('planner-root');
    const shell = plannerShell();
    if (section === 'guild') {
      if (main) main.hidden = false;
      if (planner) planner.hidden = true;
      if (shell && shell.setActive) shell.setActive(false);
      return;
    }
    if (main) main.hidden = true;
    if (section === 'planner') {
      if (planner) planner.hidden = false;
      if (shell && shell.setActive) shell.setActive(true);
    }
  }

  function isDisplayed(el) {
    return !!el && (!el.getClientRects || el.getClientRects().length > 0);
  }

  // The planner's focus target on a section switch: the compact home's h2, else the sr-only h1 (landing) or the
  // title-bar h1 (plan view). A target that is not displayed (the title bar's h1 on a phone) cannot take focus, so
  // the next one is tried, and the planner root last.
  function focusPlannerTarget() {
    const shell = plannerShell();
    const view = shell && shell.view ? shell.view() : 'landing';
    const selectors = [];
    if (view === 'app') {
      selectors.push('#shell-topbar-plan h1');
    } else {
      const cl = document.body.classList;
      if (!cl.contains('is-signed-out') && !cl.contains('landing-full')) selectors.push('#planner-root h2[tabindex="-1"]');
      selectors.push('#planner-root h1');
    }
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (isDisplayed(el) && el.focus) { el.focus(); return; }
    }
    const planner = byId('planner-root');
    if (!planner || !planner.focus) return;
    if (!planner.getAttribute('tabindex')) planner.setAttribute('tabindex', '-1');
    planner.focus();
  }

  // Planner section or a static help page: draw the chrome now, ask the session if it can matter, then draw again.
  function routePlainSection(section, prev, o) {
    const token = ++routeToken;
    closeOverlays();
    if (section === 'planner') {
      const shell = plannerShell();
      const guide = window.location.hash === '#how-it-works';
      document.title = originalTitle;
      // How it works scrolls to its own section: the top-of-page scroll and the heading focus of a section switch
      // would undo it.
      if (guide) {
        if (shell && shell.howItWorks) shell.howItWorks();
      } else if (prev && prev !== 'planner' && !o.history) {
        if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
        focusPlannerTarget();
      }
    }
    render();
    return ensureSession(false).then(function () {
      if (token !== routeToken) return null;
      render();
      return ensureChromeGuild();
    });
  }

  function routeGuild() {
    const token = ++routeToken;
    closeOverlays();
    const r = G.router.parse(window.location.hash);
    state.failure = null;
    state.pageAlert = '';
    state.privacyMessage = r.name === 'privacy' ? state.privacyMessage : '';
    state.currentGid = r.gid || null;
    if (!(r.name === 'settings' && r.tab === 'people')) state.notice = '';
    if (!(r.name === 'section' && r.section === 'roster')) state.rosterNotice = '';
    if (G.router.isViewerRoute(r)) return routeViewer(r, token);

    // A visit that skipped the session question (an anonymous planner view) asks it now.
    if (!state.asked) state.loaded = false;
    const ready = state.loaded ? Promise.resolve() : (render(), ensureSession(true));
    return ready.then(function () {
      if (token !== routeToken) return null;
      if (state.bootError) return null;
      if (!state.me) return ensureProviders();
      return resolveSignedIn(r, token);
    }).then(function () {
      if (token !== routeToken) return;
      closeOverlays(); // a dialog opened while this route loaded (or restored by Back) must not outlive it
      render(true);
    });
  }

  // A guest link, the guest view and a public page: read-only pages for people with no account. The page never waits for the sign-in question and
  // never sends anyone to the sign-in card: the visitor gets the view at once, and /auth/me is asked quietly so a signed-in member's avatar shows.
  function routeViewer(r, token) {
    state.currentGid = null;
    state.view = null;
    render();
    ensureSession(true).then(function () { if (token === routeToken) render(); });
    return G.pages.view.load(r).then(function () {
      if (token !== routeToken) return;
      // A redeemed guest link moved the address to #/view without a navigation: it is the current address now.
      lastHref = String(window.location.href);
      closeOverlays();
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
      window.history.replaceState(null, '', window.location.pathname + window.location.search + G.router.format({ name: 'section', gid: target.id, section: 'home' }));
      return routeAll({ force: true });
    }
    if (r.name === 'privacy') {
      return loadMe().then(function () { return null; });
    }
    if (r.name === 'roadmap') {
      // The roadmap shows at once and the submitted ideas fill in beside it. It has no guild: the nav is the last guild's, as on the planner.
      G.pages.roadmap.load();
      return ensureChromeGuild().then(function () { return null; });
    }
    if (r.name === 'linked' || r.name === 'characters') {
      // Battle.net (Phase 5): no guild of its own, so the nav is the last guild's. The page reads GET /auth/bnet fresh on every visit.
      return Promise.all([G.pages.bnet.load(), r.name === 'linked' ? loadMe() : null]).then(function () { return ensureChromeGuild(); }).then(function () { return null; }).catch(function (err) {
        if (token !== routeToken) return null;
        handleLoadError(err);
        return null;
      });
    }
    if (!r.gid) return null;

    state.currentGid = r.gid;
    const needFetch = !state.guilds[r.gid] || r.name === 'settings';
    const loadGuild = needFetch ? fetchGuild(r.gid) : Promise.resolve(state.guilds[r.gid]);
    return loadGuild.then(function (gd) {
      if (token !== routeToken) return null;
      state.lastGid = r.gid;
      if (prefs().lastGuildId !== r.gid) {
        if (state.me && state.me.user) state.me.user.prefs = Object.assign({}, prefs(), { lastGuildId: r.gid });
        patchPrefs({ lastGuildId: r.gid });
      }
      const onHome = r.name === 'section' && r.section === 'home';
      if (onHome && !G.shell.canSeeAttention(gd.me && gd.me.can)) {
        // Home is for people who can act on its items; everyone else starts on Roster.
        window.history.replaceState(null, '', window.location.pathname + window.location.search + G.router.format({ name: 'section', gid: r.gid, section: 'roster' }));
        return routeAll({ force: true });
      }
      if (!onHome) ensureAttention(r.gid, false); // the Home page reads it fresh itself
      if (r.name === 'section' && r.section === 'roster') return loadRoster(r, gd, token);
      if (r.name === 'person') return loadPerson(r, gd, token);
      if (r.name === 'import') return loadImport(r, gd, token);
      const attKey = attPageKey(r);
      if (attKey && r.name !== 'settings') return loadAttendance(attKey, r, gd);
      if (r.name !== 'settings') return null;
      const tabs = G.shell.settingsTabs(gd.me && gd.me.can, gd.me && gd.me.roles);
      if (!tabs.length) { failWith('You cannot open this', 'Guild settings are for the people who run the guild.', false); return null; }
      let tab = r.tab;
      if (!tab) {
        tab = tabs[0].tab;
        window.history.replaceState(null, '', window.location.pathname + window.location.search + G.router.format({ name: 'settings', gid: r.gid, tab: tab }));
      }
      if (!tabs.some(function (t) { return t.tab === tab; })) { failWith('You cannot open this', 'Your role does not include this part of Guild settings.', false); return null; }
      if (tab === 'attendance') return loadAttendance('settingsAtt', r, gd);
      if (tab === 'loot') return loadAttendance('settingsLoot', r, gd);
      if (tab === 'battlenet') return G.pages.settingsBnet.load(r.gid).then(function () { return null; });
      if (tab === 'schedule') return loadAttendance('settingsSchedule', r, gd);
      if (tab === 'activity') return loadAttendance('settingsActivity', r, gd);
      if (Object.prototype.hasOwnProperty.call(ROLE_TABS, tab)) return G.pages[ROLE_TABS[tab].page].load(r.gid).then(function () { return null; });
      if (tab !== 'people') return null;
      const jobs = [G.api.get('/api/guild/' + encodeURIComponent(r.gid) + '/people').then(function (res) { state.people[r.gid] = res; })];
      // The Edit roles dialog lists the guild's own roles; a failed read only leaves them out of the dialog.
      if (G.shell.hasAction(gd.me && gd.me.can, 'guild.roles')) {
        jobs.push(G.api.roles.list(r.gid).then(function (res) { state.rolesList[r.gid] = res; }, function () { /* the dialog shows no Other roles */ }));
      }
      return Promise.all(jobs).then(function () { return null; });
    }).catch(function (err) {
      if (token !== routeToken) return null;
      handleLoadError(err);
      return null;
    });
  }

  // ── attendance routes ──
  // The page module reads what it needs (it may reject with an ApiError, which the route's catch turns into a message).
  function loadAttendance(key, r, gd) {
    const page = G.pages[key];
    if (!page || typeof page.load !== 'function') return null;
    return Promise.resolve(page.load(r, gd)).then(function () { return null; });
  }

  // ── roster routes ──
  function rosterUrl(gid, tail) { return '/api/guild/' + encodeURIComponent(gid) + '/roster' + (tail || ''); }

  // Flagged-trial count for a team's badge: people whose home team is that team (the Worker sends it for editors only).
  function setFlagFromRoster(gd, teamId, data) {
    if (!gd || !data || !data.can || !data.can.edit) return;
    gd.rosterFlags = Object.assign({}, gd.rosterFlags);
    gd.rosterFlags[teamId] = G.rosterSort.trialsToDecide(data.people, teamId).length;
  }

  function fetchRoster(gid, teamId) {
    return G.api.get(rosterUrl(gid, '?team=' + encodeURIComponent(teamId))).then(function (data) {
      state.roster = { gid: gid, teamId: teamId, data: data };
      setFlagFromRoster(state.guilds[gid], teamId, data);
      return data;
    });
  }

  function loadRoster(r, gd, token) {
    const gid = gd.guild.id;
    const teamId = r.team || teamFor(gd);
    if (!teamId) { state.roster = { gid: gid, teamId: null, data: null }; return null; }
    if (state.roster && state.roster.teamId !== teamId) {
      state.rosterUi.role = 'all'; state.rosterUi.status = 'active'; state.rosterUi.query = '';
    }
    return fetchRoster(gid, teamId).then(function () { return null; }).catch(function (err) {
      if (token !== routeToken) return null;
      handleLoadError(err);
      return null;
    });
  }

  function loadPerson(r, gd, token) {
    const gid = gd.guild.id;
    return G.api.get(rosterUrl(gid, '/' + encodeURIComponent(r.pid))).then(function (record) {
      if (token !== routeToken) return null;
      state.person = { gid: gid, pid: r.pid, record: record };
      const card = Promise.all([G.pages.personAtt.loadCard(gid, r.pid, gd), G.pages.personLoot.loadCard(gid, r.pid), G.pages.personTrial.loadCard(gid, r.pid, gd, record)]);
      if (!(record.can && record.can.edit)) return card.then(function () { return null; });
      return Promise.all([card, G.pages.roster.loadLinkable(gid)]).then(function () { return null; });
    }).catch(function (err) {
      if (token !== routeToken) return null;
      state.person = null;
      handleLoadError(err);
      return null;
    });
  }

  function loadImport(r, gd, token) {
    const gid = gd.guild.id;
    const teamId = teamFor(gd);
    if (!teamId || !canEditTeam(gd, teamId)) {
      failWith('You cannot open this', 'Importing is for the officers and team leads of this team.', false);
      return null;
    }
    if (r.source === 'bnet') {
      // The Battle.net page first reads the guild's settings (is it set up, is the version supported, which guild and realm will be read).
      const bnet = G.pages.importBnet.ensureState(gid, teamId);
      return G.pages.importBnet.loadInfo(bnet).then(function () { return null; });
    }
    const kind = r.source === 'wcl' ? 'wcl' : 'rh';
    G.pages.import.ensureState(kind, gid, teamId);
    if (kind !== 'wcl') return null;
    // The "Add as Alt of someone else" picker lists this team's people.
    return fetchRoster(gid, teamId).then(function () { return null; }, function () {
      if (token === routeToken) state.roster = null;
      return null;
    });
  }

  // ── rendering ──
  function titleFor(r, gd) {
    const base = 'Raidsmith guild';
    let page = '';
    if (r.name === 'privacy') page = 'Privacy & my data';
    else if (r.name === 'roadmap') page = 'Future enhancements';
    else if (r.name === 'linked') page = 'Linked accounts';
    else if (r.name === 'characters') page = 'My characters';
    else if (r.name === 'new') page = 'Create a guild';
    else if (r.name === 'section') page = { home: 'Home', roster: 'Roster', raids: 'Raids', attendance: 'Attendance', loot: 'Loot' }[r.section] || '';
    else if (r.name === 'raidnew') page = 'New raid';
    else if (r.name === 'away') page = 'Away notices';
    else if (r.name === 'raid') page = 'Raid';
    else if (r.name === 'review') page = 'Review queue';
    else if (r.name === 'backfill') page = 'Backfill from Warcraft Logs';
    else if (r.name === 'personatt') page = 'Attendance history';
    else if (r.name === 'lootperson') page = 'Loot history';
    else if (r.name === 'person') page = 'Roster';
    else if (r.name === 'import') page = { wcl: 'Import from Warcraft Logs', bnet: 'Import from Battle.net' }[r.source] || 'Import from Raid-Helper';
    else if (r.name === 'settings') page = 'Guild settings';
    else if (r.name === 'guest' || r.name === 'view') page = 'Guest view';
    else if (r.name === 'public') page = 'Public page';
    if (gd && gd.guild && page) page += ' - ' + gd.guild.name;
    else if (G.router.isViewerRoute(r) && state.view && state.view.data && state.view.data.guild) page += ' - ' + state.view.data.guild.name;
    return page ? page + ' - ' + base : base;
  }

  function timeZones() {
    if (!zoneCache) zoneCache = G.pages.create.allTimeZones();
    return zoneCache;
  }

  function rosterMain(gd) {
    const P = G.pages;
    const rs = state.roster;
    if (!rs || rs.gid !== gd.guild.id) return P.signin.loadingHtml();
    if (!rs.data) return P.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return P.roster.rosterHtml({ guildData: gd, data: rs.data, view: state.rosterUi, notice: state.rosterNotice, alert: state.pageAlert });
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
      case 'roadmap':
        return P.roadmap.roadmapHtml({ me: state.me, view: P.roadmap.viewState() });
      case 'linked':
        return P.bnet.linkedHtml({ data: state.bnet ? state.bnet.data : null, me: state.me, error: r.error, notice: state.bnet ? state.bnet.notice : '', alert: state.bnet ? state.bnet.alert : '' });
      case 'characters':
        return P.bnet.charactersHtml({ data: state.bnet ? state.bnet.data : null, notice: state.bnet ? state.bnet.notice : '', alert: state.bnet ? state.bnet.alert : '' });
      case 'section':
        if (!gd) return P.signin.loadingHtml();
        if (r.section === 'home') return P.attention.main(r, gd, ctx);
        if (r.section === 'roster') return rosterMain(gd);
        if (r.section === 'raids') return P.raids.main(r, gd, ctx);
        if (r.section === 'attendance') return P.attendance.main(r, gd, ctx);
        if (r.section === 'loot') return P.loot.main(r, gd, ctx);
        return P.signin.messageHtml('Page not found', 'That address does not match a Raidsmith guild page.', {});
      case 'raidnew': case 'raid': case 'review': case 'backfill': case 'personatt': case 'lootperson': case 'away':
        if (!gd) return P.signin.loadingHtml();
        return P[attPageKey(r)].main(r, gd, ctx);
      case 'person': {
        if (!gd || !state.person || state.person.gid !== gd.guild.id || state.person.pid !== r.pid) return P.signin.loadingHtml();
        return P.person.personHtml({ guildData: gd, record: state.person.record, linkable: state.linkable[gd.guild.id] || null, alert: state.pageAlert, attendance: P.personAtt.cardState(gd.guild.id, r.pid), trial: P.personTrial.cardState(gd.guild.id, r.pid), away: P.away.personCardHtml({ guildData: gd, record: state.person.record, state: P.attendance.attState().awayPerson }) });
      }
      case 'import': {
        if (!gd) return P.signin.loadingHtml();
        if (r.source === 'bnet') {
          const bnet = state.imports.bnet;
          return bnet && bnet.gid === gd.guild.id ? P.importBnet.bnetHtml({ guildData: gd, bnet: bnet }) : P.signin.loadingHtml();
        }
        const kind = r.source === 'wcl' ? 'wcl' : 'rh';
        const imp = state.imports[kind];
        if (!imp || imp.gid !== gd.guild.id) return P.signin.loadingHtml();
        if (kind === 'rh') return P.import.raidHelperHtml({ guildData: gd, rh: imp });
        const people = state.roster && state.roster.gid === gd.guild.id && state.roster.teamId === imp.teamId && state.roster.data
          ? state.roster.data.people.filter(function (p) { return p.main && p.main.team && p.main.team.id === imp.teamId; }) : [];
        return P.import.wclHtml({ guildData: gd, wcl: imp, people: people });
      }
      case 'settings': {
        if (!gd) return P.signin.loadingHtml();
        const tab = r.tab;
        if (tab === 'teams') return G.shell.settingsFrameHtml(ctx, 'teams', P.teams.teamsHtml({ guildData: gd, alert: state.pageAlert }));
        if (tab === 'attendance') return P.settingsAtt.main(r, gd, ctx);
        if (tab === 'loot') return P.settingsLoot.main(r, gd, ctx);
        if (tab === 'battlenet') {
          const x = state.bnetSettings;
          if (!x || x.gid !== gd.guild.id) return P.signin.loadingHtml();
          return G.shell.settingsFrameHtml(ctx, 'battlenet', P.settingsBnet.settingsHtml({ guildData: gd, data: x.data, alert: state.pageAlert, notice: x.notice }));
        }
        if (tab === 'schedule') return P.settingsSchedule.main(r, gd, ctx);
        if (tab === 'activity') return P.settingsActivity.main(r, gd, ctx);
        if (tab === 'data') return P.settingsData.main(r, gd, ctx);
        if (Object.prototype.hasOwnProperty.call(ROLE_TABS, tab)) {
          const x = state[ROLE_TABS[tab].state];
          if (!x || x.gid !== gd.guild.id) return P.signin.loadingHtml();
          return G.shell.settingsFrameHtml(ctx, tab, P[ROLE_TABS[tab].page].settingsHtml({ guildData: gd, data: x.data, alert: state.pageAlert, notice: x.notice }));
        }
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

  // The last breadcrumb of an attendance page that is named after its record (the raid's date, the person).
  function leafNameFor(r) {
    if (!r) return '';
    if (r.name === 'raid') {
      const x = state.att.raid;
      return x && x.rid === r.rid && x.data && x.data.raid ? G.ui.weekdayDay(x.data.raid.raidOn) : '';
    }
    if (r.name === 'personatt') return G.pages.personAtt.nameFor(r);
    if (r.name === 'lootperson') return G.pages.personLoot.nameFor(r);
    return '';
  }

  // The shell context for the current section: who is looking, which guild's nav to draw, what is collapsed.
  function buildCtx(r) {
    const me = state.me;
    let gd = null;
    // The read-only pages (guest link, guest view, public page) draw no guild nav, whoever is looking.
    if (me && !G.router.isViewerRoute(r)) {
      // The roadmap has no guild of its own: like the planner and the help pages it draws the nav of the viewer's last guild.
      const own = r && (r.name === 'roadmap' || r.name === 'linked' || r.name === 'characters') ? chromeGuildId() : (r && r.gid);
      const gid = state.section === 'guild' ? own : chromeGuildId();
      gd = gid ? state.guilds[gid] || null : null;
    }
    return {
      section: state.section || 'guild', page: state.page, me: me, signedOut: state.loaded && !me, pending: !state.loaded,
      route: r || null, guildData: gd, teamId: gd ? teamFor(gd) : null, collapsed: collapsedFor(collapseContext()),
      whatsNewUnseen: whatsNewUnseen(),
      attentionCount: gd ? attentionCountFor(gd.guild.id) : 0,
      personName: r && r.name === 'person' && state.person && state.person.pid === r.pid && state.person.record ? (G.pages.person.mainOf(state.person.record) || {}).name : '',
      leafName: leafNameFor(r),
    };
  }

  // What the guild section shows in #gs-main: { html, center, title }.
  function guildView(r, ctx) {
    // The read-only pages come first: they do not wait for the sign-in question, and a visitor never sees the sign-in card.
    if (G.router.isViewerRoute(r)) {
      const v = state.view;
      return { html: G.pages.view.viewHtml({ data: v ? v.data : null, kind: v ? v.kind : (r.name === 'public' ? 'public' : 'guest'), error: v ? v.error : null }), center: !!(v && v.error), title: titleFor(r, null) };
    }
    if (!state.loaded) return { html: G.pages.signin.loadingHtml(), center: false, title: titleFor(r, null) };
    if (state.bootError) return { html: G.pages.signin.messageHtml('Could not load Raidsmith', state.bootError, { retry: true }), center: true, title: titleFor(r, null) };
    if (!state.me) {
      if (r.name === 'privacy') return { html: G.pages.privacy.privacyHtml({ me: null }), center: false, title: titleFor(r, null) };
      if (r.name === 'roadmap') return { html: G.pages.roadmap.roadmapHtml({ me: null, view: G.pages.roadmap.viewState() }), center: false, title: titleFor(r, null) };
      const html = G.pages.signin.signinHtml({ error: r.name === 'signin' ? r.error : null, notice: state.signinNotice, providers: state.providers });
      state.signinNotice = '';
      return { html: html, center: true, title: titleFor(r, null) };
    }
    return { html: mainFor(r, ctx.guildData, ctx), center: false, title: titleFor(r, ctx.guildData) };
  }

  function isDrawerOpen() {
    const d = byId('gs-drawer');
    return !!(d && d.open);
  }

  function writeSlot(id, html) {
    const el = byId(id);
    if (!el) return;
    if (el.classList) el.classList.add('gs-scope');
    el.innerHTML = html;
  }

  // Writes the shell's slots, and #gs-main on the guild section. Never writes inside #shell-topbar-plan or
  // #planner-root (only the empty #planner-notice slot the planner provides) or static page content.
  function render(focusHeading) {
    if (!root) return;
    const section = state.section || 'guild';
    const r = section === 'guild' ? G.router.parse(window.location.hash) : null;
    const active = document.activeElement;
    const key = active && active.getAttribute ? active.getAttribute('data-key') : null;
    const ctx = buildCtx(r);
    const s = G.shell.slots(ctx);
    writeSlot('shell-rail', s.rail);
    writeSlot('shell-sidebar', s.sidebar);
    writeSlot('shell-topbar-lead', s.lead);
    writeSlot('shell-topbar-account', s.account);
    writeSlot('shell-banner', s.banner);
    writeSlot('shell-tabs', s.tabs);
    // The drawer is a modal <dialog> the rewrite destroys: an open one (phone) is opened again on the new markup.
    const drawerWasOpen = isDrawerOpen();
    writeSlot('shell-drawer', s.drawer);
    if (drawerWasOpen) {
      const drawer = byId('gs-drawer');
      if (drawer && !drawer.open && drawer.showModal) drawer.showModal();
    }
    lastCollapseContext = collapseContext();
    root.classList.toggle('has-guild', section === 'guild' && !!ctx.guildData);
    root.classList.toggle('is-collapsed', !!ctx.collapsed);
    document.body.classList.toggle('is-signed-out', state.loaded && !state.me);

    const main = byId('gs-main');
    if (main) {
      if (section === 'guild') {
        const v = guildView(r, ctx);
        if (main.classList) { main.classList.add('gs-scope'); main.classList.toggle('gs-main-center', v.center); }
        // Scroll boxes inside #gs-main (data-scroll-key) keep their position across the rewrite.
        const scrolls = {};
        if (main.querySelectorAll) main.querySelectorAll('[data-scroll-key]').forEach(function (el) { scrolls[el.getAttribute('data-scroll-key')] = el.scrollTop; });
        main.innerHTML = v.html;
        if (main.querySelectorAll) main.querySelectorAll('[data-scroll-key]').forEach(function (el) { const t = scrolls[el.getAttribute('data-scroll-key')]; if (t) el.scrollTop = t; });
        document.title = v.title;
      } else if (main.innerHTML) {
        main.innerHTML = '';
      }
    }
    // Signed in with no guild: the notice above the compact planner home. Only while the planner shows: the guild
    // section's own no-guild card carries the same markup (and its ids).
    const notice = byId('planner-notice');
    if (notice) {
      if (notice.classList) notice.classList.add('gs-scope');
      notice.innerHTML = section === 'planner' && state.me && Array.isArray(state.me.guilds) && !state.me.guilds.length ? G.pages.signin.noGuildNoticeHtml(state.me) : '';
    }

    if (section === 'guild' && focusHeading === true && !firstRender) {
      const h = main && main.querySelector ? main.querySelector('h1') : null;
      if (h) h.focus();
    } else if (key) {
      G.ui.focusByKey(key, { preventScroll: true });
    }
    if (state.loaded) firstRender = false;
    if (section === 'guild' && G.pages.raid && G.pages.raid.afterRender) G.pages.raid.afterRender();
    // Pieces that load their own data once the page they sit on is drawn: the officers' away card and person section, the standing sign-ups card, the roster.
    if (section === 'guild') ['away', 'standing', 'raidRoster'].forEach(function (k) { if (G.pages[k] && G.pages[k].afterRender) G.pages[k].afterRender(r); });
  }

  // Redraws the nav slots only (sidebar and drawer): a late answer such as the Home count must not rewrite a page the person is typing in.
  function renderNav() {
    if (!root) return;
    const r = (state.section || 'guild') === 'guild' ? G.router.parse(window.location.hash) : null;
    const s = G.shell.slots(buildCtx(r));
    writeSlot('shell-sidebar', s.sidebar);
    const drawerWasOpen = isDrawerOpen();
    writeSlot('shell-drawer', s.drawer);
    if (drawerWasOpen) {
      const drawer = byId('gs-drawer');
      if (drawer && !drawer.open && drawer.showModal) drawer.showModal();
    }
  }

  // ── actions other modules call ──
  app.render = render;
  app.selectTeam = selectTeam;
  app.setAttention = setAttention;
  app.ensureAttention = ensureAttention;
  app.attentionCountFor = attentionCountFor;
  app.go = go;
  app.routeAll = routeAll;
  app.sectionFor = sectionFor;
  app.closeOverlays = closeOverlays;
  app.loadMe = loadMe;
  app.teamFor = teamFor;
  app.collapsedFor = collapsedFor;
  app.collapseContext = collapseContext;
  app.buildCtx = buildCtx;

  // Every mutation reply that carries `rosterFlags` or `attendanceFlags` refreshes the nav badge without a refetch.
  app.applyFlags = function (gid, res) {
    const gd = state.guilds[gid];
    if (gd && res && res.rosterFlags && typeof res.rosterFlags === 'object') gd.rosterFlags = res.rosterFlags;
    if (gd && res && res.attendanceFlags && typeof res.attendanceFlags === 'object') gd.attendanceFlags = res.attendanceFlags;
  };

  app.setPerson = function (gid, record) {
    if (!record || !record.person) return;
    state.person = { gid: gid, pid: record.person.id, record: record };
  };

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

  // The Guild Master deleted a guild: forget what the page held of it, read the account's guilds again and go to the start (another guild's Home, or the
  // no-guild card).
  app.afterGuildDeleted = function (gid) {
    delete state.guilds[gid];
    delete state.attention[gid];
    state.pageAlert = '';
    loadMe().then(function () { go('#/', true); });
  };

  app.afterAccountDeleted = function () {
    resetSession();
    state.signinNotice = 'Your data has been deleted.';
    go('#/', true);
  };

  // Sign-out: on a guild section today's sign-in card; on the planner or a static page the chrome turns signed
  // out and the section and the address stay.
  function signOut() {
    const done = function () {
      resetSession();
      if (state.section === 'guild') go('#/', true);
      else render();
    };
    G.api.post('/auth/logout', {}).then(done, done);
  }

  // ── event handlers ──
  function closeMenu(refocus) {
    const menu = byId('gs-account-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const btn = document.querySelector('[data-action="toggle-menu"]');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
  }

  G.handlers.click['toggle-menu'] = function (btn) {
    const menu = byId('gs-account-menu');
    if (!menu) return;
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const first = menu.querySelector('[role="menuitem"]'); if (first) first.focus(); }
  };

  // Writes the current context's choice (plan view or everywhere else); works signed out (local key only).
  G.handlers.click['toggle-sidebar'] = function () {
    const context = collapseContext();
    const next = !collapsedFor(context);
    storageSet(COLLAPSE_KEYS[context], next ? '1' : '0');
    if (state.me && state.me.user) {
      const body = {};
      body[COLLAPSE_PREFS[context]] = next;
      state.me.user.prefs = Object.assign({}, prefs(), body);
      patchPrefs(body);
    }
    render();
  };

  G.handlers.click['open-drawer'] = function () {
    const d = byId('gs-drawer');
    if (d && !d.open && d.showModal) d.showModal();
  };

  G.handlers.click['close-drawer'] = function () {
    const d = byId('gs-drawer');
    if (d && d.open) d.close();
  };

  // A plain left click; modified and middle clicks keep the browser default (open in a new tab).
  function isPlainClick(ev) {
    if (!ev) return true;
    if (ev.defaultPrevented) return false;
    if (ev.button !== undefined && ev.button !== 0) return false;
    return !(ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey);
  }

  // The Planner item (sidebar, brand, rail logo, "Open the planner" buttons). On a guild section the address drops
  // its hash (the plan stays as left); with the planner showing it goes home. On a static page it is a plain link.
  G.handlers.click['open-planner'] = function (el, ev) {
    if (state.page !== 'app' || !isPlainClick(ev)) return;
    if (ev && ev.preventDefault) ev.preventDefault();
    if (state.section === 'guild') {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
      routeAll();
      return;
    }
    const shell = plannerShell();
    if (shell && shell.home) shell.home();
    const hash = String(window.location.hash || '');
    if (hash === '#how-it-works' || hash.indexOf('#/planner') === 0) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      lastHref = String(window.location.href);
    }
    syncRaidContext();
    render();
  };

  // How it works: the full landing scrolled to that section. The hash is replaced so a second click works the same
  // and a reload lands there. On a static page it is a plain link to /#how-it-works.
  G.handlers.click['how-it-works'] = function (el, ev) {
    if (state.page !== 'app' || !isPlainClick(ev)) return;
    if (ev && ev.preventDefault) ev.preventDefault();
    const target = window.location.pathname + window.location.search + '#how-it-works';
    if (state.section === 'guild') {
      window.history.pushState(null, '', target);
      routeAll();
      return;
    }
    const shell = plannerShell();
    if (shell && shell.howItWorks) shell.howItWorks();
    window.history.replaceState(null, '', target);
    lastHref = String(window.location.href);
    render();
  };

  function closeImportMenu() {
    const menu = byId('roster-import-list');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const btn = root && root.querySelector('[data-action="roster-import-menu"]');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  G.handlers.click['sign-out'] = signOut;
  G.handlers.click.retry = function () {
    if (state.bootError) {
      // The session question failed: ask it again.
      state.bootError = '';
      state.loaded = false;
      state.asked = false;
      sessionPromise = null;
    }
    routeAll({ force: true });
  };

  G.handlers.change['team-pick'] = function (sel) {
    // The guild the picker belongs to: the open guild page's, else the one the planner / help-page chrome shows
    // (currentGid is null, or a guild visited earlier, there).
    const gid = state.section === 'guild' && state.currentGid ? state.currentGid : chromeGuildId();
    if (!gid) return;
    rememberTeam(gid, sel.value);
    const drawer = byId('gs-drawer');
    if (drawer && drawer.open) drawer.close();
    if (state.section !== 'guild') { render(); return; }
    const r = G.router.parse(window.location.hash);
    if (r.name === 'section' && r.section === 'roster') { go(G.router.format({ name: 'section', gid: gid, section: 'roster' })); return; }
    if (r.name === 'import' || (r.name === 'section' && (r.section === 'raids' || r.section === 'attendance' || r.section === 'loot')) || r.name === 'raidnew' || r.name === 'review' || r.name === 'backfill') { routeAll({ force: true }); return; }
    render();
  };

  // Delegated handlers act on the shell's own markup (inside a .gs-scope slot), plus the few actions the planner's
  // markup may carry too; a planner element that happens to share a data-action name is never ours.
  function dispatch(kind, attr, ev) {
    const t = ev.target;
    if (!t || !t.closest) return false;
    const el = t.closest('[' + attr + ']');
    if (!el) return false;
    const name = el.getAttribute(attr);
    const fn = G.handlers[kind][name];
    if (!fn) return false;
    if (!el.closest('.gs-scope') && !(kind === 'click' && SHARED_ACTIONS.indexOf(name) >= 0)) return false;
    if (kind === 'click') app.lastActionEl = el;
    fn(el, ev);
    return true;
  }

  function onClick(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('.gs-import-menu')) closeImportMenu();
    if (t.closest('.gs-menu a')) closeMenu(false);
    const link = t.closest('a[href]');
    if (link && isPlainClick(ev)) lastNavClickAt = Date.now();
    if (t.closest('.gs-drawer a')) G.handlers.click['close-drawer']();
    dispatch('click', 'data-action', ev);
  }

  // Capture phase: the planner's menus stop the click from bubbling (Menu.init), so an outside click is seen here
  // to keep the account menu and a planner menu from being open together.
  function onClickCapture(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (!t.closest('.gs-account')) closeMenu(false);
  }

  function onKeydown(ev) {
    const menu = byId('gs-account-menu');
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
    if (!form || !form.closest('.gs-scope')) return;
    ev.preventDefault();
    const fn = G.handlers.submit[form.getAttribute('data-submit')];
    if (fn) fn(form, ev);
  }

  app.start = function () {
    root = byId('guild-root');
    if (!root) return;
    state.page = bodyAttr('data-page') || 'app';
    originalTitle = document.title;
    SCOPED_SLOTS.forEach(function (id) { const el = byId(id); if (el && el.classList) el.classList.add('gs-scope'); });
    app.started = true;
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('submit', onSubmit);
    document.addEventListener('change', function (ev) { dispatch('change', 'data-change', ev); });
    document.addEventListener('input', function (ev) { dispatch('input', 'data-input', ev); });
    // The planner switches between its landing and a plan: the sidebar collapse context follows.
    // Only a change of that context redraws (a redraw closes an open account menu).
    document.addEventListener('planner:view', function () {
      if (state.section === 'planner' && collapseContext() !== lastCollapseContext) render();
    });
    window.addEventListener('hashchange', function () { routeAll(); });
    // A click on a link fires popstate too; only a popstate with no link click just before it is Back / Forward.
    window.addEventListener('popstate', function () { routeAll({ history: Date.now() - lastNavClickAt > NAV_CLICK_WINDOW_MS }); });
    // A page restored from the back/forward cache re-checks the What's new pill.
    window.addEventListener('pageshow', function (ev) { if (ev && ev.persisted) render(); });
    // Whatever goes wrong on the first pass, the page must leave its pending look: signed-out chrome.
    try {
      const first = routeAll({ force: true });
      if (first && first.catch) first.catch(failSafeStart);
    } catch (err) {
      failSafeStart(err);
    }
  };

  function failSafeStart() {
    state.me = null;
    state.loaded = true;
    finishPending();
    if (document.body) document.body.classList.add('is-signed-out');
    try { render(); } catch (e) { /* the chrome stays as the skeleton has it */ }
  }

  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('guild-root')) app.start();
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
