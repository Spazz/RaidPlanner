// ── ROSTER SORT AND FILTER (pure) ───────────────────────────────
// Sorting, filtering and counting for the Roster table. No DOM.
//   Rows are the `people` of GET /roster?team= (see the Phase 2 spec, "Response contract").
//   Columns: player | mainSpec | offSpec | status | joined | alts | signIn. Attendance is not sortable until Phase 3.
//   Default: Player A-Z with localeCompare, so Solvhand with an o-slash sorts with "So".
//   Status sorts Raider, Trial, Reserve, Inactive. Empty values (no off spec, no date) sort last either way.
//   Rank is per CHARACTER (H-Q18): a row's rank and trial flag are the shown character's own (shown.coreRank, shown.trialFlag); a row without them (an older answer)
//   falls back to the person's (status, trialFlag of the Main's team).
(function (G) {
  'use strict';

  const COLUMNS = ['player', 'mainSpec', 'offSpec', 'status', 'joined', 'alts', 'signIn'];
  const DEFAULT_SORT = { column: 'player', dir: 'asc' };
  const STATUS_RANK = { raider: 0, trial: 1, reserve: 2, inactive: 3 };
  const SIGN_IN_RANK = { signed_in: 0, not_yet: 1, no_discord: 2 };
  const ROLES = ['all', 'tank', 'healer', 'dps'];
  const STATUS_FILTERS = ['active', 'raider', 'trial', 'reserve', 'inactive', 'decide', 'everyone'];
  const DEFAULT_FILTER = { role: 'all', status: 'active', query: '' };

  function text(v) { return String(v == null ? '' : v); }
  function compareText(a, b) { return text(a).localeCompare(text(b), 'en'); }

  function shownOf(p) { return (p && p.shown) || {}; }
  function mainOf(p) { return (p && p.main) || {}; }
  function nameOf(p) { return text(shownOf(p).name); }

  // The core rank of the character the row shows.
  function rankOf(p) {
    const own = shownOf(p).coreRank;
    return own !== undefined && own !== null ? own : p && p.status;
  }

  // The trial flag of the character the row shows ({ kind, days } or null). A row that carries no character-level fields is read as before: the person's flag, for the team of the Main.
  function trialFlagOf(p, teamId) {
    if (p && p.shown && Object.prototype.hasOwnProperty.call(p.shown, 'trialFlag')) return p.shown.trialFlag || null;
    return p && p.trialFlag && !!teamId && !!mainOf(p).team && mainOf(p).team.id === teamId ? p.trialFlag : null;
  }

  // "Trials to decide", the trial strip and the badge: a Trial character whose trial ends soon or ended, on the team the row is listed on.
  function isFlaggedHere(p, teamId) {
    return !!teamId && !!trialFlagOf(p, teamId);
  }

  function trialsToDecide(people, teamId) {
    return (Array.isArray(people) ? people : []).filter(function (p) { return isFlaggedHere(p, teamId); });
  }

  function isActive(p) { return !!p && rankOf(p) !== 'inactive'; }

  function statusMatches(p, status, teamId) {
    switch (status) {
      case 'everyone': return true;
      case 'active': return isActive(p);
      case 'decide': return isFlaggedHere(p, teamId);
      case 'raider': case 'trial': case 'reserve': case 'inactive': return rankOf(p) === status;
      default: return isActive(p);
    }
  }

  function roleMatches(p, role) {
    if (!role || role === 'all') return true;
    return shownOf(p).role === role;
  }

  // Accent-insensitive folding for the search: NFD, marks stripped, then letters NFD leaves whole.
  const FOLD_MAP = { '\u00f8': 'o', '\u00e6': 'ae', '\u0153': 'oe', '\u00df': 'ss', '\u0142': 'l', '\u0111': 'd', '\u00fe': 'th', '\u00f0': 'd' };
  function fold(s) {
    let out = text(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out = out.replace(/[\u00f8\u00e6\u0153\u00df\u0142\u0111\u00fe\u00f0]/g, function (c) { return FOLD_MAP[c]; });
    return out;
  }

  // Any name in row.names (all the person's characters on this team); the shown and Main names when it is absent.
  function queryMatches(p, query) {
    const q = fold(query).trim();
    if (!q) return true;
    const list = Array.isArray(p && p.names) && p.names.length ? p.names : [nameOf(p), mainOf(p).name];
    return list.some(function (n) { return fold(n).indexOf(q) >= 0; });
  }

  // filter: { role, status, query }; teamId decides which people count as "Trials to decide".
  function filterPeople(people, filter, teamId) {
    const f = Object.assign({}, DEFAULT_FILTER, filter || {});
    return (Array.isArray(people) ? people : []).filter(function (p) {
      return statusMatches(p, f.status, teamId) && roleMatches(p, f.role) && queryMatches(p, f.query);
    });
  }

  // Counts for the role buttons come from the active people (Inactive never counts).
  function roleCounts(people) {
    const out = { all: 0, tank: 0, healer: 0, dps: 0 };
    (Array.isArray(people) ? people : []).forEach(function (p) {
      if (!isActive(p)) return;
      out.all++;
      const role = shownOf(p).role;
      if (Object.prototype.hasOwnProperty.call(out, role) && role !== 'all') out[role]++;
    });
    return out;
  }

  function activeCount(people) { return (Array.isArray(people) ? people : []).filter(isActive).length; }
  function inactiveCount(people) { return (Array.isArray(people) ? people : []).length - activeCount(people); }

  function specKey(s, which) {
    const shown = shownOf(s);
    return which === 'mainSpec' ? text(shown.class) + '|' + text(shown.mainSpec) : text(shown.offSpec);
  }

  function sortPeople(people, sort) {
    const column = sort && COLUMNS.indexOf(sort.column) >= 0 ? sort.column : DEFAULT_SORT.column;
    const sign = sort && sort.dir === 'desc' ? -1 : 1;
    const list = Array.isArray(people) ? people.slice() : [];
    list.sort(function (a, b) {
      let r = 0;
      if (column === 'player') {
        r = sign * compareText(nameOf(a), nameOf(b));
      } else if (column === 'mainSpec') {
        r = sign * compareText(specKey(a, 'mainSpec'), specKey(b, 'mainSpec'));
      } else if (column === 'offSpec') {
        const ka = specKey(a, 'offSpec');
        const kb = specKey(b, 'offSpec');
        if (!ka && !kb) r = 0;
        else if (!ka) return 1;
        else if (!kb) return -1;
        else r = sign * compareText(ka, kb);
      } else if (column === 'status') {
        r = sign * ((STATUS_RANK[rankOf(a)] != null ? STATUS_RANK[rankOf(a)] : 9) - (STATUS_RANK[rankOf(b)] != null ? STATUS_RANK[rankOf(b)] : 9));
      } else if (column === 'joined') {
        const ka = text(a.joinedOn);
        const kb = text(b.joinedOn);
        if (!ka && !kb) r = 0;
        else if (!ka) return 1;
        else if (!kb) return -1;
        else r = sign * (ka < kb ? -1 : ka > kb ? 1 : 0);
      } else if (column === 'alts') {
        r = sign * ((a.altCount || 0) - (b.altCount || 0));
      } else {
        r = sign * ((SIGN_IN_RANK[a.signIn] != null ? SIGN_IN_RANK[a.signIn] : 9) - (SIGN_IN_RANK[b.signIn] != null ? SIGN_IN_RANK[b.signIn] : 9));
      }
      if (r) return r;
      r = compareText(nameOf(a), nameOf(b));
      if (r) return r;
      return compareText(a && a.id, b && b.id);
    });
    return list;
  }

  // Clicking the active header flips its direction; a new column starts ascending.
  function nextSort(current, column) {
    if (COLUMNS.indexOf(column) < 0) return current || { column: DEFAULT_SORT.column, dir: DEFAULT_SORT.dir };
    if (current && current.column === column) return { column: column, dir: current.dir === 'asc' ? 'desc' : 'asc' };
    return { column: column, dir: 'asc' };
  }

  function ariaSort(sort, column) {
    if (!sort || sort.column !== column) return null;
    return sort.dir === 'desc' ? 'descending' : 'ascending';
  }

  G.rosterSort = {
    COLUMNS: COLUMNS,
    DEFAULT_SORT: DEFAULT_SORT,
    DEFAULT_FILTER: DEFAULT_FILTER,
    ROLES: ROLES,
    STATUS_FILTERS: STATUS_FILTERS,
    fold: fold,
    rankOf: rankOf,
    trialFlagOf: trialFlagOf,
    isFlaggedHere: isFlaggedHere,
    trialsToDecide: trialsToDecide,
    filterPeople: filterPeople,
    roleCounts: roleCounts,
    activeCount: activeCount,
    inactiveCount: inactiveCount,
    sortPeople: sortPeople,
    nextSort: nextSort,
    ariaSort: ariaSort,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
