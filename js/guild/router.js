// ── HASH ROUTES ─────────────────────────────────────────────────
// Pure parse/format for the guild page. Routes:
//   #/  #/signin[?error=..]  #/new  #/privacy  #/roadmap  #/linked[?error=..]  #/characters
//   #/planner[?raid=<gid>.<rid>]  (the planner section; with a raid it opens on that raid's sign-ups and plan)
//   #/g/:gid  #/g/:gid/home  (Home: the needs-attention list for officers, the member's own page for everyone else)
//   #/g/:gid/{roster,raids,attendance,loot}  #/g/:gid/settings[/{general,teams,schedule,people,roles,discord,guests,dataaccess,public,applications,notifications,attendance,loot,battlenet,activity,data}]
//   (settings: the bare address opens the first page on a wide screen and the list of pages on a phone; 'accounts' is read as 'people', the page's new name)
//   (settings also has 'links' (Links and keys) and 'claimreview' (Owner review, the new Owner's page after a claim))
//   #/g/:gid/users[/{members,former,non-members,blocked}]  #/g/:gid/users/u/:key  (the Users list, its segments, and one user by the key GET /users hands out)
//   #/g/:gid/setup  (Guild setup, the in-game guild flow; its own page under Guild settings)
//   #/fresh[?done=<purpose>|?error=<reason>[&purpose=<purpose>]]  (where the fresh sign-in comes back to; the Worker's callbacks redirect here)
//   #/guest/<token>  (a guest link: the page redeems it and moves to #/view)  #/view  (the guest view)  #/public/:gid  (a guild's public page)
//   #/apply/:gid  (a guild's application form)  #/join/<token>  (a raid's guest sign-up link: sign up as a Guest, no account)
//   #/open/:gid/:rid  (a raid that is open to guests: a signed-in account signs up as a Guest, no link; the route is { name: 'join', open: true, gid, rid } so the shell treats it as the join page)
//   These four work signed out; the first three show a read-only view and never ask for a sign-in, the form lets a signed-in applicant's account come along.
//   #/g/:gid/away  (my away notices)
//   #/g/:gid/raids/new  #/g/:gid/raids/r/:rid  #/g/:gid/attendance/{review,backfill}  #/g/:gid/attendance/p/:pid
//   #/g/:gid/loot (the hub)  #/g/:gid/loot/{standings,fix}  #/g/:gid/loot/n/:rid (one night)  #/g/:gid/loot/i/:itemId  #/g/:gid/loot/p/:pid  #/g/:gid/loot/a/:aid[?edit=1]
//   (the old ?view=raids|items links open the hub: the route carries legacyView so the page can tidy the address)
//   #/g/:gid/roster[?team=t_..]  #/g/:gid/roster/p/:pid  #/g/:gid/roster/import/{raid-helper,wcl,bnet,csv}
//   #/g/:gid/roster/{intent,recruiting,applications,launch}  (the Roster's other tabs: the class and spec intent board, recruitment needs, the applications inbox, the Launch funnel)
//   (?team= only opens an archived team's roster; the shell's team picker decides otherwise)
(function (G) {
  'use strict';

  // 'home' is the guild's landing section: it has no path segment of its own (#/g/:gid); #/g/:gid/home is only an alias.
  const SECTIONS = ['home', 'roster', 'raids', 'attendance', 'loot'];
  // One entry per line: a lane that retires a page deletes its line, and two one-line arrays would collide on merge.
  const TABS = [
    'general',
    'teams',
    'schedule',
    'people',
    'roles',
    'discord',
    'guests',
    'dataaccess',
    'links',
    'claimreview',
    'public',
    'applications',
    'notifications',
    'attendance',
    'loot',
    'battlenet',
    'activity',
    'data',
  ];
  // The Roster's tabs after the roster list itself; each is a route of its own.
  // Names a settings page was or may be called by, read as the address it has had since it was built (Settings "People" became "Accounts").
  const TAB_ALIASES = {
    accounts: 'people',
  };
  const ROSTER_TABS = ['intent', 'recruiting', 'applications', 'launch'];
  const LOOT_VIEWS = ['raids', 'items'];
  const RAID_FOCUS = 'signups-unmatched'; // #/g/:gid/raids/r/:rid?focus=signups-unmatched opens the raid page scrolled to its Unmatched sign-ups panel
  const ITEM_ID = /^[1-9][0-9]{0,9}$/;
  const IMPORT_SOURCES = ['raid-helper', 'wcl', 'bnet', 'csv'];
  // Why a sign-in came back without signing in (/auth/callback and /auth/bnet/callback redirect to #/signin?error=..).
  const SIGNIN_ERRORS = ['denied', 'state', 'discord', 'bnet', 'not_configured', 'busy'];
  // Why a Discord or Battle.net link came back without linking (redirects to #/linked?error=..). 'taken' is a Battle.net account that belongs to
  // another account, 'discord_taken' the same for Discord; 'has_discord' a second Discord on an account that has one; 'roster_conflict' a Discord
  // ID that would put two roster people of one guild on the account.
  // 'fresh_required': the link of a protected account needs a fresh sign-in first (identity_change); the page offers it.
  const LINKED_ERRORS = ['denied', 'state', 'bnet', 'not_configured', 'busy', 'taken', 'discord', 'discord_taken', 'has_discord', 'has_bnet', 'roster_conflict', 'fresh_required'];
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  // The Users list's segments: the Worker's word (GET /users?segment=) and the word the address carries ('nonmembers' reads 'non-members' there).
  const USER_SEGMENTS = ['members', 'former', 'nonmembers', 'blocked'];
  const USER_SEGMENT_WORDS = { members: 'members', former: 'former', nonmembers: 'non-members', blocked: 'blocked' };
  // A user's key as GET /users hands it out ('u_' / 'p_' + 22 characters, or 'n_' + the hex of a name); the Worker decides whether it names anyone.
  const USER_KEY = /^[A-Za-z0-9_-]{1,520}$/;
  // The acts the fresh sign-in is for (worker/fresh.js FRESH_PURPOSES; a test pins the two lists together) and the shape of a reason the Worker's callbacks name. An unknown reason is kept:
  // the page has a sentence for every reason it knows and a default for the rest.
  const FRESH_PURPOSES = ['handover', 'guild_delete', 'pin', 'source_switch', 'gm_claim', 'ingame_create', 'identity_change', 'account_delete'];
  const FRESH_REASON = /^[a-z][a-z_]{0,31}$/;
  // A guest link's token: 32 random bytes in base64url (what the Worker makes and POST /auth/guest accepts).
  const GUEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;

  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return null; }
  }

  const isId = function (v) { return typeof v === 'string' && ID.test(v); };

  // The planner's raid context 'gid.rid' -> { gid, rid }, or null.
  function plannerRaid(raid) {
    const parts = typeof raid === 'string' ? raid.split('.') : [];
    return parts.length === 2 && isId(parts[0]) && isId(parts[1]) ? { gid: parts[0], rid: parts[1] } : null;
  }

  function parseQuery(q) {
    const out = {};
    if (!q) return out;
    q.split('&').forEach(function (pair) {
      if (!pair) return;
      const i = pair.indexOf('=');
      const k = decode(i < 0 ? pair : pair.slice(0, i));
      const v = decode(i < 0 ? '' : pair.slice(i + 1));
      if (k != null && v != null) out[k] = v;
    });
    return out;
  }

  // #/fresh: { name: 'fresh', done: purpose | null, error: reason | null, purpose: purpose | null }. A done wins over an error; a purpose rides only with an error.
  function freshRoute(query) {
    const route = { name: 'fresh', done: null, error: null, purpose: null };
    if (FRESH_PURPOSES.indexOf(query.done) >= 0) {
      route.done = query.done;
    } else if (typeof query.error === 'string' && FRESH_REASON.test(query.error)) {
      route.error = query.error;
      if (FRESH_PURPOSES.indexOf(query.purpose) >= 0) route.purpose = query.purpose;
    }
    return route;
  }

  function parse(hash) {
    let h = String(hash == null ? '' : hash);
    if (h.charAt(0) === '#') h = h.slice(1);
    const qi = h.indexOf('?');
    const query = parseQuery(qi < 0 ? '' : h.slice(qi + 1));
    const path = qi < 0 ? h : h.slice(0, qi);
    const parts = path.split('/').filter(function (p) { return p !== ''; }).map(decode);
    if (parts.indexOf(null) >= 0) return { name: 'notfound' };
    if (!parts.length) return { name: 'home' };
    const head = parts[0];
    if (parts.length === 1) {
      if (head === 'signin') return { name: 'signin', error: SIGNIN_ERRORS.indexOf(query.error) >= 0 ? query.error : null };
      if (head === 'new') return { name: 'new' };
      if (head === 'privacy') return { name: 'privacy' };
      if (head === 'roadmap') return { name: 'roadmap' };
      if (head === 'linked') return { name: 'linked', error: LINKED_ERRORS.indexOf(query.error) >= 0 ? query.error : null };
      if (head === 'characters') return { name: 'characters' };
      if (head === 'fresh') return freshRoute(query);
      if (head === 'view') return { name: 'view' };
      if (head === 'planner') {
        const raid = plannerRaid(query.raid);
        return raid ? { name: 'planner', gid: raid.gid, rid: raid.rid } : { name: 'planner' };
      }
      return { name: 'notfound' };
    }
    if (head === 'guest' && parts.length === 2) return GUEST_TOKEN.test(parts[1]) ? { name: 'guest', token: parts[1] } : { name: 'notfound' };
    if (head === 'public' && parts.length === 2) return ID.test(parts[1]) ? { name: 'public', gid: parts[1] } : { name: 'notfound' };
    // Dev "View as" previews (the Guild Master on a local run): #/dev/viewer/:gid/guest|public
    if (head === 'dev' && parts.length === 4 && parts[1] === 'viewer' && ID.test(parts[2]) && (parts[3] === 'guest' || parts[3] === 'public')) return { name: 'devview', gid: parts[2], role: parts[3] };
    if (head === 'join' && parts.length === 2) return GUEST_TOKEN.test(parts[1]) ? { name: 'join', token: parts[1] } : { name: 'notfound' };
    if (head === 'open' && parts.length === 3) return ID.test(parts[1]) && ID.test(parts[2]) ? { name: 'join', open: true, gid: parts[1], rid: parts[2] } : { name: 'notfound' };
    if (head === 'apply' && parts.length === 2) return ID.test(parts[1]) ? { name: 'apply', gid: parts[1] } : { name: 'notfound' };
    if (head !== 'g' || !ID.test(parts[1])) return { name: 'notfound' };
    const gid = parts[1];
    if (parts.length === 2) return { name: 'section', gid: gid, section: 'home' };
    if (parts.length === 3 && SECTIONS.indexOf(parts[2]) >= 0) {
      const section = { name: 'section', gid: gid, section: parts[2] };
      if (parts[2] === 'roster' && typeof query.team === 'string' && ID.test(query.team)) section.team = query.team;
      if (parts[2] === 'loot' && LOOT_VIEWS.indexOf(query.view) >= 0) section.legacyView = true;
      return section;
    }
    if (parts[2] === 'roster') {
      if (parts.length === 5 && parts[3] === 'p' && ID.test(parts[4])) return { name: 'person', gid: gid, pid: parts[4] };
      if (parts.length === 5 && parts[3] === 'import' && IMPORT_SOURCES.indexOf(parts[4]) >= 0) return { name: 'import', gid: gid, source: parts[4] };
      if (parts.length === 4 && ROSTER_TABS.indexOf(parts[3]) >= 0) return { name: parts[3], gid: gid };
    }
    if (parts[2] === 'away' && parts.length === 3) return { name: 'away', gid: gid };
    if (parts[2] === 'setup' && parts.length === 3) return { name: 'setup', gid: gid };
    if (parts[2] === 'users') {
      if (parts.length === 3) return { name: 'users', gid: gid, segment: null };
      if (parts.length === 4) {
        const segment = USER_SEGMENTS.filter(function (s) { return USER_SEGMENT_WORDS[s] === parts[3] || s === parts[3]; })[0];
        if (segment) return { name: 'users', gid: gid, segment: segment };
      }
      if (parts.length === 5 && parts[3] === 'u' && USER_KEY.test(parts[4])) return { name: 'user', gid: gid, key: parts[4] };
    }
    if (parts[2] === 'raids') {
      if (parts.length === 4 && parts[3] === 'new') return { name: 'raidnew', gid: gid };
      if (parts.length === 5 && parts[3] === 'r' && ID.test(parts[4])) return query.focus === RAID_FOCUS ? { name: 'raid', gid: gid, rid: parts[4], focus: RAID_FOCUS } : { name: 'raid', gid: gid, rid: parts[4] };
    }
    if (parts[2] === 'attendance') {
      if (parts.length === 4 && parts[3] === 'review') return { name: 'review', gid: gid };
      if (parts.length === 4 && parts[3] === 'backfill') return { name: 'backfill', gid: gid };
      if (parts.length === 5 && parts[3] === 'p' && ID.test(parts[4])) return { name: 'personatt', gid: gid, pid: parts[4] };
    }
    if (parts[2] === 'loot') {
      if (parts.length === 4 && parts[3] === 'standings') return { name: 'lootstandings', gid: gid };
      if (parts.length === 4 && parts[3] === 'fix') return { name: 'lootfix', gid: gid };
      if (parts.length === 5 && parts[3] === 'p' && ID.test(parts[4])) return { name: 'lootperson', gid: gid, pid: parts[4] };
      if (parts.length === 5 && parts[3] === 'n' && ID.test(parts[4])) return { name: 'lootnight', gid: gid, rid: parts[4] };
      if (parts.length === 5 && parts[3] === 'i' && ITEM_ID.test(parts[4])) return { name: 'lootitem', gid: gid, itemId: parts[4] };
      if (parts.length === 5 && parts[3] === 'a' && ID.test(parts[4])) return { name: 'lootaward', gid: gid, aid: parts[4], edit: query.edit === '1' };
    }
    if (parts[2] === 'settings') {
      if (parts.length === 3) return { name: 'settings', gid: gid, tab: null };
      if (parts.length === 4 && TAB_ALIASES.hasOwnProperty(parts[3])) return { name: 'settings', gid: gid, tab: TAB_ALIASES[parts[3]] };
      if (parts.length === 4 && TABS.indexOf(parts[3]) >= 0) return { name: 'settings', gid: gid, tab: parts[3] };
    }
    return { name: 'notfound' };
  }

  function format(route) {
    const r = route || {};
    switch (r.name) {
      case 'home': return '#/';
      case 'signin': return '#/signin' + (SIGNIN_ERRORS.indexOf(r.error) >= 0 ? '?error=' + r.error : '');
      case 'new': return '#/new';
      case 'privacy': return '#/privacy';
      case 'roadmap': return '#/roadmap';
      case 'linked': return '#/linked' + (LINKED_ERRORS.indexOf(r.error) >= 0 ? '?error=' + r.error : '');
      case 'characters': return '#/characters';
      case 'view': return '#/view';
      case 'guest': return typeof r.token === 'string' && GUEST_TOKEN.test(r.token) ? '#/guest/' + r.token : '#/';
      case 'public': return isId(r.gid) ? '#/public/' + encodeURIComponent(r.gid) : '#/';
      case 'devview': return isId(r.gid) && (r.role === 'guest' || r.role === 'public') ? '#/dev/viewer/' + encodeURIComponent(r.gid) + '/' + r.role : '#/';
      case 'apply': return isId(r.gid) ? '#/apply/' + encodeURIComponent(r.gid) : '#/';
      case 'join':
        if (r.open) return isId(r.gid) && isId(r.rid) ? '#/open/' + encodeURIComponent(r.gid) + '/' + encodeURIComponent(r.rid) : '#/';
        return typeof r.token === 'string' && GUEST_TOKEN.test(r.token) ? '#/join/' + r.token : '#/';
      case 'intent': case 'recruiting': case 'applications': case 'launch': return '#/g/' + encodeURIComponent(r.gid) + '/roster/' + r.name;
      case 'planner': return '#/planner' + (isId(r.gid) && isId(r.rid) ? '?raid=' + r.gid + '.' + r.rid : '');
      case 'section': {
        const section = SECTIONS.indexOf(r.section) >= 0 ? r.section : 'roster';
        const team = section === 'roster' && typeof r.team === 'string' && ID.test(r.team) ? '?team=' + encodeURIComponent(r.team) : '';
        if (section === 'home') return '#/g/' + encodeURIComponent(r.gid);
        return '#/g/' + encodeURIComponent(r.gid) + '/' + section + team;
      }
      case 'person': return '#/g/' + encodeURIComponent(r.gid) + '/roster/p/' + encodeURIComponent(r.pid);
      case 'import': return '#/g/' + encodeURIComponent(r.gid) + '/roster/import/' + (IMPORT_SOURCES.indexOf(r.source) >= 0 ? r.source : 'raid-helper');
      case 'away': return '#/g/' + encodeURIComponent(r.gid) + '/away';
      case 'setup': return '#/g/' + encodeURIComponent(r.gid) + '/setup';
      case 'users': return '#/g/' + encodeURIComponent(r.gid) + '/users' + (USER_SEGMENTS.indexOf(r.segment) >= 0 ? '/' + USER_SEGMENT_WORDS[r.segment] : '');
      case 'user': return typeof r.key === 'string' && USER_KEY.test(r.key) ? '#/g/' + encodeURIComponent(r.gid) + '/users/u/' + encodeURIComponent(r.key) : '#/g/' + encodeURIComponent(r.gid) + '/users';
      case 'fresh':
        if (FRESH_PURPOSES.indexOf(r.done) >= 0) return '#/fresh?done=' + r.done;
        if (typeof r.error === 'string' && FRESH_REASON.test(r.error)) return '#/fresh?error=' + r.error + (FRESH_PURPOSES.indexOf(r.purpose) >= 0 ? '&purpose=' + r.purpose : '');
        return '#/fresh';
      case 'raidnew': return '#/g/' + encodeURIComponent(r.gid) + '/raids/new';
      case 'raid': return '#/g/' + encodeURIComponent(r.gid) + '/raids/r/' + encodeURIComponent(r.rid) + (r.focus === RAID_FOCUS ? '?focus=' + RAID_FOCUS : '');
      case 'review': return '#/g/' + encodeURIComponent(r.gid) + '/attendance/review';
      case 'backfill': return '#/g/' + encodeURIComponent(r.gid) + '/attendance/backfill';
      case 'personatt': return '#/g/' + encodeURIComponent(r.gid) + '/attendance/p/' + encodeURIComponent(r.pid);
      case 'lootstandings': return '#/g/' + encodeURIComponent(r.gid) + '/loot/standings';
      case 'lootfix': return '#/g/' + encodeURIComponent(r.gid) + '/loot/fix';
      case 'lootnight': return '#/g/' + encodeURIComponent(r.gid) + '/loot/n/' + encodeURIComponent(r.rid);
      case 'lootitem': return '#/g/' + encodeURIComponent(r.gid) + '/loot/i/' + encodeURIComponent(r.itemId);
      case 'lootaward': return '#/g/' + encodeURIComponent(r.gid) + '/loot/a/' + encodeURIComponent(r.aid) + (r.edit ? '?edit=1' : '');
      case 'lootperson': return '#/g/' + encodeURIComponent(r.gid) + '/loot/p/' + encodeURIComponent(r.pid);
      case 'settings': return '#/g/' + encodeURIComponent(r.gid) + '/settings' + (TABS.indexOf(r.tab) >= 0 ? '/' + r.tab : '');
      default: return '#/';
    }
  }

  // The routes that work without an account (a guest link, the guest view, a public page, an application form).
  function isViewerRoute(route) {
    return !!route && (route.name === 'guest' || route.name === 'view' || route.name === 'public' || route.name === 'apply' || route.name === 'join' || route.name === 'devview');
  }

  // ── PREVIOUS PAGE (the back links) ──
  // The trail of in-app pages this tab has visited, kept in sessionStorage (a reload of the same tab keeps it; a fresh load of an address, a new tab or a
  // direct link starts it empty). A page is its address without the query: a sort, a filter or a saved tag that only changes the query is the same page.
  // previous() is the page before the current one, or null: the back links then keep their fixed parent. A back link click calls history.back() (no
  // new entry); back() records that so the stack pops instead of growing, and back/back never bounces.
  const TRAIL_KEY = 'gs-trail';
  const TRAIL_MAX = 30;
  let trail = null;

  function trailStore() {
    try { return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null; } catch (err) { return null; }
  }
  function pathOf(hash) {
    const h = String(hash || '');
    const q = h.indexOf('?');
    return q < 0 ? h : h.slice(0, q);
  }
  function trailLoad() {
    if (trail) return trail;
    trail = { stack: [], intent: null };
    const store = trailStore();
    if (!store) return trail;
    try {
      const saved = JSON.parse(store.getItem(TRAIL_KEY));
      if (saved && Array.isArray(saved.stack)) {
        trail.stack = saved.stack.filter(function (e) { return e && typeof e.hash === 'string' && typeof e.path === 'string'; }).slice(-TRAIL_MAX);
        trail.intent = typeof saved.intent === 'string' ? saved.intent : null;
      }
    } catch (err) { /* an unreadable trail is an empty one */ }
    return trail;
  }
  function trailSave() {
    const store = trailStore();
    if (!store || !trail) return;
    try { store.setItem(TRAIL_KEY, JSON.stringify(trail)); } catch (err) { /* private window: the trail lives for this load only */ }
  }
  // The address changed to `hash`. opts: { replace: the entry was replaced, not added; history: Back / Forward button }
  function visit(hash, opts) {
    const o = opts || {};
    const t = trailLoad();
    const path = pathOf(hash);
    const stack = t.stack;
    const top = stack[stack.length - 1];
    const intent = t.intent;
    t.intent = null;
    if (top && top.path === path) { top.hash = hash; trailSave(); return; } // the same page again (a query change, a retry, a reload)
    const goingBack = (intent === path || o.history) && stack.length > 1 && stack[stack.length - 2].path === path;
    if (goingBack) {
      stack.pop();
      stack[stack.length - 1].hash = hash;
    } else {
      if (o.replace) stack.pop();
      const below = stack[stack.length - 1];
      if (below && below.path === path) below.hash = hash;
      else stack.push({ path: path, hash: hash, name: null });
      if (stack.length > TRAIL_MAX) stack.shift();
    }
    trailSave();
  }
  // The page at `hash` is drawn: its name (the h1) and its final address (a redirect may have rewritten it).
  // opts.skip: an error / not-found page, which never counts as a previous in-app page (the back link keeps its fixed parent).
  function rendered(hash, name, opts) {
    const t = trailLoad();
    const top = t.stack[t.stack.length - 1];
    if (!top) return;
    top.hash = String(hash || top.hash);
    top.path = pathOf(top.hash);
    if (opts && opts.skip) top.name = null;
    else if (typeof name === 'string' && name.trim()) top.name = name.trim();
    trailSave();
  }
  // -> { hash, name } of the page before this one, or null (nothing before it, or it was never named).
  function previous() {
    const t = trailLoad();
    const prev = t.stack.length > 1 ? t.stack[t.stack.length - 2] : null;
    return prev && prev.name ? { hash: prev.hash, name: prev.name } : null;
  }
  // A back link is about to call history.back(): the next address is the previous page.
  function back() {
    const prev = previous();
    if (!prev) return null;
    trailLoad().intent = pathOf(prev.hash);
    trailSave();
    return prev;
  }
  // A load that is not a reload or a Back / Forward starts a new trail.
  function resetTrail() {
    trail = { stack: [], intent: null };
    trailSave();
  }

  G.router = { SECTIONS: SECTIONS, TABS: TABS, TAB_ALIASES: TAB_ALIASES, ROSTER_TABS: ROSTER_TABS, LOOT_VIEWS: LOOT_VIEWS, IMPORT_SOURCES: IMPORT_SOURCES, LINKED_ERRORS: LINKED_ERRORS, GUEST_TOKEN: GUEST_TOKEN,
    USER_SEGMENTS: USER_SEGMENTS, FRESH_PURPOSES: FRESH_PURPOSES, parse: parse, format: format, isViewerRoute: isViewerRoute,
    visit: visit, rendered: rendered, previous: previous, back: back, resetTrail: resetTrail, pathOf: pathOf };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
