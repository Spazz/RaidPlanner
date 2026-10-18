// ── PAGE: LOOT (+ the award vocabulary every loot page shares) ──
// The tag / flag / item / winner builders live here; pages-raid-loot, pages-person-loot and pages-review use them.
// The page itself (#/g/:gid/loot): header, view switch (Balance / By raid / By item), then
//   Balance  - GET /loot/balance?team=&weeks= : a sortable table of people (phone: cards), window switch like Attendance
//   By raid  - GET /loot/raids?team= : one row per raid with awards, each linking to the raid page
//   By item  - GET /loot/items?team= : one expandable row per item with its awards
// See the Phase 4 spec (tasks/guild-phase4-spec.md, sections 5 and 6). This file is safe to load alone: nothing here
// runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  const TAGS = ['MS', 'OS', 'DE', 'BANK'];
  const TAG_LABELS = { MS: 'MS', OS: 'OS', DE: 'DE', BANK: 'Bank' };
  const TAG_NAMES = { MS: 'Main spec', OS: 'Off-spec', DE: 'Disenchanted', BANK: 'Guild bank' };
  const FLAG_LABELS = { OS: 'Off-spec roll', SR: 'Soft-res', WL: 'Wishlist', PL: 'Prio', TMB: 'TMB' };
  const VIEWS = [{ value: 'balance', label: 'Balance' }, { value: 'raids', label: 'By raid' }, { value: 'items', label: 'By item' }];
  const COLUMNS = ['name', 'raids', 'ms', 'os', 'counted', 'perRaid', 'vs'];
  const COLUMN_LABELS = { name: 'Player', raids: 'Raids', ms: 'MS', os: 'OS', counted: 'Counted', perRaid: 'Per raid', vs: 'Vs team' };

  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function apiBase(gid) { return A().apiBase(gid); }
  function teamOf(gd, id) { return A().teamOf(gd, id); }
  function allows(gd, action, teamId) { return G.shell.allowsTeam(gd && gd.me && gd.me.can, action, teamId); }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }

  // ── award vocabulary ──
  // The item link, written in one place for every page (ui-kit.js: Wowhead link + data-wowhead hook, quality colour, escaped name).
  function itemUrl(gameVersion, itemId) { return G.ui.itemUrl(gameVersion, itemId); }
  function itemHtml(item, gameVersion) { return G.ui.itemLinkHtml(item, gameVersion); }

  // "9:12 PM ET" in the guild's time zone (the raid date is the guild's calendar day); the viewer's zone, named, when the zone is unknown.
  function timeText(ms, timeZone) {
    return G.ui.timeInZone(ms, timeZone);
  }

  // "Oct 10, 2026" in the guild's time zone.
  function dateText(ms, timeZone) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    try { return new Date(ms).toLocaleDateString('en-US', Object.assign({ timeZone: timeZone || undefined }, opts)); } catch (e) {
      try { return new Date(ms).toLocaleDateString('en-US', opts); } catch (e2) { return ''; }
    }
  }

  // "Sat Oct 10, 8:12 PM ET" in the guild's time zone, for lists that span several days.
  function dateTimeText(ms, timeZone) {
    return G.ui.dateTimeInZone(ms, timeZone);
  }

  function tagLabel(tag) { return has(TAG_LABELS, tag) ? TAG_LABELS[tag] : String(tag == null ? '' : tag); }

  function tagChipHtml(tag, tagSetBy) {
    const by = tagSetBy ? '<span class="gs-sr"> (set by an officer)</span>' : '';
    return '<span class="gs-chip gs-chip-tag' + (tag === 'MS' ? '' : ' is-' + String(tag).toLowerCase()) + '" title="' + esc(has(TAG_NAMES, tag) ? TAG_NAMES[tag] : tag) + '">' + esc(tagLabel(tag)) + by + '</span>';
  }

  function tagSelectHtml(award) {
    return '<label class="gs-sr" for="tag-' + esc(award.id) + '">Tag for ' + esc(award.itemName || 'this item') + '</label><select class="gs-input gs-input-sm gs-loot-tagsel" id="tag-' + esc(award.id) + '" data-change="loot-tag" data-aid="' + esc(award.id) + '" data-key="tag-' + esc(award.id) + '">' +
      TAGS.map(function (t) { return '<option value="' + t + '"' + (t === award.tag ? ' selected' : '') + '>' + esc(TAG_NAMES[t]) + '</option>'; }).join('') + '</select>';
  }

  function flagChipsHtml(flags) {
    const list = Array.isArray(flags) ? flags : [];
    return list.filter(function (f) {
      return has(FLAG_LABELS, f) && !(f === 'TMB' && (list.indexOf('PL') >= 0 || list.indexOf('WL') >= 0));
    }).map(function (f) { return '<span class="gs-chip gs-chip-src">' + esc(FLAG_LABELS[f]) + '</span>'; }).join('');
  }

  function winnerText(w) {
    const x = w || {};
    return String(x.name == null ? '' : x.name) + (x.realm ? '-' + x.realm : '');
  }

  // A disenchanted item has no winner: the Worker answers match.kind 'disenchanted' (winner.name is null) and the tag DE.
  function isDisenchanted(award) {
    return !!award && !!award.match && award.match.kind === 'disenchanted';
  }

  // The winner of an award: the person (a link to their loot) when a roster character matched, else the Gargul name with a
  // chip saying why there is no person; "Disenchanted" for an item nobody won. `match` is the Worker's { kind, personId, personName, characterName, ... }.
  function winnerHtml(gid, winner, match) {
    const w = winner || {};
    const m = match || {};
    if (m.kind === 'disenchanted') return '<span class="gs-char-text"><span class="gs-muted">Disenchanted</span></span>';
    if (m.kind === 'character') {
      const name = m.personName || m.characterName || w.name || '';
      const sub = m.characterName && m.personName && m.characterName !== m.personName ? '<span class="gs-char-sub">' + esc(m.characterName) + '</span>' : '';
      const who = m.personId
        ? '<a class="gs-char-link ' + G.ui.classClass(w.class) + '" href="' + esc(G.router.format({ name: 'lootperson', gid: gid, pid: m.personId })) + '">' + esc(name) + '</a>'
        : G.ui.classNameHtml(name, w.class);
      return '<span class="gs-char-text">' + who + sub + '</span>';
    }
    const chip = m.kind === 'guest' ? 'Guest' : 'Not on roster';
    return '<span class="gs-char-text">' + G.ui.classNameHtml(winnerText(w), w.class) + '</span><span class="gs-chip gs-chip-flag">' + chip + '</span>';
  }

  // The character that won it, as the person pages show it (no link: the page is already that person's).
  function characterHtml(award) {
    const m = award.match || {};
    if (m.kind === 'disenchanted') return winnerHtml(null, award.winner, m);
    return '<span class="gs-char-text">' + G.ui.classNameHtml(m.characterName || winnerText(award.winner), (award.winner || {}).class) + '</span>';
  }

  // One award as a row. opts: { edit (select + note + delete), character (show the character, not the person), when: 'time' | 'datetime' | 'date', status (html chip), raidLink }.
  function awardRowHtml(gd, award, opts) {
    const o = opts || {};
    const gid = gd.guild.id;
    const a1 = award || {};
    const when = o.when === 'date'
      ? (o.raidLink && a1.raidId ? '<a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: a1.raidId })) + '">' + esc(G.ui.weekdayDay(a1.raidOn) || a1.raidOn || '') + '</a>' : esc(G.ui.weekdayDay(a1.raidOn) || a1.raidOn || ''))
      : (a1.manual ? '' : esc(o.when === 'datetime' ? dateTimeText(a1.awardedAt, gd.guild.timeZone) : timeText(a1.awardedAt, gd.guild.timeZone))); // an award by hand has no time of its own
    const rollNote = a1.rollType && a1.rollType !== 'MS' && a1.rollType !== 'OS' ? '<span class="gs-char-sub">Roll: ' + esc(a1.rollType) + '</span>' : '';
    const noteLine = a1.note ? '<span class="gs-char-sub">Note: ' + esc(a1.note) + '</span>' : '';
    const actions = o.edit
      ? '<span class="gs-loot-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="loot-note" data-aid="' + esc(a1.id) + '" data-key="note-' + esc(a1.id) + '">' + (a1.note ? 'Edit note' : 'Add note') + '</button>' +
        '<button type="button" class="gs-icon-btn gs-icon-btn-danger" data-action="loot-delete" data-aid="' + esc(a1.id) + '" data-key="del-' + esc(a1.id) + '" aria-label="' + esc('Delete the award of ' + (a1.itemName || 'this item')) + '">' + G.icons.icon('trash', 18) + '</button></span>' : '';
    return '<li class="gs-loot-row" id="loot-' + esc(a1.id) + '"><span class="gs-loot-when">' + when + '</span>' +
      '<span class="gs-loot-item">' + itemHtml({ itemId: a1.itemId, itemName: a1.itemName, quality: a1.quality }, gd.guild.gameVersion) + rollNote + noteLine + '</span>' +
      '<span class="gs-loot-who"><span class="gs-sr">Winner: </span>' + (o.character ? characterHtml(a1) : winnerHtml(gid, a1.winner, a1.match)) + '</span>' +
      // Nobody won a disenchanted item, so it stays DE: officers get the chip, not the tag select.
      '<span class="gs-loot-tag"><span class="gs-sr">Tag: </span>' + (o.edit && !isDisenchanted(a1) ? tagSelectHtml(a1) : tagChipHtml(a1.tag, a1.tagSetBy)) + '</span>' +
      '<span class="gs-loot-flags">' + (o.status || '') + (a1.manual ? '<span class="gs-chip gs-chip-src" title="Added by an officer, not imported from Gargul">Manual</span>' : '') + flagChipsHtml(a1.flags) + '</span>' + actions + '</li>';
  }

  function totalsHtml(totals) {
    const t = totals || {};
    return '<dl class="gs-summary">' + TAGS.map(function (k) {
      return '<div class="gs-summary-item"><dt>' + esc(TAG_NAMES[k]) + '</dt><dd>' + esc(num(t[k]) == null ? 0 : t[k]) + '</dd></div>';
    }).join('') + '</dl>';
  }

  // ── balance maths on the Worker's rows ──
  // w: 'window' | 'all'. Every figure can be missing; null reads as a dash.
  function figure(obj, w) { return obj && typeof obj === 'object' ? num(obj[w]) : null; }
  function itemFigure(p, tag, w) { return p && p.items && p.items[tag] ? figure(p.items[tag], w) : null; }

  // Every item the team's people have, any tag, any time: zero means the page has nothing to rank.
  function totalAwards(data) {
    return (Array.isArray(data.people) ? data.people : []).reduce(function (sum, p) {
      return sum + TAGS.reduce(function (s, t) { return s + (itemFigure(p, t, 'all') || 0); }, 0);
    }, 0);
  }

  function balanceRows(data, w) {
    const avg = figure(data.teamAverage, w);
    return (Array.isArray(data.people) ? data.people : []).map(function (p) {
      const perRaid = figure(p.perRaid, w);
      // The Worker's vsTeam is the window figure; the all-time one is worked out here from the all-time average.
      const serverVs = w === 'window' ? num(p.vsTeam) : null;
      return {
        id: p.personId, name: p.name, class: p.class, status: p.status, isMe: !!p.isMe,
        raids: figure(p.raids, w), ms: itemFigure(p, 'MS', w), os: itemFigure(p, 'OS', w), counted: figure(p.counted, w),
        perRaid: perRaid, vs: serverVs != null ? serverVs : (perRaid != null && avg != null ? perRaid - avg : null),
      };
    });
  }

  function pinMine(rows) {
    return rows.filter(function (r) { return r.isMe; }).concat(rows.filter(function (r) { return !r.isMe; }));
  }

  function defaultSort(mode) { return { column: mode === 'count' ? 'counted' : 'perRaid', dir: 'desc' }; }

  function nextSort(sort, column) {
    if (sort && sort.column === column) return { column: column, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    return { column: column, dir: column === 'name' ? 'asc' : 'desc' };
  }

  // Empty values (a dash) sort last in either direction; ties fall back to the name.
  function sortRows(rows, sort) {
    const dir = sort.dir === 'desc' ? -1 : 1;
    const key = function (r) { return sort.column === 'name' ? String(r.name == null ? '' : r.name) : r[sort.column]; };
    return rows.slice().sort(function (x, y) {
      const vx = key(x);
      const vy = key(y);
      const ex = vx == null || vx === '';
      const ey = vy == null || vy === '';
      if (ex !== ey) return ex ? 1 : -1;
      const c = ex ? 0 : dir * (typeof vx === 'string' ? vx.localeCompare(vy, 'en') : vx - vy);
      return c || String(x.name == null ? '' : x.name).localeCompare(String(y.name == null ? '' : y.name), 'en');
    });
  }

  function fixed(v, digits) { return v == null ? '-' : v.toFixed(digits); }
  function count(v) { return v == null ? '-' : String(Math.round(v)); }
  function signed(v) {
    if (v == null) return '-';
    const t = v.toFixed(2);
    return v > 0 && t !== '0.00' ? '+' + t : (t === '-0.00' ? '0.00' : t);
  }

  function countedText(tags) {
    const list = Array.isArray(tags) && tags.length ? tags : ['MS'];
    return list.map(tagLabel).join(' and ');
  }

  // ── page pieces ──
  function viewSwitchHtml(view) {
    return '<div class="gs-segs" role="group" aria-label="Loot view">' + VIEWS.map(function (v) {
      return '<button type="button" class="gs-seg" data-action="loot-view" data-view="' + v.value + '" data-key="lview-' + v.value + '" aria-pressed="' + (view === v.value ? 'true' : 'false') + '">' + esc(v.label) + '</button>';
    }).join('') + '</div>';
  }

  function windowSwitchHtml(data, ui) {
    const w = data.window || {};
    const weeks = Array.isArray(w.switchWeeks) && w.switchWeeks.length ? w.switchWeeks : [8, 12];
    const items = weeks.map(function (n) { return { value: n, label: n + ' weeks' }; }).concat([{ value: 'all', label: 'All time' }]);
    const current = ui.window === 'all' ? 'all' : (typeof w.weeks === 'number' ? w.weeks : null);
    return '<div class="gs-segs" role="group" aria-label="Time window">' + items.map(function (it) {
      return '<button type="button" class="gs-seg" data-action="loot-window" data-window="' + esc(it.value) + '" data-key="lwin-' + esc(it.value) + '" aria-pressed="' + (String(current) === String(it.value) ? 'true' : 'false') + '">' + esc(it.label) + '</button>';
    }).join('') + '</div>';
  }

  function sortHeaderHtml(col, sort) {
    const aria = A().ariaSort(sort, col);
    const dir = aria === 'descending' ? 'desc' : aria === 'ascending' ? 'asc' : '';
    return '<th scope="col"' + (aria ? ' aria-sort="' + aria + '"' : '') + '><button type="button" class="gs-sort" data-action="loot-sort" data-col="' + col + '" data-key="lsort-' + col + '"' + (dir ? ' data-dir="' + dir + '"' : '') + '>' +
      esc(COLUMN_LABELS[col]) + '<span class="gs-sort-ind" aria-hidden="true"></span></button></th>';
  }

  function nameCellHtml(gid, r) {
    const link = r.id
      ? '<a class="gs-char-link ' + G.ui.classClass(r.class) + '" href="' + esc(G.router.format({ name: 'lootperson', gid: gid, pid: r.id })) + '">' + esc(r.name) + '</a>'
      : G.ui.classNameHtml(r.name, r.class);
    return '<span class="gs-att-name">' + link + (r.isMe ? '<span class="gs-you">You</span>' : '') + (r.status === 'inactive' ? '<span class="gs-chip gs-chip-plain">Inactive</span>' : '') + '</span>';
  }

  function balanceTableHtml(gid, rows, columns, sort) {
    const cell = function (c, r) {
      switch (c) {
        case 'raids': return count(r.raids);
        case 'ms': return count(r.ms);
        case 'os': return count(r.os);
        case 'counted': return count(r.counted);
        case 'perRaid': return fixed(r.perRaid, 2);
        default: return signed(r.vs);
      }
    };
    const head = columns.map(function (c) { return sortHeaderHtml(c, sort); }).join('');
    const body = rows.map(function (r) {
      return '<tr' + (r.isMe ? ' class="is-you"' : '') + '><th scope="row" class="gs-cell-strong">' + nameCellHtml(gid, r) + '</th>' +
        columns.slice(1).map(function (c) { return '<td class="gs-nowrap gs-num">' + esc(cell(c, r)) + '</td>'; }).join('') + '</tr>';
    }).join('');
    const cards = rows.map(function (r) {
      return '<li class="gs-loot-card' + (r.isMe ? ' is-you' : '') + '"><div class="gs-card-top">' + nameCellHtml(gid, r) + '</div><dl class="gs-att-stats">' +
        columns.slice(1).map(function (c) { return '<div><dt>' + esc(COLUMN_LABELS[c]) + '</dt><dd>' + esc(cell(c, r)) + '</dd></div>'; }).join('') + '</dl></li>';
    }).join('');
    return '<div class="gs-table-wrap gs-loot-table"><table class="gs-table gs-table-loot" aria-label="Loot balance"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<ul class="gs-loot-cards" aria-label="Loot balance">' + cards + '</ul>';
  }

  function emptyHtml(gd, teamId) {
    const edit = allows(gd, 'loot.edit', teamId);
    return '<section class="gs-empty-card" aria-labelledby="loot-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('loot', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="loot-empty-h">No loot yet</h2>' +
      '<p class="gs-lead gs-lead-sm">' + (edit ? 'Loot builds up from raids. Open a past raid and choose Import from Gargul to add what was awarded.' : 'Loot shows here after your officers import a raid\'s awards from Gargul.') + '</p>' +
      (edit ? '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'section', gid: gd.guild.id, section: 'raids' })) + '">Open Raids</a></div>' : '') + '</section>';
  }

  function noAccessHtml(gd, teamId) {
    const team = teamOf(gd, teamId);
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Loot</h1></div><section class="gs-empty-card"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('loot', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg">You can\'t see this team\'s loot</h2><p class="gs-lead gs-lead-sm">Who sees the loot of ' + esc(team ? team.name : 'this team') + ' is set by the guild\'s officers in Guild settings.</p></section></div>';
  }

  // The Balance view's window switch sits in the page's segment bar, and only when the table does (an empty view keeps just the view switch).
  function balanceBarHtml(gd, teamId, data, ui) {
    const rows = balanceRows(data, ui.window === 'all' ? 'all' : 'window');
    return rows.length && totalAwards(data) > 0 ? windowSwitchHtml(data, ui) : '';
  }

  function balanceBodyHtml(gd, teamId, data, ui) {
    const gid = gd.guild.id;
    const w = ui.window === 'all' ? 'all' : 'window';
    const mode = data.mode === 'count' ? 'count' : 'perRaid';
    const columns = mode === 'count' ? ['name', 'raids', 'ms', 'os', 'counted'] : COLUMNS;
    const rows = balanceRows(data, w);
    const sorted = pinMine(sortRows(rows, ui.sort || defaultSort(mode))); // the viewer's own row first ("You"), whatever the sort
    const avg = figure(data.teamAverage, w);
    const own = data.scope === 'own';
    const since = data.window && typeof data.window.from === 'string' && G.ui.formatDay(data.window.from) ? ' since ' + G.ui.formatDay(data.window.from) : '';
    const rules = mode === 'count'
      ? 'Counted items: ' + countedText(data.countTags) + '. People are ranked by how many they have counted.'
      : 'Counted items: ' + countedText(data.countTags) + '. Per raid is the counted items divided by the raids the person attended; Vs team is the difference from the team average.';
    const averageLine = mode === 'perRaid'
      ? '<dl class="gs-summary"><div class="gs-summary-item"><dt>Team average per raid</dt><dd>' + esc(fixed(avg, 2)) + '</dd></div></dl>' : '';
    if (!rows.length || !(totalAwards(data) > 0)) return emptyHtml(gd, teamId);
    const span = ui.window === 'all' ? 'All time. ' : (data.window && typeof data.window.weeks === 'number' ? 'Last ' + plural(data.window.weeks, 'full reset week', 'full reset weeks') + since + '. ' : '');
    return (own ? '<div class="gs-notice" role="status"><span>You see your own loot only. The team average is for comparison. Officers choose who sees what in Guild settings.</span></div>' : '') +
      '<p class="gs-fine" id="loot-rules">' + esc(span + rules) + '</p>' +
      averageLine + balanceTableHtml(gid, sorted, columns, ui.sort || defaultSort(mode));
  }

  function raidsBodyHtml(gd, teamId, data) {
    const gid = gd.guild.id;
    const list = Array.isArray(data.raids) ? data.raids : [];
    if (!list.length) return emptyHtml(gd, teamId);
    const href = function (x) { return G.router.format({ name: 'raid', gid: gid, rid: x.raidId }); };
    const title = function (x) { return [x.title, x.zone].filter(Boolean).join(' - '); };
    const body = list.map(function (x) {
      return '<tr><th scope="row" class="gs-cell-strong"><a class="gs-raid-link" href="' + esc(href(x)) + '">' + esc(G.ui.weekdayDay(x.raidOn) || x.raidOn) + '</a></th><td>' + (title(x) ? esc(title(x)) : '<span class="gs-muted">-</span>') + '</td>' +
        '<td class="gs-num">' + esc(count(num(x.awards))) + '</td><td class="gs-num">' + esc(count(num(x.counted))) + '</td><td class="gs-num">' + disenchantedCell(x.disenchanted) + '</td><td>' + unmatchedChip(x.unmatched) + '</td></tr>';
    }).join('');
    const cards = list.map(function (x) {
      return '<li class="gs-loot-card"><div class="gs-card-top"><a class="gs-raid-link" href="' + esc(href(x)) + '">' + esc(G.ui.weekdayDay(x.raidOn) || x.raidOn) + '</a>' + unmatchedChip(x.unmatched) + '</div>' +
        (title(x) ? '<p class="gs-fine">' + esc(title(x)) + '</p>' : '') + '<dl class="gs-att-stats"><div><dt>Awards</dt><dd>' + esc(count(num(x.awards))) + '</dd></div><div><dt>Counted</dt><dd>' + esc(count(num(x.counted))) + '</dd></div>' +
        (num(x.disenchanted) > 0 ? '<div><dt>Disenchanted</dt><dd>' + esc(count(num(x.disenchanted))) + '</dd></div>' : '') + '</dl></li>';
    }).join('');
    return '<div class="gs-table-wrap gs-loot-table"><table class="gs-table gs-table-lootraids" aria-label="Loot by raid"><thead><tr><th scope="col">Raid</th><th scope="col">Zone</th><th scope="col">Awards</th><th scope="col">Counted</th><th scope="col">Disenchanted</th><th scope="col">Winners not on the roster</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<ul class="gs-loot-cards" aria-label="Loot by raid">' + cards + '</ul>';
  }

  // Items nobody won (Gargul's disenchants) on a raid; a dash when there are none.
  function disenchantedCell(n) {
    return num(n) > 0 ? esc(count(num(n))) : '<span class="gs-muted">-</span>';
  }

  function unmatchedChip(n) {
    return num(n) > 0 ? '<span class="gs-chip gs-chip-flag">' + esc(plural(n, 'winner', 'winners')) + ' not on the roster</span>' : '<span class="gs-muted">-</span>';
  }

  function itemsBodyHtml(gd, teamId, data) {
    const gid = gd.guild.id;
    const list = Array.isArray(data.items) ? data.items : [];
    if (!list.length) return emptyHtml(gd, teamId);
    return '<ul class="gs-loot-items" aria-label="Loot by item">' + list.map(function (it) {
      const awards = Array.isArray(it.awards) ? it.awards : [];
      const rows = awards.map(function (x) {
        return '<li class="gs-loot-subrow"><a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: x.raidId })) + '">' + esc(G.ui.weekdayDay(x.raidOn) || x.raidOn) + '</a>' +
          '<span class="gs-loot-who">' + winnerHtml(gid, x.winner, x.match) + '</span>' + tagChipHtml(x.tag, x.tagSetBy) + '</li>';
      }).join('');
      return '<li class="gs-loot-itemrow"><details class="gs-loot-item"><summary><span class="gs-loot-item-name">' + itemHtml({ itemId: it.itemId, itemName: it.itemName, quality: it.quality }, gd.guild.gameVersion) + '</span>' +
        '<span class="gs-fine">' + esc(plural(num(it.count) == null ? awards.length : it.count, 'award', 'awards')) + (it.lastAwardedAt ? ' &middot; last ' + esc(dateText(it.lastAwardedAt, gd.guild.timeZone)) : '') + '</span></summary>' +
        (rows ? '<ul class="gs-loot-sublist" aria-label="Awards of this item">' + rows + '</ul>' : '<p class="gs-fine">No awards listed.</p>') + '</details></li>';
    }).join('') + '</ul>';
  }

  // opts: { guildData, teamId, view, data, denied, ui: { sort, window }, alert }
  function lootHtml(opts) {
    const gd = opts.guildData;
    const teamId = opts.teamId;
    if (opts.denied) return noAccessHtml(gd, teamId);
    const view = opts.view || 'balance';
    const data = opts.data || {};
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = teamOf(gd, teamId);
    const people = Array.isArray(data.people) ? data.people : null;
    const context = (several && team ? team.name : gd.guild.name) + (view === 'balance' && people ? ' - ' + plural(people.length, 'person', 'people') : '');
    const pageUi = opts.ui || { sort: null, window: null };
    let body;
    if (view === 'raids') body = raidsBodyHtml(gd, teamId, data);
    else if (view === 'items') body = itemsBodyHtml(gd, teamId, data);
    else body = balanceBodyHtml(gd, teamId, data, pageUi);
    return G.ui.listPageHtml({
      head: { title: 'Loot', context: context }, pageClass: 'gs-loot-page',
      noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'),
      barHtml: viewSwitchHtml(view) + (view === 'balance' ? balanceBarHtml(gd, teamId, data, pageUi) : ''), bodyHtml: body,
    });
  }

  // ── data ──
  function ui() {
    const s = a();
    if (!s.lootUi) s.lootUi = { sort: null, window: null, windowTeam: null };
    return s.lootUi;
  }

  function viewOf(r) { return r && r.view === 'raids' ? 'raids' : (r && r.view === 'items' ? 'items' : 'balance'); }

  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    const view = viewOf(r);
    if (!teamId) { a().loot = { gid: gid, teamId: null, view: view, data: null }; return null; }
    const u = ui();
    // A window belongs to one team (each team has its own offered weeks): a team change goes back to its default.
    if (u.windowTeam !== teamId) { u.window = null; u.windowTeam = teamId; }
    let call;
    if (view === 'raids') call = G.api.loot.raids(gid, teamId);
    else if (view === 'items') call = G.api.loot.items(gid, teamId);
    else {
      const weeks = typeof u.window === 'number' ? u.window : null;
      // A week count the team does not offer is a 400: fall back to its default.
      call = G.api.loot.balance(gid, teamId, weeks).catch(function (err) {
        if (weeks != null && err && err.status === 400) { u.window = null; return G.api.loot.balance(gid, teamId, null); }
        throw err;
      });
    }
    return call.then(function (data) {
      a().loot = { gid: gid, teamId: teamId, view: view, data: data, denied: false };
      return null;
    }, function (err) {
      if (err && err.status === 403) { a().loot = { gid: gid, teamId: teamId, view: view, data: null, denied: true }; return null; }
      throw err;
    });
  }

  function main(r, gd) {
    const x = a().loot;
    if (!x || x.gid !== gd.guild.id || x.view !== viewOf(r)) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return lootHtml({ guildData: gd, teamId: x.teamId, view: x.view, data: x.data, denied: x.denied, ui: ui(), alert: st().pageAlert });
  }

  // ── handlers ──
  G.handlers.click['loot-view'] = function (el) {
    const gd = currentGd();
    if (!gd) return;
    const v = el.getAttribute('data-view');
    G.app.go(G.router.format({ name: 'section', gid: gd.guild.id, section: 'loot', view: v === 'raids' || v === 'items' ? v : undefined }));
  };

  G.handlers.click['loot-window'] = function (el) {
    const raw = el.getAttribute('data-window');
    ui().window = raw === 'all' ? 'all' : Number(raw);
    // All time is already in the answer (every figure comes as window and all); a week count needs its own answer.
    if (raw === 'all') G.app.render(); else G.app.routeAll({ force: true });
  };

  G.handlers.click['loot-sort'] = function (el) {
    const x = a().loot;
    const mode = x && x.data && x.data.mode === 'count' ? 'count' : 'perRaid';
    const u = ui();
    u.sort = nextSort(u.sort || defaultSort(mode), el.getAttribute('data-col'));
    G.app.render();
  };

  G.pages.loot = {
    TAGS: TAGS,
    TAG_LABELS: TAG_LABELS,
    TAG_NAMES: TAG_NAMES,
    FLAG_LABELS: FLAG_LABELS,
    VIEWS: VIEWS,
    COLUMNS: COLUMNS,
    itemUrl: itemUrl,
    itemHtml: itemHtml,
    timeText: timeText,
    tagChipHtml: tagChipHtml,
    tagSelectHtml: tagSelectHtml,
    flagChipsHtml: flagChipsHtml,
    winnerText: winnerText,
    isDisenchanted: isDisenchanted,
    winnerHtml: winnerHtml,
    awardRowHtml: awardRowHtml,
    totalsHtml: totalsHtml,
    balanceRows: balanceRows,
    defaultSort: defaultSort,
    nextSort: nextSort,
    sortRows: sortRows,
    lootHtml: lootHtml,
    emptyHtml: emptyHtml,
    plural: plural,
    allows: allows,
    apiBase: apiBase,
    viewOf: viewOf,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
