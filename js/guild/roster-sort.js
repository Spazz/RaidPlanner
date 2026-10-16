// ── ROSTER SORT AND FILTER (pure) ───────────────────────────────
// Sorting, filtering and counting for the Roster table. No DOM.
//   Rows are the `people` of GET /roster?team= (see the Phase 2 spec, "Response contract").
//   Columns: player | mainSpec | offSpec | status | joined | alts | signIn. Attendance is not sortable until Phase 3.
//   Default: Player A-Z with localeCompare, so Solvhand with an o-slash sorts with "So".
//   Status sorts Raider, Trial, Reserve, Inactive. Empty values (no off spec, no date) sort last either way.
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

  // Home team = the team of the person's Main. The trial strip, the badge and "Trials to decide" use it.
  function isFlaggedHere(p, teamId) {
    return !!(p && p.trialFlag) && mainOf(p).team && mainOf(p).team.id === teamId;
  }

  function trialsToDecide(people, teamId) {
    return (Array.isArray(people) ? people : []).filter(function (p) { return isFlaggedHere(p, teamId); });
  }

  function isActive(p) { return !!p && p.status !== 'inactive'; }

  function statusMatches(p, status, teamId) {
    switch (status) {
      case 'everyone': return true;
      case 'active': return isActive(p);
      case 'decide': return isFlaggedHere(p, teamId);
      case 'raider': case 'trial': case 'reserve': case 'inactive': return p.status === status;
      default: return isActive(p);
    }
  }

  function roleMatches(p, role) {
    if (!role || role === 'all') return true;
    return shownOf(p).role === role;
  }

  // The search looks at the names the list response carries: the shown character and the Main.
  function queryMatches(p, query) {
    const q = text(query).trim().toLowerCase();
    if (!q) return true;
    return nameOf(p).toLowerCase().indexOf(q) >= 0 || text(mainOf(p).name).toLowerCase().indexOf(q) >= 0;
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
        r = sign * ((STATUS_RANK[a.status] != null ? STATUS_RANK[a.status] : 9) - (STATUS_RANK[b.status] != null ? STATUS_RANK[b.status] : 9));
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
