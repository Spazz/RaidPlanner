// ── HASH ROUTES ─────────────────────────────────────────────────
// Pure parse/format for the guild page. Routes:
//   #/  #/signin[?error=..]  #/new  #/privacy  #/roadmap  #/linked[?error=..]  #/characters
//   #/planner[?raid=<gid>.<rid>]  (the planner section; with a raid it opens on that raid's sign-ups and plan)
//   #/g/:gid/{roster,raids,attendance,loot}  #/g/:gid/settings[/{teams,people,attendance,loot,battlenet}]
//   #/g/:gid/raids/new  #/g/:gid/raids/r/:rid  #/g/:gid/attendance/{review,backfill}  #/g/:gid/attendance/p/:pid
//   #/g/:gid/loot[?view=raids|items]  #/g/:gid/loot/p/:pid  (Balance is the default view)
//   #/g/:gid/roster[?team=t_..]  #/g/:gid/roster/p/:pid  #/g/:gid/roster/import/{raid-helper,wcl,bnet}
//   (?team= only opens an archived team's roster; the shell's team picker decides otherwise)
(function (G) {
  'use strict';

  const SECTIONS = ['roster', 'raids', 'attendance', 'loot'];
  const TABS = ['teams', 'people', 'attendance', 'loot', 'battlenet'];
  const LOOT_VIEWS = ['raids', 'items'];
  const IMPORT_SOURCES = ['raid-helper', 'wcl', 'bnet'];
  // Why a sign-in came back without signing in (/auth/callback and /auth/bnet/callback redirect to #/signin?error=..).
  const SIGNIN_ERRORS = ['denied', 'state', 'discord', 'bnet', 'not_configured'];
  // Why a Discord or Battle.net link came back without linking (redirects to #/linked?error=..). 'taken' is a Battle.net account that belongs to
  // another account, 'discord_taken' the same for Discord; 'has_discord' a second Discord on an account that has one; 'roster_conflict' a Discord
  // ID that would put two roster people of one guild on the account.
  const LINKED_ERRORS = ['denied', 'state', 'bnet', 'not_configured', 'busy', 'taken', 'discord', 'discord_taken', 'has_discord', 'has_bnet', 'roster_conflict'];
  const ID = /^[A-Za-z0-9_-]{1,64}$/;

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
      if (head === 'planner') {
        const raid = plannerRaid(query.raid);
        return raid ? { name: 'planner', gid: raid.gid, rid: raid.rid } : { name: 'planner' };
      }
      return { name: 'notfound' };
    }
    if (head !== 'g' || !ID.test(parts[1])) return { name: 'notfound' };
    const gid = parts[1];
    if (parts.length === 2) return { name: 'section', gid: gid, section: 'roster' };
    if (parts.length === 3 && SECTIONS.indexOf(parts[2]) >= 0) {
      const section = { name: 'section', gid: gid, section: parts[2] };
      if (parts[2] === 'roster' && typeof query.team === 'string' && ID.test(query.team)) section.team = query.team;
      if (parts[2] === 'loot' && LOOT_VIEWS.indexOf(query.view) >= 0) section.view = query.view;
      return section;
    }
    if (parts[2] === 'roster') {
      if (parts.length === 5 && parts[3] === 'p' && ID.test(parts[4])) return { name: 'person', gid: gid, pid: parts[4] };
      if (parts.length === 5 && parts[3] === 'import' && IMPORT_SOURCES.indexOf(parts[4]) >= 0) return { name: 'import', gid: gid, source: parts[4] };
    }
    if (parts[2] === 'raids') {
      if (parts.length === 4 && parts[3] === 'new') return { name: 'raidnew', gid: gid };
      if (parts.length === 5 && parts[3] === 'r' && ID.test(parts[4])) return { name: 'raid', gid: gid, rid: parts[4] };
    }
    if (parts[2] === 'attendance') {
      if (parts.length === 4 && parts[3] === 'review') return { name: 'review', gid: gid };
      if (parts.length === 4 && parts[3] === 'backfill') return { name: 'backfill', gid: gid };
      if (parts.length === 5 && parts[3] === 'p' && ID.test(parts[4])) return { name: 'personatt', gid: gid, pid: parts[4] };
    }
    if (parts[2] === 'loot' && parts.length === 5 && parts[3] === 'p' && ID.test(parts[4])) return { name: 'lootperson', gid: gid, pid: parts[4] };
    if (parts[2] === 'settings') {
      if (parts.length === 3) return { name: 'settings', gid: gid, tab: null };
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
      case 'planner': return '#/planner' + (isId(r.gid) && isId(r.rid) ? '?raid=' + r.gid + '.' + r.rid : '');
      case 'section': {
        const section = SECTIONS.indexOf(r.section) >= 0 ? r.section : 'roster';
        const team = section === 'roster' && typeof r.team === 'string' && ID.test(r.team) ? '?team=' + encodeURIComponent(r.team) : '';
        const view = section === 'loot' && LOOT_VIEWS.indexOf(r.view) >= 0 ? '?view=' + r.view : '';
        return '#/g/' + encodeURIComponent(r.gid) + '/' + section + team + view;
      }
      case 'person': return '#/g/' + encodeURIComponent(r.gid) + '/roster/p/' + encodeURIComponent(r.pid);
      case 'import': return '#/g/' + encodeURIComponent(r.gid) + '/roster/import/' + (IMPORT_SOURCES.indexOf(r.source) >= 0 ? r.source : 'raid-helper');
      case 'raidnew': return '#/g/' + encodeURIComponent(r.gid) + '/raids/new';
      case 'raid': return '#/g/' + encodeURIComponent(r.gid) + '/raids/r/' + encodeURIComponent(r.rid);
      case 'review': return '#/g/' + encodeURIComponent(r.gid) + '/attendance/review';
      case 'backfill': return '#/g/' + encodeURIComponent(r.gid) + '/attendance/backfill';
      case 'personatt': return '#/g/' + encodeURIComponent(r.gid) + '/attendance/p/' + encodeURIComponent(r.pid);
      case 'lootperson': return '#/g/' + encodeURIComponent(r.gid) + '/loot/p/' + encodeURIComponent(r.pid);
      case 'settings': return '#/g/' + encodeURIComponent(r.gid) + '/settings' + (TABS.indexOf(r.tab) >= 0 ? '/' + r.tab : '');
      default: return '#/';
    }
  }

  G.router = { SECTIONS: SECTIONS, TABS: TABS, LOOT_VIEWS: LOOT_VIEWS, IMPORT_SOURCES: IMPORT_SOURCES, LINKED_ERRORS: LINKED_ERRORS, parse: parse, format: format };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
