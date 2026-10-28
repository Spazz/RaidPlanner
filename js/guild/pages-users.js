// ── PAGES: USERS (lane B8a-users) ──
// #/g/:gid/users[/<segment>] is the Users list (template T1, reference pages-roster.js) and #/g/:gid/users/u/:key one user (template T2, reference pages-person.js), for whoever holds
// guild.access (shell.js canSeeUsers; app.js checks it before the page loads). It replaces Settings > Accounts, whose two addresses now open it.
//   List     four segments (Members, Former, Non-members, Blocked), each its own address; search, a rank filter (members, former) or a source filter (non-members), sortable heads
//            (the Worker sorts and pages: GET /users?segment=&sort=&dir=&q=&rank=&from=&offset=&limit=), 10 rows and "Show all". More: Manage users, Sync now.
//   Manage   selection mode from the head's More: a checkbox per row (none on your own), a bar with Block (Unblock on Blocked), Add to a person (non-members, a guild with hand-set ranks) and
//            Done. More than 25 names go in chunks (POST /users/block | /users/unblock); the result is a list dialog of done and skipped names with the API's message each.
//   User     characters with rank, core rank and team; Permission (where each comes from) with Edit permission; Identity; Block; for a block that waits for review the Keep / Restore decision.
//            Edit permission is the dialog that moved here from Accounts (hand-set boxes; a role the rank gives is listed under them, ticking its box keeps it: pin true) with the Owner seat's hand-over.
// Reads and writes: GET /users, GET /users/:ukey, POST /users/block | unblock | add-to-person, PUT /people/:uid/roles, POST /people/:uid/guild-master, POST .../block/keep, DELETE .../block,
// GET /roles (the guild's own roles for the dialog), GET | POST /roster-sync. main(r, gd, ctx) is what app.js calls to draw the page; load(r, gd) its read.
(function (G) {
  'use strict';

  const enc = encodeURIComponent;
  const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  const plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  // The segments: the Worker's word (also the route's `segment`), the tab label, what the table calls its rows, the line for an empty one.
  const SEGMENTS = [
    { id: 'members', label: 'Members', noun: 'members', table: 'Members', none: 'No members to show.' },
    { id: 'former', label: 'Former', noun: 'former members', table: 'Former members', none: 'No former members.' },
    { id: 'nonmembers', label: 'Non-members', noun: 'non-members', table: 'Non-members', none: 'No non-members to show.' },
    { id: 'blocked', label: 'Blocked', noun: 'blocked users', table: 'Blocked users', none: 'No one is blocked.' },
  ];
  const segmentDef = function (id) { return SEGMENTS.filter(function (s) { return s.id === id; })[0] || SEGMENTS[0]; };
  const SEGMENT_SINGULAR = { members: 'Member', former: 'Former member', nonmembers: 'Non-member', blocked: 'Blocked' };
  const RANK_LABELS = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve', social: 'Social' };
  // The tags of a non-member (where Raidsmith saw them): data labels, in the Worker's order.
  const TAG_LABELS = { discord_signin: 'Discord sign-in', application: 'Application', guest_signup: 'Guest sign-up', raid_helper: 'Raid-Helper', raid_log: 'Raid log', loot: 'Loot' };
  const SOURCE_TAGS = ['discord_signin', 'application', 'guest_signup', 'raid_helper', 'raid_log', 'loot'];
  const SIGN_IN_LABELS = { battlenet: 'Battle.net', discord: 'Discord' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const SORT_COLUMNS = [['user', 'User'], ['main', 'Main character'], ['permission', 'Permission'], ['lastSeen', 'Last seen']];

  const FIRST_ROWS = 10;      // the first page of a list ("Show all N" reads the rest)
  const ALL_STEP = 100;       // GET /users returns at most 100 rows
  const ALL_CAP = 500;        // "Show all" stops here: a long list of names is narrowed with the search or the filter
  const BLOCK_CHUNK = 25;     // worker/users-bulk.js BULK_MAX_NAMES
  const ADD_CHUNK = 10;       // worker/users-add-to-person.js ADD_MAX_NAMES
  const PEOPLE_SHOWN = 5;     // the people the Add to a person dialog lists
  const NAMES_SHOWN = 10;     // names a confirm dialog lists before "and N more"
  const SEARCH_MS = 300;

  // ── what the page remembers ──
  let view = null;        // the list's own choices: { gid, segment, q, rank, from, sort, dir, all }
  let list = null;        // the last read: { gid, segment, rows, more, counts, battlenetOnly, coreRanks, error }
  let manage = null;      // selection mode: { picked: { <key>: { key, kind, name, main } } } or null
  let flash = null;       // one result banner above the list or the page: { tone, title, text }
  let user = null;        // the user page's read: { gid, key, data } or { gid, key, error }
  let sync = null;        // the in-game roster's sync status for Sync now: { gid, lastChecked } or null
  let listSeq = 0;        // a read that is not the newest is dropped
  let searchTimer = null;
  let addTimer = null;
  let blockTarget = null; // what the open Block dialog blocks: { mode: 'list' | 'page', entries: [{ key, kind, name, main }] }
  let addState = null;    // the open Add to a person dialog

  function st() { return G.app.state; }
  function currentGd() {
    const s = st();
    return s.currentGid ? s.guilds[s.currentGid] : null;
  }
  function myId() {
    const me = st().me;
    return me && me.user ? me.user.id : null;
  }
  function holds(gd, action) {
    const can = gd && gd.me && gd.me.can ? gd.me.can : null;
    return !!can && can[action] === 'guild';
  }
  function isGuildMaster(gd) { return !!(gd && gd.me && Array.isArray(gd.me.roles) && gd.me.roles.some(function (r) { return r && r.role === 'guild_master'; })); }
  function usersPath(gid, tail) { return '/api/guild/' + enc(gid) + '/users' + (tail || ''); }
  function peoplePath(gid, uid, tail) { return '/api/guild/' + enc(gid) + '/people/' + enc(uid) + (tail || ''); }
  function usersHref(gid, segment) { return G.router.format({ name: 'users', gid: gid, segment: segment === 'members' ? null : segment || null }); }
  function userHref(gid, key) { return G.router.format({ name: 'user', gid: gid, key: key }); }
  function byId(id) { return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null; }
  function ensureAttention(gid) { return G.app.ensureAttention ? G.app.ensureAttention(gid, true) : Promise.resolve(null); }

  // 'YYYY-MM-DD' -> "Oct 26" (with the year when it is not this year); '' for nothing.
  function shortDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
    return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + (Number(m[1]) === new Date().getFullYear() ? '' : ', ' + m[1]);
  }
  const DASH_HTML = '<span class="gs-muted" aria-label="No activity">\u2014</span>';
  function seenHtml(row) { return row.lastSeen ? esc(shortDay(row.lastSeen)) : DASH_HTML; }

  function tagsText(row) {
    return (Array.isArray(row.tags) ? row.tags : []).map(function (t) { return has(TAG_LABELS, t) ? TAG_LABELS[t] : t; }).join(' \u00b7 ');
  }
  function flagsOf(row) { return row && row.flags && typeof row.flags === 'object' ? row.flags : {}; }
  function chipHtml(tone, label) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(label) + '</span>'; }
  function crestHtml(classId, size) { return G.ui.specIconHtml(classId, null, size || 18); }
  function mainHtml(main) {
    return main ? '<span class="gs-us-chr">' + crestHtml(main.class, 18) + G.ui.classNameHtml(main.name, main.class) + '</span>' : '<span class="gs-muted" aria-label="No main character">\u2014</span>';
  }
  function permissionHtml(row) {
    const f = flagsOf(row);
    if (!row.permission) return '<span class="gs-muted">None</span>';
    return esc(row.permission) + (f.owner || f.suspended ? '<span class="gs-fine gs-us-sub">Owner seat</span>' : '');
  }

  // ── the list: the model ──
  function newView(gid, segment) { return { gid: gid, segment: segment, q: '', rank: '', from: '', sort: 'user', dir: 'asc', all: false }; }
  function segmentOf(r) { return r && SEGMENTS.some(function (s) { return s.id === r.segment; }) ? r.segment : 'members'; }
  function filteredBy(v) { return !!(v && (v.q.trim() || (v.rank && (v.segment === 'members' || v.segment === 'former')) || (v.from && v.segment === 'nonmembers'))); }

  function listQuery(v, offset, limit) {
    const parts = ['segment=' + enc(v.segment), 'sort=' + enc(v.sort), 'dir=' + enc(v.dir), 'offset=' + offset, 'limit=' + limit];
    if (v.q.trim()) parts.push('q=' + enc(v.q.trim()));
    if (v.rank && (v.segment === 'members' || v.segment === 'former')) parts.push('rank=' + enc(v.rank));
    if (v.from && v.segment === 'nonmembers') parts.push('from=' + enc(v.from));
    return parts.join('&');
  }

  // The first rows, or (Show all) every page of 100 up to ALL_CAP. -> Promise<{ rows, more, counts, battlenetOnly, coreRanks }>
  function readList(v) {
    const first = !v.all;
    const step = first ? FIRST_ROWS : ALL_STEP;
    const out = { rows: [], more: false, counts: null, battlenetOnly: false, coreRanks: null };
    function page(offset) {
      return G.api.get(usersPath(v.gid, '?' + listQuery(v, offset, step))).then(function (res) {
        const r = res || {};
        out.rows = out.rows.concat(Array.isArray(r.rows) ? r.rows : []);
        out.more = r.more === true;
        out.counts = r.counts || out.counts;
        out.battlenetOnly = r.battlenetOnly === true;
        out.coreRanks = Array.isArray(r.coreRanks) ? r.coreRanks : out.coreRanks;
        if (!first && out.more && out.rows.length < ALL_CAP) return page(offset + step);
        return out;
      });
    }
    return page(0);
  }

  // A failed read that the app has a page for (signed out, no access) goes to the app; anything else (network, rate limit) is this page's own error region.
  function isAppError(err) {
    const c = G.api.classify(err);
    return c.view === 'signin' || c.view === 'message';
  }

  function applyRead(gid, v, res) {
    list = { gid: gid, segment: v.segment, rows: res.rows, more: res.more, counts: res.counts || { members: 0, former: 0, nonmembers: 0, blocked: 0 }, battlenetOnly: res.battlenetOnly, coreRanks: res.coreRanks, error: '' };
  }

  // How many blocks wait for a decision: the Home list's block_review item.
  function attentionPending(gid) {
    const e = st().attention ? st().attention[gid] : null;
    const items = e && e.data && Array.isArray(e.data.items) ? e.data.items : [];
    const item = items.filter(function (i) { return i && i.kind === 'block_review'; })[0];
    const n = item ? Number(item.pending) : 0;
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const segment = segmentOf(r);
    if (!view || view.gid !== gid || view.segment !== segment) view = newView(gid, segment);
    manage = null;
    flash = null;
    const mine = ++listSeq;
    const v = view;
    const read = readList(v).then(function (res) {
      if (mine === listSeq) applyRead(gid, v, res);
    }, function (err) {
      if (isAppError(err)) throw err;
      if (mine === listSeq) list = { gid: gid, segment: segment, rows: [], more: false, counts: list && list.gid === gid ? list.counts : null, battlenetOnly: false, coreRanks: null, error: G.api.classify(err).text };
    });
    return Promise.all([read, ensureAttention(gid)]).then(function () { return loadSyncStatus(gd); }).then(function () { return null; });
  }

  // ── the list: pieces ──
  function segsHtml(m) {
    const counts = m.list.counts || {};
    const button = function (cls, s, keyPrefix) {
      return '<button type="button" class="' + cls + '" data-action="users-seg" data-seg="' + s.id + '" data-key="' + keyPrefix + s.id + '" aria-pressed="' + (m.segment === s.id ? 'true' : 'false') + '">' + s.label + ' <span class="gs-fg-segn">' + (Number(counts[s.id]) || 0) + '</span></button>';
    };
    return '<div class="gs-fg-segs gs-rs-dsegs" role="group" aria-label="Show">' + SEGMENTS.map(function (s) { return button('gs-fg-seg', s, 'useg-'); }).join('') + '</div>' +
      '<div class="gs-rs-psegs is-scroll"><div class="gs-fg-pills" role="group" aria-label="Show">' + SEGMENTS.map(function (s) { return button('gs-fg-pill', s, 'upseg-'); }).join('') + '</div></div>';
  }

  function filterSelectHtml(id, label, which, options, value) {
    return '<div class="gs-us-filter"><label class="gs-sr" for="' + id + '">' + esc(label) + '</label><div class="gs-fg-selw"><select class="gs-input" id="' + id + '" data-change="users-filter" data-filter="' + which + '">' +
      options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>' + G.icons.icon('chevronDown', 14) + '</div></div>';
  }

  // The rank filter lists only the core ranks the guild maps (the Worker says which); a non-member list filters by where the name was seen.
  function filterHtml(m) {
    if (m.segment === 'members' || m.segment === 'former') {
      const ranks = (Array.isArray(m.list.coreRanks) ? m.list.coreRanks : []).filter(function (id) { return has(RANK_LABELS, id); });
      return filterSelectHtml('users-rank', 'Core rank', 'rank', [['', 'All ranks']].concat(ranks.map(function (id) { return [id, RANK_LABELS[id]]; })), m.view.rank);
    }
    if (m.segment === 'nonmembers') {
      return filterSelectHtml('users-from', 'Where from', 'from', [['', 'All sources']].concat(SOURCE_TAGS.map(function (t) { return [t, TAG_LABELS[t]]; })), m.view.from);
    }
    return '';
  }

  function searchHtml(m) {
    return '<div class="gs-rs-search"><label class="gs-sr" for="users-search">Search users</label>' + G.icons.icon('search', 16) +
      '<input class="gs-rs-input" type="search" id="users-search" placeholder="Search users" data-input="users-search" autocomplete="off" maxlength="40" value="' + esc(m.view.q) + '"></div>';
  }

  // "Needs you": the one item the Users page owns, blocks that matched an earlier one and wait for a decision (attention block_review). The block is named when the Blocked list can say which it is.
  function needsHtml(m) {
    if (!(m.pending > 0)) return '';
    const review = m.list.segment === 'blocked' ? m.list.rows.filter(function (r) { return flagsOf(r).pendingReview; }) : [];
    const text = m.pending === 1 && review.length === 1
      ? '<a class="gs-fg-u" href="' + esc(userHref(m.gid, review[0].key)) + '">' + esc(review[0].name) + '</a>\'s block matched an earlier one and waits for your review'
      : '<a class="gs-fg-u" href="' + esc(usersHref(m.gid, 'blocked')) + '">' + esc(plural(m.pending, 'block', 'blocks')) + '</a> matched an earlier one and ' + (m.pending === 1 ? 'waits' : 'wait') + ' for your review';
    return '<section class="gs-hd-panel gs-rs-needs" aria-label="Needs you"><h2 class="gs-fg-lbl">Needs you</h2><div class="gs-rs-needlist"><span class="gs-rs-need">' + text + '</span></div></section>';
  }

  function userCellHtml(m, row, plain) {
    const f = flagsOf(row);
    const second = row.kind === 'person' ? 'No account yet' : tagsText(row);
    const chips = (f.pendingReview ? chipHtml('rose', 'Needs review') : '') + (f.suspended ? chipHtml('rose', 'Suspended') : '');
    const tag = plain ? 'span' : 'a';
    return '<' + tag + ' class="gs-person gs-us-user"' + (tag === 'a' ? ' href="' + esc(userHref(m.gid, row.key)) + '"' : '') + '>' + G.ui.avatarHtml({ displayName: row.name }, 'gs-avatar-md') +
      '<span class="gs-person-text"><span class="gs-person-line"><span class="gs-person-name">' + esc(row.name) + '</span>' + chips + '</span>' + (second ? '<span class="gs-person-user">' + esc(second) + '</span>' : '') + '</span></' + tag + '>';
  }

  function isMine(m, row) { return !!m.meId && row.key === m.meId; }
  function pickedOf(m, row) { return !!(m.manage && has(m.manage.picked, row.key)); }
  function pickBoxHtml(m, row) {
    if (isMine(m, row)) return '<span class="gs-us-chkbox is-off" aria-hidden="true"></span>';
    return '<label class="gs-us-chkbox"><input type="checkbox" class="gs-us-chk" data-change="users-pick" data-pick="' + esc(row.key) + '"' + (pickedOf(m, row) ? ' checked' : '') + ' aria-label="Select ' + esc(row.name) + '"></label>';
  }

  function tableHtml(m) {
    const seg = segmentDef(m.segment);
    const editing = !!m.manage;
    const columns = (editing ? [{ key: 'sel', label: 'Select', srLabel: true }] : []).concat(SORT_COLUMNS.map(function (c) {
      return { key: c[0], label: c[1], primary: c[0] === 'user', sort: m.view.sort === c[0] ? (m.view.dir === 'desc' ? 'descending' : 'ascending') : true, sortAction: 'users-sort', sortKey: 'users-sort-' + c[0] };
    }));
    const rows = m.list.rows.map(function (row) {
      const cells = { user: userCellHtml(m, row, editing), main: mainHtml(row.main), permission: permissionHtml(row), lastSeen: seenHtml(row) };
      if (editing) cells.sel = pickBoxHtml(m, row);
      return { id: row.key, you: isMine(m, row), cells: cells };
    });
    return G.ui.dataTableHtml({ key: 'users-' + m.segment, label: seg.table, noun: seg.noun, columns: columns, rows: rows, showAll: true });
  }

  // A phone row: line 1 the name (You, No account yet, a chip) and the main character, line 2 the permission (a non-member: where it was seen) and when.
  function phoneRowHtml(m, row) {
    const f = flagsOf(row);
    const you = isMine(m, row);
    const tags = tagsText(row).replace(/ \u00b7 /g, ', ');
    const facts = [tags || (row.permission ? esc(row.permission) + (f.owner || f.suspended ? ', Owner seat' : '') : '<span class="gs-muted">None</span>'), row.lastSeen ? esc(shortDay(row.lastSeen)) : '<span class="gs-muted">\u2014</span>'];
    const l1 = '<span class="gs-us-urow-l1"><span class="gs-rs-name">' + esc(row.name) + '</span>' + (you ? '<span class="gs-you">You</span>' : '') + (row.kind === 'person' ? '<span class="gs-us-urow-note">No account yet</span>' : '') +
      (f.pendingReview ? chipHtml('rose', 'Needs review') : '') + (f.suspended ? chipHtml('rose', 'Suspended') : '') +
      (row.main ? '<span class="gs-us-urow-main">' + crestHtml(row.main.class, 16) + G.ui.classNameHtml(row.main.name, row.main.class) + '</span>' : '') + '</span>';
    const body = G.ui.avatarHtml({ displayName: row.name }, 'gs-avatar-md') + '<span class="gs-rs-id">' + l1 + '<span class="gs-rs-sub">' + facts.join(' \u00b7 ') + '</span></span>';
    if (m.manage) return '<div class="gs-rs-row gs-us-urow' + (you ? ' is-you' : '') + '">' + pickBoxHtml(m, row) + body + '</div>';
    return '<a class="gs-rs-row gs-us-urow' + (you ? ' is-you' : '') + '" href="' + esc(userHref(m.gid, row.key)) + '">' + body + '</a>';
  }

  // "Showing 10 of 53 members" and Show all; with a search or a filter the total is not known, so the line says how many are on screen.
  function footLine(m) {
    const seg = segmentDef(m.segment);
    const shown = m.list.rows.length;
    const total = !filteredBy(m.view) && m.list.counts ? Number(m.list.counts[m.segment]) : null;
    const known = m.list.more && total != null && isFinite(total) && total >= shown;
    return {
      text: 'Showing ' + shown + (known ? ' of ' + total : '') + ' ' + seg.noun + (m.view.all && m.list.more ? '. Search or filter to narrow the list.' : ''),
      all: !m.view.all && m.list.more ? 'Show all' + (known ? ' ' + total : '') : '',
    };
  }

  function resultsHtml(m) {
    if (m.list.error) {
      return G.ui.errorRegionHtml({ title: 'We couldn\'t load the users.', text: m.list.error, safe: 'Nothing you saved was lost.', retry: { variant: 'primary', size: undefined, attrs: { 'data-action': 'users-retry', 'data-key': 'users-retry' } } });
    }
    if (!m.list.rows.length) {
      return filteredBy(m.view)
        ? G.ui.emptyStateHtml({ kind: 'filtered', title: 'No users match.', text: 'Try a different name or clear the filters.', actions: [{ label: 'Clear filters', variant: 'secondary', attrs: { 'data-action': 'users-clear', 'data-key': 'users-clear' } }] })
        : G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: segmentDef(m.segment).none });
    }
    const foot = footLine(m);
    const showAll = foot.all ? ' <button type="button" class="gs-linkbtn" data-action="users-all" data-key="users-all">' + esc(foot.all) + '</button>' : '';
    // The table's own foot is off (the Worker pages the rows, the table does not): the same foot goes inside its frame.
    const deskFoot = '<div class="gs-dtable-foot"><span class="gs-fine">' + esc(foot.text) + '</span>' + showAll + '</div>';
    return '<div class="gs-rs-results gs-us-t-' + m.segment + ' ' + (m.manage ? 'gs-us-c5' : 'gs-us-c4') + '"><div class="gs-rs-desk">' + tableHtml(m).replace(/<\/div>$/, function () { return deskFoot + '</div>'; }) + '</div>' +
      '<div class="gs-rs-phone"><section class="gs-hd-panel gs-rs-plist" aria-label="' + esc(segmentDef(m.segment).table) + '">' + m.list.rows.map(function (row) { return phoneRowHtml(m, row); }).join('') +
      '</section><p class="gs-fine gs-us-pfoot">' + esc(foot.text) + showAll + '</p></div></div>';
  }

  function footNote(m) {
    if (m.segment === 'members') return m.list.battlenetOnly ? 'Members come from the in-game guild roster.' : 'Members are the people who have access to this guild.';
    if (m.segment === 'former') return 'People whose characters have all left the guild. Their history stays.';
    if (m.segment === 'nonmembers') return 'People Raidsmith has seen without a character on the guild roster.';
    return 'Blocked users cannot sign in to ' + m.guildName + '. Their history stays.';
  }

  // ── Manage users: the bar ──
  function addPersonAvailable(m) {
    return m.segment === 'nonmembers' && !m.list.battlenetOnly && holds(m.gd, 'roster.edit');
  }
  function pickedList(mg) { return mg ? Object.keys(mg.picked).map(function (k) { return mg.picked[k]; }) : []; }

  function selBarInner(m) {
    const picked = pickedList(m.manage);
    const n = picked.length;
    let acts = '';
    if (m.segment === 'blocked') {
      acts = G.ui.buttonHtml({ label: 'Unblock', size: 'sm', disabled: n === 0, attrs: { 'data-action': 'users-unblock', 'data-key': 'users-unblock' } });
    } else {
      if (addPersonAvailable(m)) acts += G.ui.buttonHtml({ label: 'Add to a person', size: 'sm', disabled: n === 0 || !picked.every(function (p) { return p.kind === 'name'; }), attrs: { 'data-action': 'users-add-open', 'data-key': 'users-add-open' } });
      acts += G.ui.buttonHtml({ label: 'Block', size: 'sm', disabled: n === 0, attrs: { 'data-action': 'users-block-open', 'data-key': 'users-block-open' } });
    }
    return '<span class="gs-us-selcount" role="status">' + n + ' selected</span><span class="gs-us-selacts">' + acts + G.ui.buttonHtml({ label: 'Done', size: 'sm', attrs: { 'data-action': 'users-done', 'data-key': 'users-done' } }) + '</span>';
  }

  function headMoreItems(m) {
    const items = [];
    if (holds(m.gd, 'guild.access')) items.push({ label: 'Manage users', data: { action: 'users-manage' }, key: 'users-manage' });
    if (m.syncAvailable) {
      if (items.length) items.push({ separator: true });
      items.push({ label: 'Sync now', note: m.sync && m.sync.lastChecked ? 'Last checked ' + m.sync.lastChecked : undefined, data: { action: 'users-sync' }, key: 'users-sync' });
    }
    return items;
  }

  function flashHtml(f) {
    return f ? G.ui.bannerHtml({ tone: f.tone || 'success', title: f.title, text: f.text }) : '';
  }

  function modelOf(opts) {
    const gd = opts.guildData;
    const v = opts.view || newView(gd.guild.id, segmentOf(opts.route));
    const l = opts.list || { rows: [], more: false, counts: null, battlenetOnly: false, coreRanks: null, error: '', segment: v.segment };
    return {
      gd: gd, gid: gd.guild.id, guildName: gd.guild.name, segment: v.segment, view: v, list: l, manage: opts.manage || null, pending: opts.pending || 0, meId: opts.meId || null, sync: opts.sync || null,
      // Sync now: an in-game guild's roster, for the Guild Master, once the status read answered.
      syncAvailable: !!(l.battlenetOnly && opts.sync && isGuildMaster(gd) && G.shell.hasAction(gd.me && gd.me.can, 'guild.teams')),
    };
  }

  // opts: { guildData, route, view, list, manage, pending (blocks waiting for review), meId, flash, notice, sync (Sync now's status or null) }
  function listHtml(opts) {
    const m = modelOf(opts);
    const counts = m.list.counts || {};
    const total = SEGMENTS.reduce(function (n, s) { return n + (Number(counts[s.id]) || 0); }, 0);
    const items = headMoreItems(m);
    const head = G.ui.pageHeadHtml({ title: 'Users', context: m.list.counts ? plural(total, 'user', 'users') : m.guildName, more: items.length ? { id: 'users-more', key: 'users-more', items: items } : null });
    const notices = flashHtml(opts.flash) + (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span><button type="button" class="gs-linkbtn" data-action="users-notice-dismiss" data-key="users-notice-dismiss">Dismiss</button></div>' : '');
    const hint = m.manage ? '<p class="gs-fg-mut gs-us-hint">' + (m.segment === 'blocked' ? 'Tick the users to unblock.' : 'Tick the users to block.') + '</p>' : needsHtml(m);
    const people = '<section class="gs-rs-people" aria-label="Users"><div class="gs-rs-bar"><div class="gs-us-barleft">' + searchHtml(m) + filterHtml(m) + '</div>' + segsHtml(m) + '</div><div id="users-results" aria-live="off">' + resultsHtml(m) + '</div>' +
      (m.manage || m.list.error ? '' : '<p class="gs-fg-mut gs-rs-foot">' + esc(footNote(m)) + '</p>') + '</section>';
    const bar = m.manage ? '<div class="gs-hd-panel gs-us-selbar" id="users-selbar" role="region" aria-label="Selected users">' + selBarInner(m) + '</div>' : '';
    return '<div class="gs-page gs-list-page gs-forge gs-roster-page gs-users-page">' + head + notices + hint + people + bar + '</div>';
  }

  // What the page holds, as the options listHtml takes (null until the read for this guild is in).
  function modelInputs() {
    const gd = currentGd();
    if (!gd || !list || !view || list.gid !== gd.guild.id || view.gid !== gd.guild.id) return null;
    return { guildData: gd, view: view, list: list, manage: manage, pending: attentionPending(gd.guild.id), meId: myId(), flash: flash, notice: st().notice, sync: sync && sync.gid === gd.guild.id ? sync : null };
  }

  function listMain(r, gd) {
    const inputs = modelInputs();
    if (!inputs || list.segment !== segmentOf(r)) {
      return '<div class="gs-page gs-list-page gs-forge gs-roster-page gs-users-page">' + G.ui.pageHeadHtml({ title: 'Users', context: gd.guild.name }) + G.ui.loadingHtml({ label: 'Loading users', rows: 6 }) + '</div>';
    }
    return listHtml(Object.assign({ route: r }, inputs));
  }

  // The results (and the bar) drawn again in place: a search or a sort must not take the focus away from the control that started it.
  function redrawResults(focusKey) {
    const host = byId('users-results');
    const inputs = modelInputs();
    if (!host || !inputs) return;
    host.innerHTML = resultsHtml(modelOf(inputs));
    if (focusKey) G.ui.focusByKey(focusKey, { preventScroll: true });
  }
  function redrawBar() {
    const bar = byId('users-selbar');
    const inputs = modelInputs();
    if (!bar || !inputs) return;
    bar.innerHTML = selBarInner(modelOf(inputs));
  }
  function rerender() { G.app.render(); }

  // ── the list: behaviour ──
  function readFailed(mine, err) {
    if (mine !== listSeq) return false;
    if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return false; }
    list = Object.assign({}, list, { rows: [], more: false, error: G.api.classify(err).text });
    return true;
  }

  // The list read again with the page's choices (search, filter, sort, Show all), drawn in place.
  function refetch(focusKey) {
    const gd = currentGd();
    if (!gd || !view) return Promise.resolve();
    const mine = ++listSeq;
    const v = Object.assign({}, view);
    return readList(v).then(function (res) {
      if (mine !== listSeq) return;
      applyRead(gd.guild.id, v, res);
      redrawResults(focusKey);
      redrawBar();
    }, function (err) { if (readFailed(mine, err)) redrawResults(); });
  }

  // After a change that moves people between segments or changes the counts: the list and the strip are read again and the whole page is drawn.
  function reloadList() {
    const gd = currentGd();
    if (!gd || !view) return Promise.resolve();
    const mine = ++listSeq;
    const v = Object.assign({}, view);
    return Promise.all([readList(v), ensureAttention(gd.guild.id)]).then(function (got) {
      if (mine !== listSeq) return;
      applyRead(gd.guild.id, v, got[0]);
      rerender();
    }, function (err) { if (readFailed(mine, err)) rerender(); });
  }

  G.handlers.click['users-seg'] = function (el) {
    const gd = currentGd();
    const seg = el.getAttribute('data-seg');
    if (!gd || !SEGMENTS.some(function (s) { return s.id === seg; }) || (view && view.segment === seg)) return;
    G.app.go(usersHref(gd.guild.id, seg));
  };
  G.handlers.input['users-search'] = function (el) {
    if (!view) return;
    view.q = String(el.value || '');
    view.all = false;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { searchTimer = null; refetch(); }, SEARCH_MS);
  };
  G.handlers.change['users-filter'] = function (el) {
    if (!view) return;
    const which = el.getAttribute('data-filter');
    if (which !== 'rank' && which !== 'from') return;
    view[which] = String(el.value || '');
    view.all = false;
    refetch();
  };
  G.handlers.click['users-sort'] = function (el) {
    if (!view) return;
    const col = el.getAttribute('data-sort');
    if (!SORT_COLUMNS.some(function (c) { return c[0] === col; })) return;
    if (view.sort === col) view.dir = view.dir === 'asc' ? 'desc' : 'asc';
    else { view.sort = col; view.dir = 'asc'; }
    view.all = false;
    refetch('users-sort-' + col);
  };
  G.handlers.click['users-all'] = function () {
    if (!view) return;
    view.all = true;
    refetch('users-all');
  };
  G.handlers.click['users-clear'] = function () {
    if (!view) return;
    view.q = ''; view.rank = ''; view.from = ''; view.all = false;
    refetch().then(rerender);
  };
  G.handlers.click['users-retry'] = function () { refetch('users-retry'); };
  G.handlers.click['users-notice-dismiss'] = function () { st().notice = ''; rerender(); };

  G.handlers.click['users-manage'] = function () {
    if (!manage) manage = { picked: {} };
    rerender();
  };
  G.handlers.click['users-done'] = function () {
    manage = null;
    rerender();
  };
  G.handlers.change['users-pick'] = function (el) {
    if (!manage || !list) return;
    const key = el.getAttribute('data-pick');
    const row = list.rows.filter(function (r) { return r.key === key; })[0];
    if (!key || !row) return;
    if (el.checked) manage.picked[key] = { key: key, kind: row.kind, name: row.name, main: row.main || null };
    else delete manage.picked[key];
    // The same user on the phone list and in the table (one is hidden): both boxes say the same.
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      const twins = document.querySelectorAll('[data-pick="' + key + '"]');
      for (let i = 0; i < twins.length; i++) twins[i].checked = !!el.checked;
    }
    redrawBar();
  };

  // ── Sync now (an in-game guild's roster; the Guild Master's) ──
  // GET /roster-sync for the note under Sync now: best effort, it never fails the page.
  function loadSyncStatus(gd) {
    sync = null;
    if (!list || !list.battlenetOnly || !isGuildMaster(gd) || !G.shell.hasAction(gd.me && gd.me.can, 'guild.teams')) return Promise.resolve();
    const gid = gd.guild.id;
    return G.api.get('/api/guild/' + enc(gid) + '/roster-sync').then(function (res) {
      const at = res && res.lastAttempt && typeof res.lastAttempt.finishedAt === 'number' ? res.lastAttempt.finishedAt : (res && res.lastGood && typeof res.lastGood.fetchedAt === 'number' ? res.lastGood.fetchedAt : null);
      sync = { gid: gid, lastChecked: at ? G.ui.formatDateTime(at, gd.guild.timeZone) : '' };
    }, function () { sync = { gid: gid, lastChecked: '' }; });
  }

  function syncOutcome(res) {
    const status = res && res.status;
    if (status === 'applied') return { tone: 'success', title: 'Synced the in-game roster.', text: res.members != null ? plural(res.members, 'character', 'characters') + ' read.' : '' };
    if (status === 'unchanged') return { tone: 'success', title: 'The in-game roster has not changed.', text: '' };
    return { tone: 'warning', title: 'The roster sync did not finish.', text: 'Try again later.' };
  }

  G.handlers.click['users-sync'] = function () {
    const gd = currentGd();
    if (!gd) return;
    G.api.post('/api/guild/' + enc(gd.guild.id) + '/roster-sync', {}).then(function (res) {
      flash = syncOutcome(res);
      return loadSyncStatus(gd).then(reloadList);
    }, function (err) {
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      flash = { tone: 'warning', title: 'The roster was not synced.', text: G.api.classify(err).text };
      rerender();
    });
  };

  // ── the user page ──
  function loadUser(r, gd) {
    const gid = gd.guild.id;
    manage = null;
    flash = null;
    return G.api.get(usersPath(gid, '/' + enc(r.key))).then(function (data) {
      user = { gid: gid, key: r.key, data: data };
    }, function (err) {
      if (isAppError(err)) throw err;
      user = userFailure(gid, r.key, err);
    });
  }
  function userFailure(gid, key, err) {
    const gone = !!err && err.status === 404;
    return { gid: gid, key: key, error: gone ? 'That user was not found.' : G.api.classify(err).text, notFound: gone };
  }

  function panelHtml(s) {
    const id = esc(s.id);
    return '<section class="gs-hd-panel gs-pr-panel" id="' + id + '" tabindex="-1" aria-labelledby="' + id + '-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="' + id + '-h">' + esc(s.title) + '</h2>' +
      (s.metaHtml ? '<span class="gs-pr-mut">' + s.metaHtml + '</span>' : '') + (s.actionsHtml ? '<span class="gs-pr-acts">' + s.actionsHtml + '</span>' : '') + '</div>' +
      (s.flush ? s.bodyHtml || '' : '<div class="gs-pr-body">' + (s.bodyHtml || '') + '</div>') + '</section>';
  }
  function kvHtml(label, valueHtml) {
    return '<div class="gs-pr-kv"><span class="gs-pr-k">' + esc(label) + '</span><span class="gs-pr-v">' + valueHtml + '</span></div>';
  }

  function activeTeams(gd) { return G.shell.activeTeams(gd && gd.teams); }

  // A character: its crest, name in the class colour, class, then the in-game rank, the core rank and the team, and Main / Alt.
  function characterRowHtml(c, battlenetOnly) {
    const rank = c.ingameRank ? esc(c.ingameRank.label || 'Rank ' + c.ingameRank.rank) : (battlenetOnly ? '<span class="gs-muted">Not on the roster</span>' : '');
    const team = c.team ? esc(c.team.name) : '<span class="gs-muted">No team</span>';
    return '<div class="gs-pr-row gs-pr-char">' + crestHtml(c.class, 20) + '<span class="gs-pr-cname">' + G.ui.classNameHtml(c.name, c.class) + '</span><span class="gs-pr-what">' + esc(G.ui.className(c.class)) + '</span>' +
      '<span class="gs-us-rankteam"><span class="gs-us-rt-rank">' + rank + '</span><span class="gs-us-rt-core">' + esc(has(RANK_LABELS, c.coreRank) ? RANK_LABELS[c.coreRank] : (c.coreRank || '')) + '</span><span class="gs-us-rt-team">' + team + '</span></span>' +
      chipHtml('grey', c.isMain ? 'Main' : 'Alt') + '</div>';
  }

  function sightingRowHtml(s) {
    const text = [s.detail ? esc(s.detail) : '', s.date ? esc(shortDay(s.date)) : ''].filter(Boolean).join(' \u00b7 ');
    return kvHtml(has(TAG_LABELS, s.source) ? TAG_LABELS[s.source] : String(s.source || ''), text || '<span class="gs-muted">\u2014</span>');
  }

  // The label of one permission row: "Officer", "Team Lead: Team KJ" (the team only when the guild has several), a role of the guild's own by its name.
  function permissionLabel(p, gd) {
    return String(p.label || p.role) + (p.teamName && activeTeams(gd).length > 1 ? ': ' + p.teamName : '');
  }
  const SOURCE_TEXT = { manual: 'Set by hand', ingame: 'From the in-game rank', discord: 'From Discord', owner: 'Owner seat' };
  function sourcesText(sources) {
    return (Array.isArray(sources) ? sources : []).map(function (s) { return has(SOURCE_TEXT, s) ? SOURCE_TEXT[s] : s; }).join(', ');
  }

  // Edit permission: a holder of guild.roles, on a current member who is not the viewer and holds no Guild Master role (the People list's old rule).
  function canEditPermission(gd, data, meId) {
    return data.kind === 'account' && data.segment === 'members' && holds(gd, 'guild.roles') && data.key !== meId && data.permission !== 'Guild Master' && !flagsOf(data).owner;
  }
  // The Owner hands the seat to another current member (who is not the Owner).
  function canHandOver(gd, data, meId) {
    return data.kind === 'account' && data.segment === 'members' && !!gd.owner && gd.owner.you === true && data.key !== meId && !flagsOf(data).owner;
  }
  function canBlockUser(gd, data, meId) {
    return (data.kind === 'account' || data.kind === 'person') && !(data.block && data.block.blocked) && holds(gd, 'guild.access') && data.key !== meId && !flagsOf(data).owner;
  }
  // A block that is not waiting for a decision is restored from More; an ignored block row on the live Owner is restorable the same way (the list shows it on Blocked).
  function canRestore(gd, data) {
    return holds(gd, 'guild.access') && ((!!data.block && data.block.blocked && !data.block.pendingReview) || flagsOf(data).ignoredWhileOwner === true);
  }

  function userMoreItems(gd, data, meId) {
    const items = [];
    if (data.personId && holds(gd, 'roster.view')) items.push({ label: 'Open roster record', href: G.router.format({ name: 'person', gid: gd.guild.id, pid: data.personId }), key: 'users-roster' });
    if (canHandOver(gd, data, meId)) items.push({ label: 'Hand over the Owner seat', data: { action: 'users-handover-open' }, key: 'users-handover' });
    if (canRestore(gd, data)) items.push({ label: 'Restore access', data: { action: 'users-restore' }, key: 'users-restore-more' });
    if (canBlockUser(gd, data, meId)) {
      if (items.length) items.push({ separator: true });
      items.push({ label: 'Block user', danger: true, data: { action: 'users-user-block' }, key: 'users-user-block' });
    }
    return items;
  }

  // "Member · Raid Leader · last seen Oct 26": the segment, the Main's in-game rank, when they were last here.
  function contextText(data) {
    const seen = data.lastSeen ? 'last seen ' + shortDay(data.lastSeen) : '';
    if (data.block && data.block.blocked) return ['Blocked', seen].filter(Boolean).join(' \u00b7 ');
    const main = (data.characters || []).filter(function (c) { return c.isMain; })[0];
    return [SEGMENT_SINGULAR[data.segment] || '', main && main.ingameRank ? main.ingameRank.label : '', seen].filter(Boolean).join(' \u00b7 ');
  }

  // opts: { guildData, data (GET /users/:ukey), meId, flash }
  function userHtml(opts) {
    const gd = opts.guildData;
    const data = opts.data;
    const gid = gd.guild.id;
    const meId = opts.meId || null;
    const f = flagsOf(data);
    const block = data.block || { blocked: false, pendingReview: false };
    const characters = Array.isArray(data.characters) ? data.characters : [];
    const main = data.main || null;
    const chips = (block.pendingReview ? chipHtml('rose', 'Needs review') : '') + (f.suspended ? chipHtml('rose', 'Suspended') : '') + (data.key === meId ? chipHtml('grey', 'You') : '');
    const items = userMoreItems(gd, data, meId);
    const head = { title: data.name, back: { href: usersHref(gid, data.segment), label: 'Users' }, chipsHtml: chips, context: contextText(data), iconHtml: main ? crestHtml(main.class, 28) : '', more: items.length ? { id: 'user-more', key: 'user-more', items: items } : null };
    // A block that matched an earlier one waits for this decision (Keep block: POST .../block/keep; Restore access: DELETE .../block).
    const nextStep = block.pendingReview && holds(gd, 'guild.access')
      ? { id: 'block-step', title: data.name + ' matched an earlier block', text: 'Raidsmith blocked this account when it signed in, because it matches a user who was blocked before. Keep the block, or restore access.',
        primary: { label: 'Keep block', attrs: { 'data-action': 'users-keep', 'data-key': 'users-keep' } }, secondary: { label: 'Restore access', attrs: { 'data-action': 'users-restore', 'data-key': 'users-restore' } } }
      : null;
    const left = [];
    if (data.kind !== 'name') {
      left.push(panelHtml({ id: 'characters', title: 'Characters', metaHtml: data.battlenetOnly ? 'Rank comes from the in-game guild roster' : '', flush: true,
        bodyHtml: characters.length ? characters.map(function (c) { return characterRowHtml(c, data.battlenetOnly === true); }).join('') : '<p class="gs-pr-empty gs-fine">No characters.</p>' }));
    }
    if (Array.isArray(data.sightings) && data.sightings.length) left.push(panelHtml({ id: 'sightings', title: 'Seen in', flush: true, bodyHtml: data.sightings.map(sightingRowHtml).join('') }));
    const right = [];
    if (data.kind === 'account') {
      const perms = Array.isArray(data.permissions) ? data.permissions : [];
      right.push(panelHtml({ id: 'permission', title: 'Permission', flush: true,
        actionsHtml: canEditPermission(gd, data, meId) ? G.ui.buttonHtml({ label: 'Edit permission', size: 'sm', attrs: { 'data-action': 'users-roles-open', 'data-key': 'users-roles-open' } }) : '',
        bodyHtml: perms.length ? perms.map(function (p) { return kvHtml(permissionLabel(p, gd), esc(sourcesText(p.sources))); }).join('') : kvHtml('Permission', '<span class="gs-muted">None</span>') }));
    }
    if (block.blocked) {
      right.push(panelHtml({ id: 'block', title: 'Block', flush: true,
        bodyHtml: (block.blockedOn ? kvHtml('Blocked on', esc(shortDay(block.blockedOn))) : '') + (block.reason ? kvHtml('Reason', esc(block.reason)) : '') + (block.blockedBy ? kvHtml('Blocked by', esc(block.blockedBy)) : '') }));
    }
    const identity = data.identity || {};
    const methods = (Array.isArray(identity.signInMethods) ? identity.signInMethods : []).slice().sort(function (a, b) { return a === 'battlenet' ? -1 : (b === 'battlenet' ? 1 : 0); }).map(function (s) { return has(SIGN_IN_LABELS, s) ? SIGN_IN_LABELS[s] : s; });
    let idRows = '';
    if (data.kind === 'account') {
      idRows = kvHtml('Account', '<span class="gs-pr-id">' + esc(identity.account ? identity.account.displayName : data.name) + '</span>') + kvHtml('Battle.net', identity.battlenet ? 'Linked' : 'Not linked') +
        kvHtml('Sign-in', methods.length ? esc(methods.join(', ')) : '<span class="gs-muted">None</span>');
    } else if (data.kind === 'person') {
      idRows = kvHtml('Account', '<span class="gs-muted">No account yet</span>');
    } else if (data.tags && data.tags.length) {
      idRows = kvHtml('Seen in', esc(tagsText(data)));
    }
    right.push(panelHtml({ id: 'identity', title: 'Identity', flush: true, bodyHtml: idRows + kvHtml('Last seen', data.lastSeen ? esc(shortDay(data.lastSeen)) : '<span class="gs-muted">\u2014</span>') }));
    const cols = '<div class="gs-pr-cols"><div class="gs-pr-left">' + left.join('') + '</div><div class="gs-pr-right">' + right.join('') + '</div></div>';
    return G.ui.objectPageHtml({ head: head, noticesHtml: flashHtml(opts.flash), nextStep: nextStep, pageClass: 'gs-person-page gs-forge gs-pr gs-users-page', sections: [{ id: 'user-cols', bare: true, bodyHtml: cols }] });
  }

  function userMain(r, gd) {
    const page = function (title, bodyHtml) {
      return G.ui.objectPageHtml({ head: { title: title, back: { href: usersHref(gd.guild.id, null), label: 'Users' }, context: gd.guild.name }, pageClass: 'gs-users-page gs-forge', sections: [{ id: 'user-state', bare: true, bodyHtml: bodyHtml }] });
    };
    if (!user || user.gid !== gd.guild.id || user.key !== r.key) return page('User', G.ui.loadingHtml({ label: 'Loading the user', rows: 4 }));
    if (user.notFound) {
      return page('User', G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: 'That user was not found.', text: 'They may have been removed from the list, or the address is old.', actions: [{ label: 'Back to Users', variant: 'secondary', href: usersHref(gd.guild.id, null) }] }));
    }
    if (user.error) {
      return page('User', G.ui.errorRegionHtml({ title: 'We couldn\'t load this user.', text: user.error, safe: 'Nothing you saved was lost.', retry: { variant: 'primary', size: undefined, attrs: { 'data-action': 'users-user-retry', 'data-key': 'users-user-retry' } } }));
    }
    return userHtml({ guildData: gd, data: user.data, meId: myId(), flash: flash });
  }

  // The user's name for the trail's last crumb ('' until the page has read them).
  function userNameFor(r) {
    return user && r && user.gid === r.gid && user.key === r.key && user.data && typeof user.data.name === 'string' ? user.data.name : '';
  }

  function reloadUser() {
    const gd = currentGd();
    if (!gd || !user) return Promise.resolve();
    const key = user.key;
    return G.api.get(usersPath(gd.guild.id, '/' + enc(key))).then(function (data) {
      user = { gid: gd.guild.id, key: key, data: data };
      rerender();
    }, function (err) {
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      user = userFailure(gd.guild.id, key, err);
      rerender();
    });
  }
  G.handlers.click['users-user-retry'] = function () { reloadUser(); };

  // ── dialogs: the shared parts ──
  function listItemsHtml(entries, subFor) {
    const shown = entries.slice(0, NAMES_SHOWN);
    const more = entries.length - shown.length;
    return '<ul class="gs-us-leave">' + shown.map(function (e) {
      return '<li>' + (e.main ? crestHtml(e.main.class, 20) : '') + '<span class="gs-pickid">' + esc(e.name) + (subFor(e) ? '<span class="gs-picksub">' + esc(subFor(e)) + '</span>' : '') + '</span></li>';
    }).join('') + (more > 0 ? '<li><span class="gs-pickid"><span class="gs-picksub">and ' + more + ' more</span></span></li>' : '') + '</ul>';
  }

  // Runs a request in an open dialog and keeps the dialog open for the caller to decide (ui.runDialog closes it on success).
  function runKeepOpen(form, promise, onOk) {
    G.ui.setBusy(form, true);
    return promise.then(onOk, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (c.view === 'message') { G.ui.closeDialogOf(form); G.app.showFailure(c.title, c.text); return; }
      G.ui.showFormError(form, err);
    });
  }

  // Calls a bulk route in chunks of `size` and answers { done, skipped } for the whole set (the Worker handles `size` names a request and skips the rest as over_cap). A request that fails after
  // the first one marks its names and every later name skipped with the reason; one that fails first rejects, so the dialog says so.
  function runChunks(path, entries, size, bodyOf) {
    const out = { done: [], skipped: [] };
    const chunks = [];
    for (let i = 0; i < entries.length; i += size) chunks.push(entries.slice(i, i + size));
    let failure = null;
    const skipAll = function (chunk) { chunk.forEach(function (e) { out.skipped.push({ key: e.key, name: e.name, reason: 'not_sent', message: failure }); }); };
    return chunks.reduce(function (p, chunk, index) {
      return p.then(function () {
        if (failure) { skipAll(chunk); return null; }
        return G.api.post(path, bodyOf(chunk)).then(function (res) {
          (res && Array.isArray(res.done) ? res.done : []).forEach(function (d) { out.done.push(d); });
          (res && Array.isArray(res.skipped) ? res.skipped : []).forEach(function (s) {
            const known = chunk.filter(function (e) { return e.key === s.key; })[0];
            out.skipped.push({ key: s.key, name: s.name || (known ? known.name : null), reason: s.reason, message: s.message });
          });
        }, function (err) {
          if (index === 0 || G.api.classify(err).view === 'signin') throw err;
          failure = G.api.classify(err).text;
          skipAll(chunk);
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  // ── Block and Unblock ──
  const WHAT_BLOCKING_DOES = [['Sign-in', 'They can no longer sign in to GUILD'], ['Teams', 'Taken off every team'], ['Sign-ups', 'Upcoming sign-ups withdrawn'], ['History', 'Characters, attendance and loot stay']];

  function blockDialogHtml(entries, guildName) {
    const n = entries.length;
    const body = '<div class="gs-hd-panel gs-us-joins"><h3 class="gs-fg-lbl">' + (n === 1 ? 'User to block' : 'Users to block') + '</h3>' + listItemsHtml(entries, function (e) { return e.main && e.main.name !== e.name ? e.main.name : ''; }) + '</div>' +
      '<div class="gs-hd-panel gs-us-joins"><h3 class="gs-fg-lbl">What blocking does</h3>' + WHAT_BLOCKING_DOES.map(function (row) { return kvHtml(row[0], esc(row[1].replace('GUILD', guildName))); }).join('') + '</div>';
    return G.ui.dialogHtml({ kind: 'confirm', title: n === 1 ? 'Block ' + entries[0].name + '?' : 'Block ' + n + ' users?', text: 'You can unblock them any time on Users, Blocked.', bodyHtml: body,
      primary: { label: n === 1 ? 'Block ' + entries[0].name : 'Block ' + n + ' users', variant: 'danger' }, formAttrs: { 'data-submit': 'users-block-form' }, className: 'gs-forge' });
  }

  // The answer of Block or Unblock as a list: who was done, who was skipped and why (the API's own sentence).
  // opts: { action ('block' | 'unblock'), total, done: [{ key, name }], skipped: [{ key, name, message }] }
  function resultDialogHtml(opts) {
    const block = opts.action === 'block';
    const done = opts.done || [];
    const skipped = opts.skipped || [];
    const verb = block ? 'Blocked ' : 'Restored access for ';
    const title = !done.length ? (block ? 'No one was blocked' : 'No one was restored') : verb + (skipped.length ? done.length + ' of ' + opts.total + ' users' : plural(done.length, 'user', 'users'));
    const rows = done.map(function (d) { return '<li><span class="gs-pickid">' + esc(d.name) + '<span class="gs-picksub">' + (block ? 'Blocked' : 'Access restored') + '</span></span></li>'; }).join('') +
      skipped.map(function (s) { return '<li><span class="gs-pickid">' + esc(s.name || 'Unknown user') + '<span class="gs-picksub">' + esc(s.message || 'Skipped.') + '</span></span></li>'; }).join('');
    return G.ui.dialogHtml({ kind: 'form', title: title, text: skipped.length ? (skipped.length === 1 ? '1 user was skipped.' : skipped.length + ' users were skipped.') : '', bodyHtml: '<div class="gs-hd-panel gs-us-joins"><ul class="gs-us-leave">' + rows + '</ul></div>',
      cancel: false, primary: { label: 'Done' }, formAttrs: { 'data-submit': 'users-result-done' }, className: 'gs-forge' });
  }

  function openBlockDialog(entries, mode) {
    const gd = currentGd();
    if (!gd || !entries.length) return;
    blockTarget = { mode: mode, entries: entries };
    G.ui.openDialog(blockDialogHtml(entries, gd.guild.name), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  }

  G.handlers.click['users-block-open'] = function () {
    if (!manage) return;
    openBlockDialog(pickedList(manage), 'list');
  };
  G.handlers.click['users-user-block'] = function () {
    if (!currentGd() || !user || !user.data) return;
    const d = user.data;
    openBlockDialog([{ key: d.key, kind: d.kind, name: d.name, main: d.main || null }], 'page');
  };

  // The answer of a bulk call: the picks that were done leave the selection (the skipped ones stay ticked) and the list is read again.
  function afterBulk(res) {
    if (manage) {
      res.done.forEach(function (d) { delete manage.picked[d.key]; });
      if (!Object.keys(manage.picked).length) manage = null;
    }
    return reloadList();
  }

  function showResult(form, action, entries, res) {
    const dlg = form && form.closest ? form.closest('dialog') : null;
    const html = resultDialogHtml({ action: action, total: entries.length, done: res.done, skipped: res.skipped });
    if (dlg) G.ui.replaceDialogBody(dlg, html);
    else G.ui.openDialog(html, { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    return afterBulk(res);
  }

  const keysOf = function (chunk) { return { keys: chunk.map(function (e) { return e.key; }) }; };

  // Block from the dialog: one name on the user's own page, any number from the list (in chunks of 25).
  G.handlers.submit['users-block-form'] = function (form) {
    const gd = currentGd();
    if (!gd || !blockTarget) return;
    const target = blockTarget;
    G.ui.setText('dlg-error', '');
    runKeepOpen(form, runChunks(usersPath(gd.guild.id, '/block'), target.entries, BLOCK_CHUNK, keysOf), function (res) {
      if (target.mode !== 'page') return showResult(form, 'block', target.entries, res);
      if (!res.done.length) { G.ui.setBusy(form, false); G.ui.setText('dlg-error', res.skipped.length ? res.skipped[0].message : 'That user was not blocked.'); return null; }
      G.ui.closeDialogOf(form);
      flash = { tone: 'success', title: 'Blocked ' + target.entries[0].name + '.', text: 'Their history stays. Restore access from this page when you want them back.' };
      ensureAttention(gd.guild.id);
      return reloadUser();
    });
  };

  G.handlers.click['users-unblock'] = function (el) {
    const gd = currentGd();
    if (!gd || !manage) return;
    const entries = pickedList(manage);
    if (!entries.length) return;
    el.disabled = true;
    runChunks(usersPath(gd.guild.id, '/unblock'), entries, BLOCK_CHUNK, keysOf).then(function (res) {
      G.ui.openDialog(resultDialogHtml({ action: 'unblock', total: entries.length, done: res.done, skipped: res.skipped }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
      return afterBulk(res);
    }, function (err) {
      el.disabled = false;
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      flash = { tone: 'warning', title: 'Nothing was changed.', text: G.api.classify(err).text };
      rerender();
    });
  };

  G.handlers.submit['users-result-done'] = function (form) { G.ui.closeDialogOf(form); };

  // ── Keep block / Restore access (a block that matched an earlier one) and Restore access of a plain block ──
  function failUserAction(el, err) {
    el.disabled = false;
    if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
    flash = { tone: 'warning', title: 'That did not work.', text: G.api.classify(err).text };
    if (err && err.code === 'conflict') { reloadUser(); return; }
    rerender();
  }

  G.handlers.click['users-keep'] = function (el) {
    const gd = currentGd();
    if (!gd || !user || !user.data) return;
    el.disabled = true;
    G.api.post(peoplePath(gd.guild.id, user.data.key, '/block/keep'), {}).then(function () {
      ensureAttention(gd.guild.id);
      return reloadUser();
    }, function (err) { failUserAction(el, err); });
  };

  G.handlers.click['users-restore'] = function (el) {
    const gd = currentGd();
    if (!gd || !user || !user.data) return;
    const d = user.data;
    el.disabled = true;
    // A block that waits for review is restored with DELETE .../block (it also lifts the tombstones the match hit); any other with the bulk route, which answers a refusal as a skipped name.
    const call = d.block && d.block.pendingReview ? G.api.del(peoplePath(gd.guild.id, d.key, '/block'), {}) : G.api.post(usersPath(gd.guild.id, '/unblock'), { keys: [d.key] }).then(function (res) {
      if (res && Array.isArray(res.skipped) && res.skipped.length && !(res.done || []).length) throw new G.api.ApiError(409, { error: 'skipped', message: res.skipped[0].message });
      return res;
    });
    call.then(function () {
      ensureAttention(gd.guild.id);
      flash = { tone: 'success', title: 'Restored access for ' + d.name + '.', text: '' };
      return reloadUser();
    }, function (err) { failUserAction(el, err); });
  };

  // ── Add to a person (non-members of a guild whose ranks are set by hand) ──
  function classOptionsHtml(gd, needed) {
    return '<option value="">' + (needed ? 'Pick a class' : 'From the log') + '</option>' + G.ui.rosterOptions(gd).classes.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
  }

  // One row per name with its Class select (a name row carries no class: "From the log" lets the Worker read it from the log, loot, application or sign-up). A name the Worker refused for another
  // reason shows that reason instead of a select.
  function nameRowsHtml(gd, names) {
    return '<ul class="gs-us-leave gs-us-names">' + names.map(function (n, i) {
      const id = 'users-cls-' + i;
      const retry = !n.message || n.needed;
      return '<li class="gs-us-namerow' + (n.needed ? ' is-needed' : '') + '"><span class="gs-pickid">' + esc(n.name) + (n.sub ? '<span class="gs-picksub">' + esc(n.sub) + '</span>' : '') + '</span>' +
        (n.message ? '<span class="gs-us-needtext">' + esc(n.message) + '</span>' : '') +
        (retry ? '<label class="gs-sr" for="' + id + '">Class of ' + esc(n.name) + '</label><select class="gs-input gs-us-classsel' + (n.needed ? ' is-needed' : '') + '" id="' + id + '" data-name-key="' + esc(n.key) + '"' + (n.needed ? ' required' : '') + '>' + classOptionsHtml(gd, !!n.needed) + '</select>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function peopleListHtml(people, picked) {
    if (!people.length) return '<p class="gs-fg-mut gs-us-pickmore">No one matches.</p>';
    return '<ul class="gs-pick" role="radiogroup" aria-label="People">' + people.map(function (p) {
      const on = !!picked && picked.key === p.key;
      const shown = p.main ? crestHtml(p.main.class, 20) + '<span class="gs-pickid">' + G.ui.classNameHtml(p.main.name, p.main.class) + (p.name !== p.main.name ? '<span class="gs-picksub">' + esc(p.name) + '</span>' : '') + '</span>'
        : '<span class="gs-pickid">' + esc(p.name) + '</span>';
      return '<li><label class="gs-pickrow' + (on ? ' is-picked' : '') + '"><input type="radio" class="gs-fg-radio" name="person" value="' + esc(p.key) + '" data-change="users-add-pick" data-person-name="' + esc(p.name) + '"' + (on ? ' checked' : '') + '>' + shown + '</label></li>';
    }).join('') + '</ul>';
  }

  // s: { gd, names: [{ key, name, sub, needed?, message? }], person: { key, name } | null, people: [row], moreText, fixed, banner, added }. First the person is picked (one, searchable) and each name gets its class;
  // after the first answer (`fixed`) the person stays and the dialog lists only what is still to add.
  function addDialogHtml(s) {
    const n = s.names.length;
    if (s.fixed) {
      const title = n === 1 ? 'Add ' + s.names[0].name + ' to ' + s.person.name : 'Add ' + n + ' names to ' + s.person.name;
      return G.ui.dialogHtml({ kind: 'form', title: title, text: 'Their history lines up by name and realm.', bodyHtml: (s.banner || '') + '<div class="gs-hd-panel gs-us-joins"><h3 class="gs-fg-lbl">Still to add</h3>' + nameRowsHtml(s.gd, s.names) + '</div>',
        primary: { label: n === 1 ? 'Add ' + s.names[0].name : 'Add ' + n + ' names' }, formAttrs: { 'data-submit': 'users-add-form' }, className: 'gs-forge' });
    }
    const search = '<div class="gs-rs-search gs-us-picksearch"><label class="gs-sr" for="users-add-search">Search people</label>' + G.icons.icon('search', 16) +
      '<input class="gs-rs-input" type="search" id="users-add-search" placeholder="Search people" data-input="users-add-search" autocomplete="off" maxlength="40" value=""></div>';
    const body = search + '<div id="users-add-people">' + peopleListHtml(s.people, s.person) + '</div><p class="gs-fg-mut gs-us-pickmore" id="users-add-more">' + esc(s.moreText || '') + '</p>' +
      '<div class="gs-hd-panel gs-us-joins"><h3 class="gs-fg-lbl">Joining the person</h3>' + nameRowsHtml(s.gd, s.names) + '</div>';
    return G.ui.dialogHtml({ kind: 'form', title: 'Add ' + plural(n, 'name', 'names') + ' to a person', text: 'Pick one person. ' + (n === 1 ? 'The name becomes' : 'All ' + n + ' names become') + ' their alts. Their history lines up by name and realm.', bodyHtml: body,
      primary: { label: s.person ? 'Add to ' + s.person.name : 'Add to a person', attrs: { 'data-add-primary': '1' } }, formAttrs: { 'data-submit': 'users-add-form' }, className: 'gs-forge' });
  }

  // The people the dialog lists: the members A-Z (GET /users), narrowed by the search.
  function loadPeople(gid, q) {
    return G.api.get(usersPath(gid, '?segment=members&sort=user&dir=asc&offset=0&limit=' + PEOPLE_SHOWN + (q.trim() ? '&q=' + enc(q.trim()) : ''))).then(function (res) {
      return { rows: Array.isArray(res && res.rows) ? res.rows : [], more: !!(res && res.more), total: res && res.counts ? Number(res.counts.members) : null };
    });
  }
  function peopleMoreText(res, q) {
    if (!res.more) return '';
    return 'Showing ' + res.rows.length + (!q.trim() && res.total ? ' of ' + res.total : '') + '. Search to narrow the list.';
  }

  G.handlers.click['users-add-open'] = function () {
    const gd = currentGd();
    if (!gd || !manage || !list) return;
    const names = pickedList(manage).filter(function (p) { return p.kind === 'name'; });
    if (!names.length) return;
    const rows = list.rows.reduce(function (acc, r) { acc[r.key] = r; return acc; }, {});
    const state = { gd: gd, names: names.map(function (p) { return { key: p.key, name: p.name, sub: rows[p.key] ? tagsText(rows[p.key]) : '' }; }), person: null, people: [], moreText: '', fixed: false, banner: '', added: [] };
    loadPeople(gd.guild.id, '').then(function (res) {
      state.people = res.rows;
      state.moreText = peopleMoreText(res, '');
      addState = state;
      G.ui.openDialog(addDialogHtml(state), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    }, function (err) {
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      flash = { tone: 'warning', title: 'The people could not be read.', text: G.api.classify(err).text };
      rerender();
    });
  };

  G.handlers.input['users-add-search'] = function (el) {
    const gd = currentGd();
    if (!gd || !addState) return;
    const q = String(el.value || '');
    if (addTimer) clearTimeout(addTimer);
    addTimer = setTimeout(function () {
      addTimer = null;
      loadPeople(gd.guild.id, q).then(function (res) {
        if (!addState) return;
        addState.people = res.rows;
        const host = byId('users-add-people');
        const more = byId('users-add-more');
        if (host) host.innerHTML = peopleListHtml(res.rows, addState.person);
        if (more) more.textContent = peopleMoreText(res, q);
      }, function () { /* the list stays as it was */ });
    }, SEARCH_MS);
  };

  G.handlers.change['users-add-pick'] = function (el) {
    if (!addState) return;
    addState.person = { key: el.value, name: el.getAttribute('data-person-name') || '' };
    const rows = el.closest ? el.closest('ul') : null;
    const all = rows && rows.querySelectorAll ? rows.querySelectorAll('.gs-pickrow') : [];
    for (let i = 0; i < all.length; i++) if (all[i].classList) all[i].classList.remove('is-picked');
    const label = el.closest ? el.closest('label') : null;
    if (label && label.classList) label.classList.add('is-picked');
    const form = el.closest ? el.closest('form') : null;
    const primary = form && form.querySelector ? form.querySelector('[data-add-primary]') : null;
    const span = primary && primary.querySelector ? primary.querySelector('span') : null;
    if (span) span.textContent = 'Add to ' + addState.person.name;
  };

  // The names of the dialog with the class each was given (none keeps the Worker's own reading of the log, loot, application or sign-up).
  function addNamesOf(form) {
    return addState.names.map(function (n) {
      const sel = form.querySelector ? form.querySelector('select[data-name-key="' + n.key + '"]') : null;
      return Object.assign({}, n, { class: sel && sel.value ? sel.value : '' });
    });
  }

  G.handlers.submit['users-add-form'] = function (form) {
    const gd = currentGd();
    if (!gd || !addState) return;
    G.ui.setText('dlg-error', '');
    if (!addState.person) { G.ui.setText('dlg-error', 'Pick the person to add the names to.'); return; }
    // A name the Worker refused for a reason a class cannot fix is not sent again.
    const names = addNamesOf(form).filter(function (n) { return !n.message || n.needed; });
    const missing = names.filter(function (n) { return n.needed && !n.class; })[0];
    if (missing) { G.ui.setText('dlg-error', 'Pick a class for ' + missing.name + '.'); return; }
    if (!names.length) { G.ui.closeDialogOf(form); addState = null; reloadList(); return; }
    const person = addState.person;
    runKeepOpen(form, runChunks(usersPath(gd.guild.id, '/add-to-person'), names, ADD_CHUNK, function (chunk) {
      return { person: person.key, names: chunk.map(function (n) { return n.class ? { key: n.key, class: n.class } : { key: n.key }; }) };
    }), function (res) {
      res.done.forEach(function (d) { addState.added.push(d.name); if (manage) delete manage.picked[d.key]; });
      if (manage && !Object.keys(manage.picked).length) manage = null;
      const added = 'Added ' + addState.added.join(', ') + ' to ' + person.name + '.';
      if (!res.skipped.length) {
        G.ui.closeDialogOf(form);
        flash = { tone: 'success', title: added, text: 'Their history now lines up with that person.' };
        addState = null;
        return reloadList();
      }
      // What is left: a name that needs a class gets its select back, any other refusal says why.
      const left = res.skipped.map(function (s) {
        const base = names.filter(function (n) { return n.key === s.key; })[0] || { name: s.name || 'This name', sub: '' };
        return { key: s.key, name: s.name || base.name, sub: base.sub, needed: s.reason === 'class_needed', message: s.reason === 'class_needed' ? (s.name || base.name) + ' has no class in the log or the sign-up. Pick one.' : s.message };
      });
      addState = Object.assign({}, addState, { names: left, fixed: true, banner: addState.added.length ? G.ui.bannerHtml({ tone: 'success', title: added, dismissible: false }) : '' });
      const dlg = form.closest ? form.closest('dialog') : null;
      if (dlg) G.ui.replaceDialogBody(dlg, addDialogHtml(addState));
      return reloadList();
    });
  };

  // ── Edit permission ──
  // The hand-set boxes (what an officer set: they survive rank changes), the guild's own roles as "Other roles", and under them the roles only the in-game rank (or Discord) gives, which a tick keeps.
  function isCustomRole(r) { return !!r && typeof r.id === 'string' && (r.kind === 'custom' || (r.kind === undefined && r.id.indexOf('cr_') === 0)); }
  function manualOf(permissions) { return permissions.filter(function (p) { return Array.isArray(p.sources) && p.sources.indexOf('manual') >= 0; }); }
  function derivedOnlyOf(permissions) { return permissions.filter(function (p) { return Array.isArray(p.sources) && p.sources.indexOf('manual') < 0 && (p.sources.indexOf('ingame') >= 0 || p.sources.indexOf('discord') >= 0); }); }
  function labelsOf(rows, gd) { return rows.map(function (p) { return permissionLabel(p, gd); }).join(', '); }

  function customChecksHtml(custom, manual, active) {
    return custom.map(function (role, ri) {
      const box = function (id, teamId, checked, label) {
        return '<div class="gs-check"><input type="checkbox" id="' + id + '" name="customRole" data-role="' + esc(role.id) + '" data-team="' + esc(teamId || '') + '"' + (checked ? ' checked' : '') + '><label for="' + id + '">' + esc(label) + '</label></div>';
      };
      if (!role.needsTeam) return box('dlg-role-custom-' + ri, '', manual.some(function (h) { return h.role === role.id && !h.teamId; }), role.name);
      if (!active.length) return '<p class="gs-fine">' + esc(role.name) + ' is given for one team, and there are no active teams.</p>';
      return active.map(function (t, ti) { return box('dlg-role-custom-' + ri + '-' + ti, t.id, manual.some(function (h) { return h.role === role.id && h.teamId === t.id; }), role.name + ': ' + t.name); }).join('');
    }).join('');
  }

  // opts: { guildData, data (GET /users/:ukey of an account), customRoles (the guild's own roles from GET /roles), meId }
  function editPermissionDialogHtml(opts) {
    const gd = opts.guildData;
    const data = opts.data;
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const manual = manualOf(permissions);
    const derived = derivedOnlyOf(permissions);
    const active = activeTeams(gd);
    const custom = (Array.isArray(opts.customRoles) ? opts.customRoles : []).filter(isCustomRole);
    const isOfficer = manual.some(function (p) { return p.role === 'officer'; });
    const leadIds = manual.filter(function (p) { return p.role === 'team_lead' && p.teamId; }).map(function (p) { return p.teamId; });
    const checks = '<div class="gs-check"><input type="checkbox" id="dlg-role-officer" name="officer"' + (isOfficer ? ' checked' : '') + '><label for="dlg-role-officer">Officer: whole guild</label></div>' +
      (active.length ? active.map(function (t, i) {
        return '<div class="gs-check"><input type="checkbox" id="dlg-role-lead-' + i + '" name="teamLead" value="' + esc(t.id) + '"' + (leadIds.indexOf(t.id) >= 0 ? ' checked' : '') + '><label for="dlg-role-lead-' + i + '">' + (active.length === 1 ? 'Team Lead' : 'Team Lead: ' + esc(t.name)) + '</label></div>';
      }).join('') : '<p class="gs-fine">There are no active teams, so no Team Lead roles to give.</p>');
    const others = custom.length ? '<fieldset class="gs-fieldset gs-other-roles"><legend class="gs-legend">Other roles</legend>' + customChecksHtml(custom, manual, active) + '</fieldset>' : '';
    const rankGives = derived.filter(function (p) { return p.sources.indexOf('ingame') >= 0; });
    const discordGives = derived.filter(function (p) { return p.sources.indexOf('ingame') < 0; });
    const fromLines = (rankGives.length ? '<p class="gs-fine gs-from-discord" id="dlg-from-rank">From the in-game rank: ' + esc(labelsOf(rankGives, gd)) + '. It lasts only while the rank gives it. Tick its box to keep it.</p>' : '') +
      (discordGives.length ? '<p class="gs-fine gs-from-discord" id="dlg-from-discord">From Discord: ' + esc(labelsOf(discordGives, gd)) + '. A role from Discord lasts only while Discord gives it. Tick its box to keep it.</p>' : '');
    const seat = canHandOver(gd, data, opts.meId)
      ? '<div class="gs-gm"><h3 class="gs-legend">Owner seat</h3><button type="button" class="gs-btn" id="dlg-gm-ask" data-action="users-handover-open" data-key="users-handover-ask">Hand over the Owner seat</button></div>' : '';
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings gs-us-perm" data-submit="users-roles-form"' + (custom.length ? ' data-custom="1"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Edit permission for ' + esc(data.name) + '</h2>' +
      '<fieldset class="gs-fieldset"><legend class="gs-legend">Roles</legend>' + checks + '</fieldset>' + others + fromLines +
      '<p class="gs-fine" id="dlg-help">Officers manage the whole guild. Team Leads manage their team\'s roster, raids and attendance, including officer notes.</p>' + seat +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save</button></div></form>';
  }

  function ensureRoles(gid) {
    const s = st();
    if (!s.rolesList) s.rolesList = {};
    if (s.rolesList[gid]) return Promise.resolve(s.rolesList[gid]);
    return G.api.roles.list(gid).then(function (res) { s.rolesList[gid] = res; return res; }, function () { return null; });
  }
  function customRolesOf(v) {
    return (Array.isArray(v) ? v : (v && Array.isArray(v.roles) ? v.roles : [])).filter(isCustomRole);
  }

  G.handlers.click['users-roles-open'] = function () {
    const gd = currentGd();
    if (!gd || !user || !user.data) return;
    ensureRoles(gd.guild.id).then(function (roles) {
      if (!user || !user.data) return;
      G.ui.openDialog(editPermissionDialogHtml({ guildData: gd, data: user.data, customRoles: customRolesOf(roles), meId: myId() }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    });
  };

  // What the save sends. pin: true only when a ticked box is a role the rank (or Discord) already gives, which is the person keeping it by hand (the Worker never copies a derived role otherwise).
  function rolesBodyOf(form, permissions) {
    const officer = !!(form.elements && form.elements.officer && form.elements.officer.checked);
    const leadIds = Array.prototype.map.call(form.querySelectorAll('input[name="teamLead"]:checked'), function (i) { return i.value; });
    const body = { officer: officer, teamLeadTeamIds: leadIds };
    let custom = [];
    if (form.getAttribute && form.getAttribute('data-custom') === '1') {
      custom = Array.prototype.map.call(form.querySelectorAll('input[name="customRole"]:checked'), function (box) { return { roleId: box.getAttribute('data-role'), teamId: box.getAttribute('data-team') || null }; });
      body.roles = custom;
    }
    const derived = derivedOnlyOf(permissions);
    const kept = (officer && derived.some(function (p) { return p.role === 'officer'; })) ||
      leadIds.some(function (id) { return derived.some(function (p) { return p.role === 'team_lead' && p.teamId === id; }); }) ||
      custom.some(function (c) { return derived.some(function (p) { return p.role === c.roleId && (p.teamId || null) === c.teamId; }); });
    if (kept) body.pin = true;
    return body;
  }

  G.handlers.submit['users-roles-form'] = function (form) {
    const gd = currentGd();
    if (!gd || !user || !user.data) return;
    const d = user.data;
    G.ui.runDialogInline(form, G.api.put(peoplePath(gd.guild.id, d.key, '/roles'), rolesBodyOf(form, Array.isArray(d.permissions) ? d.permissions : [])), function () {
      return G.app.refreshGuild(gd.guild.id).then(reloadUser);
    }, function (err) {
      flash = { tone: 'warning', title: 'The permission was not saved.', text: G.api.classify(err).text };
      return reloadUser();
    });
  };

  // ── the Owner seat's hand-over ──
  // opts: { name, ownerSeat } - a guild with an Owner seat only moves the seat; one without (a legacy guild) swaps the stored Guild Master row and the previous one becomes an Officer.
  function handOverDialogHtml(opts) {
    const name = opts.name;
    const rows = kvHtml('Owner seat', esc('From you to ' + name)) + (opts.ownerSeat
      ? kvHtml('You', esc('Stay a member with the powers of your in-game rank and your hand-set roles')) + kvHtml(name, esc('Keeps their own rank powers and roles, and gains the Owner powers'))
      : kvHtml('You', esc('Become an Officer')) + kvHtml(name, esc('Becomes the Guild Master, and keeps no other role')));
    return G.ui.dialogHtml({ kind: 'confirm', title: 'Hand over the Owner seat to ' + name + '?', text: opts.ownerSeat ? 'Setup, ranks and hand-overs are the Owner\'s alone. Nobody is made Officer by this.' : 'Setup, ranks and hand-overs are the Guild Master\'s alone.',
      bodyHtml: '<div class="gs-hd-panel gs-us-joins"><h3 class="gs-fg-lbl">What moves</h3>' + rows + '</div>', primary: { label: 'Hand over' }, formAttrs: { 'data-submit': 'users-handover-form' }, className: 'gs-forge' });
  }

  // 409 recipient_not_live names the person: they need a Battle.net-confirmed character on the roster first.
  function notLiveError(name) {
    return new G.api.ApiError(409, { error: 'recipient_not_live', message: name + ' has no character on the guild roster that Battle.net has confirmed for their account, so they cannot take the seat. Ask them to sign in with Battle.net first.' });
  }
  function handOverCall(gid, key, name) {
    return G.api.post(peoplePath(gid, key, '/guild-master'), {}).then(null, function (err) { throw err && err.code === 'recipient_not_live' ? notLiveError(name) : err; });
  }
  function bareAnswer(res) { return !!res && res.handedOver === true && !Array.isArray(res.people); }

  G.handlers.click['users-handover-open'] = function () {
    if (!currentGd() || !user || !user.data) return;
    G.ui.openDialog(handOverDialogHtml({ name: user.data.name, ownerSeat: user.data.ownerSeat === true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  // After the hand-over the viewer's own rights changed: the guild is read again; a previous Owner who may not read Users any more (the bare answer) goes Home.
  function afterHandOver(gid, res, name) {
    return G.app.refreshGuild(gid).then(function () {
      const gd = st().guilds[gid];
      if (bareAnswer(res) || !gd || !G.shell.canSeeUsers(gd.me && gd.me.can)) { G.app.go(G.router.format({ name: 'section', gid: gid, section: 'home' })); return null; }
      flash = { tone: 'success', title: name + ' now holds the Owner seat.', text: '' };
      return reloadUser();
    });
  }

  G.handlers.submit['users-handover-form'] = function (form) {
    const gd = currentGd();
    if (!gd || !user || !user.data) return;
    const d = user.data;
    const gid = gd.guild.id;
    G.ui.setText('dlg-error', '');
    // The Owner is asked to sign in again first (403 fresh_required, purpose handover): the dialog's second step, with the person kept for the repeat.
    G.fresh.runDialog(form, handOverCall(gid, d.key, d.name), {
      gid: gid, act: { kind: 'handover', data: { targetUserId: d.key, name: d.name } }, stepLabel: 'Hand over the Owner seat - step 2 of 2', primaryLabel: 'Sign in and hand over', returnTo: userHref(gid, d.key),
    }, function (res) { afterHandOver(gid, res, d.name); });
  };

  // Repeats after the fresh sign-in (#/fresh?done=handover): the hand-over to the person the Owner picked, then that person's page (Home when the previous Owner may not read Users any more).
  G.fresh.registerAct('handover', function (act) {
    const data = act.data && typeof act.data === 'object' ? act.data : {};
    const key = typeof data.targetUserId === 'string' ? data.targetUserId : (act.params && typeof act.params.targetUserId === 'string' ? act.params.targetUserId : '');
    const name = typeof data.name === 'string' && data.name ? data.name : 'That person';
    if (!key || !act.gid) return Promise.resolve(null);
    return handOverCall(act.gid, key, name).then(function (res) {
      return G.app.fetchGuild(act.gid).then(function (gd) {
        return bareAnswer(res) || !G.shell.canSeeUsers(gd && gd.me && gd.me.can) ? G.router.format({ name: 'section', gid: act.gid, section: 'home' }) : userHref(act.gid, key);
      });
    });
  });

  G.pages.users = {
    SEGMENTS: SEGMENTS,
    TAG_LABELS: TAG_LABELS,
    FIRST_ROWS: FIRST_ROWS,
    BLOCK_CHUNK: BLOCK_CHUNK,
    load: load,
    main: listMain,
    listHtml: listHtml,
    resultsHtml: function (opts) { return resultsHtml(modelOf(opts)); },
    blockDialogHtml: blockDialogHtml,
    resultDialogHtml: resultDialogHtml,
    addDialogHtml: addDialogHtml,
    runChunks: runChunks,
    shortDay: shortDay,
    reset: function () { view = null; list = null; manage = null; flash = null; user = null; sync = null; blockTarget = null; addState = null; },
    state: function () { return { view: view, list: list, manage: manage, flash: flash, user: user, sync: sync }; },
  };
  G.pages.user = {
    load: loadUser,
    main: userMain,
    nameFor: userNameFor,
    userHtml: userHtml,
    editPermissionDialogHtml: editPermissionDialogHtml,
    handOverDialogHtml: handOverDialogHtml,
    rolesBodyOf: rolesBodyOf,
    canEditPermission: canEditPermission,
    canHandOver: canHandOver,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
