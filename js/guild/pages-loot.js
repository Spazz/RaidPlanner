// ── PAGE: LOOT (+ the award vocabulary every loot page shares) ──
// The tag / flag / item / winner builders live here; pages-raid-loot, pages-person-loot and pages-review use them.
// The Loot section (#/g/:gid/loot) is the hub in pages-loot-hub.js (which also draws Standings); the raid night and item pages are in
// pages-loot-night.js. This module also keeps the balance maths (balanceRows, sortRows) the standings use.
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

  // action: the data-change handler (the raid card's 'loot-tag' by default; the raid night page uses 'ln-tag').
  function tagSelectHtml(award, action) {
    return '<label class="gs-sr" for="tag-' + esc(award.id) + '">Tag for ' + esc(award.itemName || 'this item') + '</label><select class="gs-input gs-input-sm gs-loot-tagsel" id="tag-' + esc(award.id) + '" data-change="' + esc(action || 'loot-tag') + '" data-aid="' + esc(award.id) + '" data-key="tag-' + esc(award.id) + '">' +
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
      '<h2 class="gs-h2 gs-h2-lg">You can\'t see this team\'s loot</h2><p class="gs-fine">Who sees the loot of ' + esc(team ? team.name : 'this team') + ' is set by the guild\'s officers in Guild settings.</p></section></div>';
  }

  // The Loot section is the hub (pages-loot-hub.js); this module keeps the vocabulary and the balance maths the other loot pages share.
  function load(r, gd) { return G.pages.lootHub.load(r, gd); }
  function main(r, gd) { return G.pages.lootHub.main(r, gd); }

  G.pages.loot = {
    TAGS: TAGS,
    TAG_LABELS: TAG_LABELS,
    TAG_NAMES: TAG_NAMES,
    FLAG_LABELS: FLAG_LABELS,
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
    emptyHtml: emptyHtml,
    noAccessHtml: noAccessHtml,
    countedText: countedText,
    pinMine: pinMine,
    fixed: fixed,
    count: count,
    signed: signed,
    figure: figure,
    totalAwards: totalAwards,
    num: num,
    dateText: dateText,
    plural: plural,
    allows: allows,
    apiBase: apiBase,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
