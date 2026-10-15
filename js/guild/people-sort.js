// ── PEOPLE SORT (pure) ──────────────────────────────────────────
// Sorting, filtering and role labels for the People and roles table. No DOM.
//   Columns: person | roster | roles | lastSeen, direction asc | desc.
//   Default: Roles asc = Guild Master, Officer, Team Lead, Member, then display name.
//   Not linked (roster null) and Never seen (lastSeenAt null) sort last in either direction.
//   Last seen: asc = newest first, so the first click on that header shows who was here most recently.
(function (G) {
  'use strict';

  const COLUMNS = ['person', 'roster', 'roles', 'lastSeen'];
  const DEFAULT_SORT = { column: 'roles', dir: 'asc' };
  const ROLE_RANK = { guild_master: 0, officer: 1, team_lead: 2 };
  const MEMBER_RANK = 3;
  const ROLE_NAMES = { guild_master: 'Guild Master', officer: 'Officer', team_lead: 'Team Lead', member: 'Member' };

  function normalizeRole(r) {
    if (typeof r === 'string') return { role: r, teamId: null };
    if (r && typeof r === 'object' && typeof r.role === 'string') return { role: r.role, teamId: r.teamId == null ? null : String(r.teamId) };
    return null;
  }

  function normalizeRoles(roles) {
    return (Array.isArray(roles) ? roles : []).map(normalizeRole).filter(Boolean);
  }

  // Best (lowest) rank among the assigned roles; nobody with an assigned role is a plain Member.
  function roleRank(roles) {
    let best = MEMBER_RANK;
    normalizeRoles(roles).forEach(function (r) {
      const rank = Object.prototype.hasOwnProperty.call(ROLE_RANK, r.role) ? ROLE_RANK[r.role] : MEMBER_RANK;
      if (rank < best) best = rank;
    });
    return best;
  }

  // [{ kind, label }] for the Roles cell; empty roles display as Member. teams: the guild's team list (active and archived).
  function roleLabels(roles, teams) {
    const byId = {};
    (Array.isArray(teams) ? teams : []).forEach(function (t) { if (t && t.id != null) byId[String(t.id)] = t; });
    const out = [];
    normalizeRoles(roles).forEach(function (r) {
      if (r.role === 'guild_master') out.push({ kind: 'guild_master', label: ROLE_NAMES.guild_master });
      else if (r.role === 'officer') out.push({ kind: 'officer', label: ROLE_NAMES.officer });
      else if (r.role === 'team_lead') {
        const team = r.teamId != null ? byId[r.teamId] : null;
        out.push({ kind: 'team_lead', label: team ? ROLE_NAMES.team_lead + ': ' + team.name : ROLE_NAMES.team_lead });
      }
    });
    if (!out.length) out.push({ kind: 'member', label: ROLE_NAMES.member });
    out.sort(function (a, b) {
      const order = { guild_master: 0, officer: 1, team_lead: 2, member: 3 };
      return order[a.kind] - order[b.kind];
    });
    return out;
  }

  function nameOf(entry) {
    const p = entry && entry.person;
    return String((p && (p.displayName || p.username)) || '');
  }

  function compareText(a, b) {
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // Roster is null in Phase 1. Once it carries data, a string or an object with a name sorts by that text.
  function rosterKey(entry) {
    const r = entry && entry.roster;
    if (r == null) return null;
    if (typeof r === 'string') return r;
    if (typeof r === 'object' && typeof r.name === 'string') return r.name;
    return '';
  }

  function sortPeople(people, sort) {
    const column = sort && COLUMNS.indexOf(sort.column) >= 0 ? sort.column : DEFAULT_SORT.column;
    const sign = sort && sort.dir === 'desc' ? -1 : 1;
    const list = Array.isArray(people) ? people.slice() : [];
    list.sort(function (a, b) {
      let r = 0;
      if (column === 'person') {
        r = sign * compareText(nameOf(a), nameOf(b));
      } else if (column === 'roster') {
        const ka = rosterKey(a);
        const kb = rosterKey(b);
        if (ka == null && kb == null) r = 0;
        else if (ka == null) return 1;
        else if (kb == null) return -1;
        else r = sign * compareText(ka, kb);
      } else if (column === 'roles') {
        r = sign * (roleRank(a.roles) - roleRank(b.roles));
      } else {
        const ta = typeof a.lastSeenAt === 'number' ? a.lastSeenAt : null;
        const tb = typeof b.lastSeenAt === 'number' ? b.lastSeenAt : null;
        if (ta == null && tb == null) r = 0;
        else if (ta == null) return 1;
        else if (tb == null) return -1;
        else r = sign * (tb - ta);
      }
      if (r) return r;
      r = compareText(nameOf(a), nameOf(b));
      if (r) return r;
      return compareText(a && a.person ? a.person.id : '', b && b.person ? b.person.id : '');
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

  function filterPeople(people, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const list = Array.isArray(people) ? people : [];
    if (!q) return list.slice();
    return list.filter(function (e) {
      const p = e && e.person ? e.person : {};
      return String(p.displayName || '').toLowerCase().indexOf(q) >= 0 || String(p.username || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  G.peopleSort = {
    COLUMNS: COLUMNS,
    DEFAULT_SORT: DEFAULT_SORT,
    ROLE_NAMES: ROLE_NAMES,
    normalizeRoles: normalizeRoles,
    roleRank: roleRank,
    roleLabels: roleLabels,
    sortPeople: sortPeople,
    nextSort: nextSort,
    ariaSort: ariaSort,
    filterPeople: filterPeople,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
