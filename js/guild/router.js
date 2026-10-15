// ── HASH ROUTES ─────────────────────────────────────────────────
// Pure parse/format for the guild page. Routes:
//   #/  #/signin[?error=..]  #/new  #/privacy
//   #/g/:gid/{roster,nights,attendance,loot}  #/g/:gid/settings[/{teams,people}]
(function (G) {
  'use strict';

  const SECTIONS = ['roster', 'nights', 'attendance', 'loot'];
  const TABS = ['teams', 'people'];
  const SIGNIN_ERRORS = ['denied', 'state', 'discord'];
  const ID = /^[A-Za-z0-9_-]{1,64}$/;

  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return null; }
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
      return { name: 'notfound' };
    }
    if (head !== 'g' || !ID.test(parts[1])) return { name: 'notfound' };
    const gid = parts[1];
    if (parts.length === 2) return { name: 'section', gid: gid, section: 'roster' };
    if (parts.length === 3 && SECTIONS.indexOf(parts[2]) >= 0) return { name: 'section', gid: gid, section: parts[2] };
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
      case 'section': return '#/g/' + encodeURIComponent(r.gid) + '/' + (SECTIONS.indexOf(r.section) >= 0 ? r.section : 'roster');
      case 'settings': return '#/g/' + encodeURIComponent(r.gid) + '/settings' + (TABS.indexOf(r.tab) >= 0 ? '/' + r.tab : '');
      default: return '#/';
    }
  }

  G.router = { SECTIONS: SECTIONS, TABS: TABS, parse: parse, format: format };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
