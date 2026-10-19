// ── PAGES: THE LOOT HUB (#/g/:gid/loot) AND STANDINGS (#/g/:gid/loot/standings) ──
// The hub reads GET /loot/hub?team= and draws the cards the viewer's role gets (loot page spec, sections 1 and 2):
//   edit holders (Team Lead and above)  Who is due, Latest raid nights, Look up an item, Needs fixing, and a Loot rules link for loot.policy
//   members                             My loot by raid day (left), Latest raid nights with who received what (right); Who is due and
//                                       Look up an item only when the team's loot rules switch them on (hub.can); level "own": My loot only
// "Who is due" reads the hub's standingsTop / standingsCount / standingsInfo (the 5 most due, in the Standings order), the item search reads
// GET /loot/items, and "All N raid nights" / "Earlier raid nights" expand in place from GET /loot/raids. Standings is the T1 list of the balance.
// Safe to load alone: nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  const DUE_CARD_ROWS = 5;
  const STANDINGS_LIMIT = 16;
  const SEARCH_ROWS = 8;
  const SORTS = [{ key: 'due', label: 'Most due first' }, { key: 'name', label: 'Name A-Z' }];

  function L() { return G.pages.loot; }
  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function teamName(gd, teamId) { const t = L() ? G.pages.attendance.teamOf(gd, teamId) : null; return t ? t.name : ''; }
  function dayText(raidOn) { return G.ui.weekdayDay(raidOn) || raidOn || 'Raid night'; }
  function href(route) { return G.router.format(route); }

  function ui() {
    const s = a();
    if (!s.lootUi) s.lootUi = { sort: 'due', window: null, windowTeam: null, showAll: false };
    return s.lootUi;
  }

  // ── Who is due ──
  function dueKey(row, mode) { return mode === 'count' ? row.counted : row.perRaid; }

  // Lowest figure first (the most due); a person with no figure last; ties: more raids attended first, then name (pages-loot.js compareDue).
  function dueOrder(rows, mode) {
    return rows.slice().sort(function (x, y) { return L().compareDue(x, y, mode, 'asc'); });
  }

  function dueFigure(row, mode) {
    return mode === 'count' ? L().count(row.counted) : L().fixed(row.perRaid, 2);
  }

  function dueSub(row) {
    return L().count(row.ms) + ' MS - ' + L().count(row.os) + ' OS - ' + plural(Number(row.raids) || 0, 'raid', 'raids');
  }

  function dueCardHtml(gd, balance) {
    const gid = gd.guild.id;
    const mode = balance.mode === 'count' ? 'count' : 'perRaid';
    const rows = dueOrder(L().balanceRows(balance, 'window').filter(function (r) { return r.status !== 'inactive'; }), mode).slice(0, DUE_CARD_ROWS);
    const weeks = balance.window && typeof balance.window.weeks === 'number' ? 'Last ' + balance.window.weeks + ' weeks' : '';
    const note = (mode === 'count' ? 'Counted items: ' : 'Counted items per raid attended: ') + L().countedText(balance.countTags) + '. The lowest figure is the most due.';
    const body = rows.length
      ? '<ol class="gs-lhub-list" aria-label="Who is due">' + rows.map(function (r) {
        const name = r.id ? '<a class="gs-char-link ' + G.ui.classClass(r.class) + '" href="' + esc(href({ name: 'lootperson', gid: gid, pid: r.id })) + '">' + esc(r.name) + '</a>' : G.ui.classNameHtml(r.name, r.class);
        return '<li class="gs-lhub-row' + (r.isMe ? ' is-you' : '') + '"><span class="gs-lhub-main">' + name + (r.isMe ? '<span class="gs-you">You</span>' : '') + '<span class="gs-fine">' + esc(dueSub(r)) + '</span></span>' +
          '<span class="gs-lhub-figure"><strong class="gs-num">' + esc(dueFigure(r, mode)) + '</strong><span class="gs-fine">' + (mode === 'count' ? 'counted' : 'per raid') + '</span></span></li>';
      }).join('') + '</ol>'
      : '<p class="gs-fine">Nobody has a loot figure yet.</p>';
    return card({ id: 'lhub-due', title: 'Who is due', sub: weeks, bodyHtml: '<p class="gs-fine">' + esc(note) + '</p>' + body +
      '<p class="gs-fine"><a class="gs-fg-u" href="' + esc(href({ name: 'lootstandings', gid: gid })) + '">Full standings, ' + esc(plural(typeof balance.count === 'number' ? balance.count : (balance.people || []).length, 'person', 'people')) + '</a></p>' });
  }

  function card(o) {
    return '<section class="gs-card-sec gs-lhub-card" id="' + esc(o.id) + '" aria-labelledby="' + esc(o.id) + '-h"><div class="gs-card-sec-head"><div class="gs-lhub-head"><h2 class="gs-h2" id="' + esc(o.id) + '-h">' + esc(o.title) + '</h2>' +
      (o.sub ? '<span class="gs-fine">' + esc(o.sub) + '</span>' : '') + '</div>' + (o.chipHtml || '') + '</div><div class="gs-card-sec-body">' + o.bodyHtml + '</div></section>';
  }

  // ── Latest raid nights ──
  function nightMeta(night) {
    return L().raidLabel(night.raid);
  }

  function receivedHtml(gd, hub, night) {
    const gid = gd.guild.id;
    const mine = hub.me ? hub.me.personId : null;
    return '<ul class="gs-loot-sublist" aria-label="Loot awarded on ' + esc(dayText(night.raid.raidOn)) + '">' + (night.awards || []).map(function (w) {
      const you = mine && w.match && w.match.personId === mine;
      return '<li class="gs-loot-subrow"><span class="gs-loot-item">' + L().itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + '</span>' +
        '<span class="gs-loot-who">' + L().winnerHtml(gid, w.winner, w.match) + (you ? '<span class="gs-you">You</span>' : '') + '</span>' + L().tagChipHtml(w.tag, w.tagSetBy) + '</li>';
    }).join('') + '</ul>';
  }

  // Edit holders get one link row per night; members get the night opened with who received what (the newest night open, the others folded).
  function nightsCardHtml(gd, x) {
    const hub = x.hub;
    const gid = gd.guild.id;
    const edit = !!hub.can.edit;
    const nights = Array.isArray(hub.nights) ? hub.nights : [];
    const shownIds = nights.map(function (n) { return n.raid.id; });
    let body;
    if (!nights.length) body = '<p class="gs-fine">' + esc(edit ? 'No loot is recorded yet. Open a past raid and choose Import from Gargul.' : 'No loot is recorded for this team yet.') + '</p>';
    else if (edit) {
      body = '<ul class="gs-lhub-links" aria-label="Latest raid nights">' + nights.map(function (n) {
        return '<li><a class="gs-lhub-link" href="' + esc(href({ name: 'lootnight', gid: gid, rid: n.raid.id })) + '"><span class="gs-lhub-main"><strong>' + esc(dayText(n.raid.raidOn)) + '</strong>' +
          '<span class="gs-fine">' + esc(plural(n.awards.length, 'award', 'awards') + (nightMeta(n) ? ' - ' + nightMeta(n) : '')) + '</span></span></a></li>';
      }).join('') + '</ul>';
    } else {
      body = '<ul class="gs-loot-items" aria-label="Latest raid nights">' + nights.map(function (n, i) {
        return '<li class="gs-loot-itemrow"><details class="gs-loot-item"' + (i === 0 ? ' open' : '') + '><summary><span class="gs-loot-item-name"><strong>' + esc(dayText(n.raid.raidOn)) + '</strong></span>' +
          '<span class="gs-fine">' + esc(plural(n.awards.length, 'award', 'awards') + (nightMeta(n) ? ' - ' + nightMeta(n) : '')) + '</span></summary>' + receivedHtml(gd, hub, n) +
          '<p class="gs-fine"><a class="gs-fg-u" href="' + esc(href({ name: 'lootnight', gid: gid, rid: n.raid.id })) + '">Open the night</a></p></details></li>';
      }).join('') + '</ul>';
    }
    const raids = Array.isArray(x.raids) ? x.raids : [];
    const rest = edit ? raids : raids.filter(function (r) { return shownIds.indexOf(r.raidId) < 0; });
    if (rest.length && hub.level !== 'own') {
      const label = edit ? 'All ' + raids.length + ' raid nights' : 'Earlier raid nights';
      if (x.ui.allNights) {
        body += '<ul class="gs-lhub-links" id="lhub-all" aria-label="' + esc(label) + '">' + rest.map(function (r) {
          return '<li><a class="gs-lhub-link" href="' + esc(href({ name: 'lootnight', gid: gid, rid: r.raidId })) + '"><span class="gs-lhub-main"><strong>' + esc(dayText(r.raidOn)) + '</strong>' +
            '<span class="gs-fine">' + esc(plural(Number(r.awards) || 0, 'award', 'awards') + (L().raidLabel(r) ? ' - ' + L().raidLabel(r) : '')) + '</span></span></a></li>';
        }).join('') + '</ul><p><button type="button" class="gs-linkbtn" data-action="lhub-nights" data-key="lhub-nights" aria-expanded="true">Show fewer</button></p>';
      } else {
        body += '<p><button type="button" class="gs-linkbtn" data-action="lhub-nights" data-key="lhub-nights" aria-expanded="false" aria-controls="lhub-all">' + esc(label) + '</button></p>';
      }
    }
    return card({ id: 'lhub-nights', title: 'Latest raid nights', sub: edit ? 'What was awarded' : 'Newest first - who received what', bodyHtml: body });
  }

  // ── My loot ──
  function myLootCardHtml(gd, hub) {
    const gid = gd.guild.id;
    const me = hub.me;
    if (!me) {
      return card({ id: 'lhub-mine', title: 'My loot', bodyHtml: '<p class="gs-fine">You are not on this team\'s roster, so there is no loot to list for you.</p>' });
    }
    const t = me.totals || {};
    const totals = '<dl class="gs-summary"><div class="gs-summary-item"><dt>Main-spec awards</dt><dd>' + esc(Number(t.MS) || 0) + ' MS</dd></div>' +
      '<div class="gs-summary-item"><dt>Off-spec awards</dt><dd>' + esc(Number(t.OS) || 0) + ' OS</dd></div></dl>';
    const nights = Array.isArray(me.byNight) ? me.byNight : [];
    const body = nights.length
      ? nights.map(function (n) {
        return '<div class="gs-lhub-day"><h3 class="gs-h3"><a href="' + esc(href({ name: 'lootnight', gid: gid, rid: n.raid.id })) + '">' + esc(dayText(n.raid.raidOn)) + '</a> <span class="gs-fine">' + esc(plural(n.awards.length, 'item', 'items')) + '</span></h3>' +
          '<ul class="gs-loot-sublist" aria-label="My loot on ' + esc(dayText(n.raid.raidOn)) + '">' + n.awards.map(function (w) {
            return '<li class="gs-loot-subrow"><span class="gs-loot-item">' + L().itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + '</span>' + L().tagChipHtml(w.tag, w.tagSetBy) +
              (Array.isArray(w.editedFields) && w.editedFields.length ? '<span class="gs-chip gs-chip-plain" title="An officer corrected this award">Edited</span>' : '') + '</li>';
          }).join('') + '</ul></div>';
      }).join('')
      : '<p class="gs-fine">Your loot shows here after your first award is imported.</p>';
    return card({ id: 'lhub-mine', title: 'My loot', bodyHtml: totals + body +
      '<p><a class="gs-btn gs-btn-sm" href="' + esc(href({ name: 'lootperson', gid: gid, pid: me.personId })) + '">Open my loot page</a></p>' });
  }

  // ── Look up an item ──
  // Items dropped more than once on the newest night (a lead for the search box): [{ itemId, itemName, quality, n }].
  function repeatDrops(hub) {
    const night = hub.nights && hub.nights[0];
    if (!night) return [];
    const byItem = {};
    night.awards.forEach(function (w) {
      if (!w.itemId) return;
      if (!byItem[w.itemId]) byItem[w.itemId] = { itemId: w.itemId, itemName: w.itemName, quality: w.quality, n: 0 };
      byItem[w.itemId].n += 1;
    });
    return Object.keys(byItem).map(function (k) { return byItem[k]; }).filter(function (i) { return i.n > 1; })
      .sort(function (p, q) { return q.n - p.n || String(p.itemName || '').localeCompare(String(q.itemName || ''), 'en'); }).slice(0, 3);
  }

  function itemRowHtml(gd, item, sub) {
    return '<li><a class="gs-lhub-link" href="' + esc(href({ name: 'lootitem', gid: gd.guild.id, itemId: String(item.itemId) })) + '"><span class="gs-lhub-main"><strong>' + esc(item.itemName || 'Item ' + item.itemId) + '</strong>' +
      '<span class="gs-fine">' + esc(sub) + '</span></span></a></li>';
  }

  // The matches for what was typed: item names containing the text, or the item id. [] for empty text.
  function searchMatches(items, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return (Array.isArray(items) ? items : []).filter(function (it) {
      return String(it.itemId) === q || String(it.itemName || '').toLowerCase().indexOf(q) >= 0;
    }).slice(0, SEARCH_ROWS);
  }

  function searchResultsHtml(gd, x) {
    const q = String(x.ui.query || '').trim();
    if (!q) {
      const rep = repeatDrops(x.hub);
      const night = x.hub.nights && x.hub.nights[0];
      return rep.length ? '<p class="gs-fine">Dropped more than once on ' + esc(dayText(night.raid.raidOn)) + '</p><ul class="gs-lhub-links">' + rep.map(function (i) { return itemRowHtml(gd, i, plural(i.n, 'award', 'awards') + ' on that night'); }).join('') + '</ul>' : '';
    }
    const found = searchMatches(x.items, q);
    const asId = /^[1-9][0-9]{0,9}$/.test(q) && !found.some(function (i) { return String(i.itemId) === q; })
      ? '<li><a class="gs-lhub-link" href="' + esc(href({ name: 'lootitem', gid: gd.guild.id, itemId: q })) + '"><span class="gs-lhub-main"><strong>Open item ' + esc(q) + '</strong></span></a></li>' : '';
    if (!found.length && !asId) return '<p class="gs-fine">No item with that name has been awarded.</p>';
    return '<ul class="gs-lhub-links">' + found.map(function (i) { return itemRowHtml(gd, i, plural(Number(i.count) || 0, 'award', 'awards')); }).join('') + asId + '</ul>';
  }

  function lookupCardHtml(gd, x) {
    return card({ id: 'lhub-items', title: 'Look up an item', bodyHtml: '<div class="gs-field"><label class="gs-label" for="lhub-search">Item name or ID</label>' +
      '<input class="gs-input gs-input-search" type="search" id="lhub-search" name="item" autocomplete="off" spellcheck="false" aria-describedby="lhub-search-help" data-input="lhub-search" data-key="lhub-search" value="' + esc(x.ui.query || '') + '"></div>' +
      '<p class="gs-fine" id="lhub-search-help">See who has it and how often it dropped.</p><div id="lhub-results" aria-live="polite">' + searchResultsHtml(gd, x) + '</div>' });
  }

  // ── Needs fixing ──
  function fixCardHtml(gd, hub) {
    const fix = hub.fix;
    const gid = gd.guild.id;
    const total = (fix.duplicates || 0) + (fix.unknown || 0);
    const row = function (title, sub, n) {
      return '<li class="gs-lhub-row"><span class="gs-lhub-main"><strong>' + esc(title) + '</strong><span class="gs-fine">' + esc(sub) + '</span></span><span class="gs-lhub-figure">' + (n > 0 ? esc(n + ' found') : '<span class="gs-muted">None</span>') + '</span></li>';
    };
    return card({ id: 'lhub-fix', title: 'Needs fixing', chipHtml: G.ui.chipHtml({ tone: total > 0 ? 'warning' : 'success', label: total > 0 ? String(total) : 'All clear' }),
      bodyHtml: '<p class="gs-fine">Officers and Team Leads can change the winner, item, night, tag or note, or remove an award.</p><ul class="gs-lhub-list">' +
        row('Possible duplicates', 'Same night, item and winner', fix.duplicates || 0) + row('Unknown winner names', 'Every winner matches a roster character or a guest', fix.unknown || 0) + '</ul>' +
        (total > 0 ? '<p><a class="gs-btn gs-btn-sm" href="' + esc(href({ name: 'lootfix', gid: gid })) + '">' + esc(fix.duplicates > 0 ? 'Review the ' + plural(fix.duplicates, 'possible duplicate', 'possible duplicates') : 'Review the unknown names') + '</a></p>' : '') });
  }

  // ── the hub ──
  function contextOf(gd, x) {
    const hub = x.hub;
    const tn = hub.team && hub.team.name ? hub.team.name : teamName(gd, x.teamId);
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const head = several ? tn : gd.guild.name;
    if (hub.can.edit) {
      const raids = Array.isArray(x.raids) ? x.raids : null;
      if (raids) return head + ' - ' + plural(raids.reduce(function (n, r) { return n + (Number(r.awards) || 0); }, 0), 'award', 'awards') + ' from ' + plural(raids.length, 'raid night', 'raid nights');
      return head;
    }
    return head + (hub.level === 'own' ? ' - your own loot' : ' - the latest raid nights and your own loot');
  }

  // x: { gd-independent hub state }  ->  the whole page
  function hubHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    if (x.status === 'denied') return L().noAccessHtml(gd, x.teamId);
    const hub = x.hub;
    const edit = !!hub.can.edit;
    const own = hub.level === 'own';
    const hubCards = [];
    if (edit) {
      if (hub.can.standings && x.balance) hubCards.push(dueCardHtml(gd, x.balance));
      hubCards.push(nightsCardHtml(gd, x));
      if (hub.can.itemLookup) hubCards.push(lookupCardHtml(gd, x));
      if (hub.fix) hubCards.push(fixCardHtml(gd, hub));
    } else {
      hubCards.push(myLootCardHtml(gd, hub));
      if (!own) hubCards.push(nightsCardHtml(gd, x));
      if (!own && hub.can.standings && x.balance) hubCards.push(dueCardHtml(gd, x.balance));
      if (!own && hub.can.itemLookup) hubCards.push(lookupCardHtml(gd, x));
    }
    const rules = hub.can.rules ? { id: 'lhub-more', label: 'Loot rules', items: [{ label: 'Loot rules', href: href({ name: 'settings', gid: gd.guild.id, tab: 'loot' }), key: 'lhub-rules' }] } : null;
    const hasAnything = (hub.nights && hub.nights.length) || (hub.me && hub.me.byNight && hub.me.byNight.length);
    const bodyHtml = !hasAnything && edit && !(x.raids && x.raids.length) ? L().emptyHtml(gd, x.teamId) : '<div class="gs-lhub' + (edit ? ' is-officer' : ' is-member') + '">' + hubCards.join('') + '</div>';
    return G.ui.listPageHtml({
      head: { title: 'Loot', context: contextOf(gd, x), more: rules }, pageClass: 'gs-loot-page gs-loot-hub',
      noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'), bodyHtml: bodyHtml,
    });
  }

  // ── data: the hub ──
  // An old ?view= link opened the hub: the address is tidied to the plain one.
  function tidyAddress(r, gd) {
    if (!r || !r.legacyView || typeof window === 'undefined' || !window.history || typeof window.history.replaceState !== 'function') return;
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search + G.router.format({ name: 'section', gid: gd.guild.id, section: 'loot' })); } catch (e) { /* the address stays */ }
  }

  function fresh(x, gid, teamId) {
    const prev = a().lootHub;
    const ui0 = prev && prev.gid === gid && prev.teamId === teamId && prev.ui ? prev.ui : { allNights: false, query: '' };
    return Object.assign({ gid: gid, teamId: teamId, ui: ui0 }, x);
  }

  // The Who is due card's data: the hub's own standingsTop (the 5 most due, in the Standings order), standingsCount and standingsInfo. null when the hub sent none.
  function balanceOfHub(hub, own) {
    if (own || !hub.can || !hub.can.standings || !Array.isArray(hub.standingsTop)) return null;
    const info = hub.standingsInfo || {};
    return { people: hub.standingsTop, count: typeof hub.standingsCount === 'number' ? hub.standingsCount : hub.standingsTop.length, mode: info.mode, countTags: info.countTags, window: { weeks: info.weeks } };
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    tidyAddress(r, gd);
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().lootHub = { gid: gid, teamId: null, status: 'none', ui: { allNights: false, query: '' } }; return null; }
    return G.api.loot.hub(gid, teamId).then(function (hub) {
      const can = hub.can || {};
      const own = hub.level === 'own';
      const quiet = function () { return null; };
      const jobs = [
        !own ? G.api.loot.raids(gid, teamId).then(function (res) { return res && Array.isArray(res.raids) ? res.raids : null; }, quiet) : Promise.resolve(null),
        can.itemLookup && !own ? G.api.loot.items(gid, teamId).then(function (res) { return res && Array.isArray(res.items) ? res.items : null; }, quiet) : Promise.resolve(null),
      ];
      return Promise.all(jobs).then(function (res) {
        a().lootHub = fresh({ status: 'ok', hub: hub, raids: res[0], balance: balanceOfHub(hub, own), items: res[1] }, gid, teamId);
        return null;
      });
    }, function (err) {
      if (err && err.status === 403) { a().lootHub = fresh({ status: 'denied' }, gid, teamId); return null; }
      throw err;
    });
  }

  function main(r, gd) {
    const x = a().lootHub;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return hubHtml({ guildData: gd, state: x, alert: st().pageAlert });
  }

  G.handlers.click['lhub-nights'] = function () {
    const x = a().lootHub;
    if (!x || !x.ui) return;
    x.ui.allNights = !x.ui.allNights;
    G.app.render();
  };

  G.handlers.input['lhub-search'] = function (el) {
    const x = a().lootHub;
    const gd = currentGd();
    if (!x || !x.ui || !gd) return;
    x.ui.query = String(el.value || '');
    if (typeof document === 'undefined') return;
    const box = document.getElementById('lhub-results');
    if (box) box.innerHTML = searchResultsHtml(gd, x);
    if (G.ui.refreshItemTooltips && box) G.ui.refreshItemTooltips(box);
  };

  // ── standings ──
  function windowSwitchHtml(data, u) {
    const w = data.window || {};
    const weeks = Array.isArray(w.switchWeeks) && w.switchWeeks.length ? w.switchWeeks : [8, 12];
    const items = weeks.map(function (n) { return { key: n, label: n + ' weeks', dataKey: 'lwin-' + n }; }).concat([{ key: 'all', label: 'All time', dataKey: 'lwin-all' }]);
    const current = u.window === 'all' ? 'all' : (typeof w.weeks === 'number' ? w.weeks : null);
    return G.ui.segmentsHtml({ label: 'Time window', items: items, selected: current, action: 'loot-window' });
  }

  // opts: { guildData, state: { status, data, teamId }, alert }
  function standingsHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const x = opts.state;
    const u = ui();
    const back = { href: href({ name: 'section', gid: gid, section: 'loot' }), label: 'Loot' };
    if (x.status === 'denied') {
      return G.ui.listPageHtml({ head: { title: 'Standings', back: back }, bodyHtml: '<section class="gs-empty-card"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('loot', 28) + '</span>' +
        '<h2 class="gs-h2 gs-h2-lg">Standings are not shown</h2><p class="gs-lead gs-lead-sm">Your guild doesn\'t show standings to members.</p></section>' });
    }
    const data = x.data || {};
    const w = u.window === 'all' ? 'all' : 'window';
    const mode = data.mode === 'count' ? 'count' : 'perRaid';
    const rows = L().balanceRows(data, w);
    const due = dueOrder(rows, mode);
    const rankOf = {};
    due.forEach(function (r, i) { rankOf[r.id || r.name] = i + 1; });
    const ordered = u.sort === 'name' ? rows.slice().sort(function (p, q) { return String(p.name || '').localeCompare(String(q.name || ''), 'en'); }) : due;
    const perLabel = mode === 'count' ? 'Counted' : (L().countedText(data.countTags) === 'MS' ? 'MS per raid' : 'Per raid');
    const columns = [{ key: 'rank', label: '#', align: 'right', hideLabel: true }, { key: 'name', label: 'Player', primary: true }, { key: 'cls', label: 'Class' },
      { key: 'raids', label: 'Raids', align: 'right' }, { key: 'ms', label: 'MS', align: 'right' }, { key: 'os', label: 'OS', align: 'right' }, { key: 'per', label: perLabel, align: 'right' }];
    const tableRows = ordered.map(function (r) {
      return { id: r.id || r.name, you: r.isMe, mark: r.class, cells: {
        rank: esc(rankOf[r.id || r.name]),
        name: r.id ? '<a class="gs-char-link ' + G.ui.classClass(r.class) + '" href="' + esc(href({ name: 'lootperson', gid: gid, pid: r.id })) + '">' + esc(r.name) + '</a>' : G.ui.classNameHtml(r.name, r.class),
        cls: r.class ? esc(G.ui.className(r.class)) : '', raids: esc(L().count(r.raids)), ms: esc(L().count(r.ms)), os: esc(L().count(r.os)),
        per: esc(mode === 'count' ? L().count(r.counted) : L().fixed(r.perRaid, 2)) } };
    });
    const own = data.scope === 'own';
    const empty = !rows.length || !(L().totalAwards(data) > 0);
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const tn = data.team && data.team.name ? data.team.name : teamName(gd, x.teamId);
    const context = (several ? tn + ' - ' : '') + plural(rows.length, 'person', 'people') + ' - ' +
      (mode === 'count' ? 'counted items, the lowest is the most due' : L().countedText(data.countTags) + ' items per raid attended, the lowest is the most due');
    const bar = empty ? '' : G.ui.segmentsHtml({ label: 'Order', items: SORTS.map(function (s) { return { key: s.key, label: s.label, dataKey: 'lsort-' + s.key }; }), selected: u.sort, action: 'lstand-sort' }) + windowSwitchHtml(data, u);
    const notice = own ? '<div class="gs-notice" role="status"><span>You see your own loot only. The team average is for comparison. Officers choose who sees what in Loot rules.</span></div>' : '';
    const body = empty ? L().emptyHtml(gd, x.teamId)
      : G.ui.dataTableHtml({ label: 'Loot standings', columns: columns, rows: tableRows, limit: STANDINGS_LIMIT, showAll: !!u.showAll, noun: 'people', showAllAction: 'lstand-showall' });
    return G.ui.listPageHtml({ head: { title: 'Standings', context: context, back: back }, pageClass: 'gs-loot-page gs-loot-standings', noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + notice, barHtml: bar, bodyHtml: body,
      footHtml: empty ? '' : esc('Per raid is the counted items divided by the raids the person attended.') });
  }

  function loadStandings(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().lootStand = { gid: gid, teamId: null, status: 'none' }; return null; }
    const u = ui();
    // A window belongs to one team (each team has its own offered weeks): a team change goes back to its default.
    if (u.windowTeam !== teamId) { u.window = null; u.windowTeam = teamId; u.showAll = false; }
    const weeks = typeof u.window === 'number' ? u.window : null;
    // A week count the team does not offer is a 400: fall back to its default.
    return G.api.loot.balance(gid, teamId, weeks).catch(function (err) {
      if (weeks != null && err && err.status === 400) { u.window = null; return G.api.loot.balance(gid, teamId, null); }
      throw err;
    }).then(function (data) {
      a().lootStand = { gid: gid, teamId: teamId, status: 'ok', data: data };
      return null;
    }, function (err) {
      if (err && err.status === 403) { a().lootStand = { gid: gid, teamId: teamId, status: 'denied', data: null }; return null; }
      throw err;
    });
  }

  function mainStandings(r, gd) {
    const x = a().lootStand;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return standingsHtml({ guildData: gd, state: x, alert: st().pageAlert });
  }

  G.handlers.click['lstand-sort'] = function (el) {
    ui().sort = el.getAttribute('data-value') === 'name' ? 'name' : 'due';
    G.app.render();
  };

  G.handlers.click['lstand-showall'] = function () {
    ui().showAll = true;
    G.app.render();
  };

  G.handlers.click['loot-window'] = function (el) {
    const raw = el.getAttribute('data-value');
    ui().window = raw === 'all' ? 'all' : Number(raw);
    // All time is already in the answer (every figure comes as window and all); a week count needs its own answer.
    if (raw === 'all') G.app.render(); else G.app.routeAll({ force: true });
  };

  G.pages.lootHub = {
    SORTS: SORTS,
    dueOrder: dueOrder,
    repeatDrops: repeatDrops,
    searchMatches: searchMatches,
    hubHtml: hubHtml,
    standingsHtml: standingsHtml,
    load: load,
    main: main,
  };
  G.pages.lootStandings = { load: loadStandings, main: mainStandings, standingsHtml: standingsHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
