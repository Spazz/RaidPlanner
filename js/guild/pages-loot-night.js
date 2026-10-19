// ── PAGES: ONE RAID NIGHT'S LOOT (#/g/:gid/loot/n/:rid) AND ONE ITEM (#/g/:gid/loot/i/:itemId) ──
// Raid night (T2): GET /raids/:rid/loot gives the awards and canEdit; the night's date, title and zone come from GET /loot/raids?team=. Edit holders get a
// tag select per row (a tag-only PATCH, saved at once, the row says "Saved") and a More menu: Open award, Edit details, Delete award. Members read.
// Item (T2): GET /loot/items/:itemId?team= (404: nobody has it yet; 403: the item lookup is off for members).
// The More menu and its Delete are shared with the person loot page (moreMenuHtml). The award record and Needs fixing (lootAward / lootFix) are
// placeholders here until the next lane replaces them. Safe to load alone: nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  function L() { return G.pages.loot; }
  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function dayText(raidOn) { return G.ui.weekdayDay(raidOn) || raidOn || 'Raid night'; }
  function href(route) { return G.router.format(route); }
  function edited(award) { return Array.isArray(award.editedFields) && award.editedFields.length > 0; }
  function editedChip(award) { return edited(award) ? '<span class="gs-chip gs-chip-plain" title="An officer corrected this award">Edited</span>' : ''; }

  // ── the More menu of an award row (edit holders) ──
  function moreMenuHtml(gd, award) {
    const gid = gd.guild.id;
    const name = award.itemName || 'this award';
    return G.ui.menuHtml({ id: 'lm-' + award.id, key: 'lm-' + award.id, icon: 'more', ariaLabel: 'More for ' + name, align: 'left', items: [
      { label: 'Open award', href: href({ name: 'lootaward', gid: gid, aid: award.id }), key: 'lm-open-' + award.id },
      { label: 'Edit details', href: href({ name: 'lootaward', gid: gid, aid: award.id, edit: true }), key: 'lm-edit-' + award.id },
      { separator: true },
      { label: 'Delete award', danger: true, key: 'lm-del-' + award.id, data: { action: 'ln-delete', aid: award.id } },
    ] });
  }

  // ── raid night ──
  function countsText(awards) {
    const n = function (tag) { return awards.filter(function (w) { return w.tag === tag; }).length; };
    const parts = [n('MS') + ' main spec', n('OS') + ' off spec', n('DE') + ' disenchanted'];
    if (n('BANK') > 0) parts.push(n('BANK') + ' bank');
    return parts.join(', ');
  }

  function tagCellHtml(award, edit, saved) {
    const officer = award.tagSetBy ? '<span class="gs-chip gs-chip-plain">Officer tag</span>' : '';
    const select = edit && !L().isDisenchanted(award);
    return '<span class="gs-ln-tag">' + (select ? L().tagSelectHtml(award, 'ln-tag') : L().tagChipHtml(award.tag, award.tagSetBy)) + (select ? officer : '') + editedChip(award) +
      (saved ? '<span class="gs-ln-saved" role="status">Saved</span>' : '') + '</span>';
  }

  // opts: { guildData, state: { status, awards, canEdit, raid, saved, rid, teamId }, alert }
  function nightHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const x = opts.state;
    const back = { href: href({ name: 'section', gid: gid, section: 'loot' }), label: 'Loot' };
    if (x.status === 'denied') {
      return G.ui.listPageHtml({ head: { title: 'Raid night', back: back }, bodyHtml: '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">You can\'t see this loot</h2><p class="gs-lead gs-lead-sm">Who sees the loot of a team is set by the guild\'s officers in Loot rules.</p></section>' });
    }
    if (x.status === 'none') {
      return G.ui.listPageHtml({ head: { title: 'Raid night', back: back }, bodyHtml: '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">No loot on this night</h2><p class="gs-lead gs-lead-sm">That raid night has no loot, or it does not exist.</p></section>' });
    }
    const awards = x.awards || [];
    const edit = !!x.canEdit;
    const raid = x.raid || {};
    const title = dayText(raid.raidOn || (awards[0] && awards[0].raidOn));
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = x.teamId ? G.pages.attendance.teamOf(gd, x.teamId) : null;
    const context = [[raid.title, raid.zone].filter(Boolean).join(' - '), several && team ? team.name : '', plural(awards.length, 'award', 'awards') + (awards.length ? ' - ' + countsText(awards) : '')].filter(Boolean).join(' - ');
    const raidHref = href({ name: 'raid', gid: gid, rid: x.rid });
    const more = { id: 'ln-more', label: 'More', items: [{ label: 'Open the raid page', href: raidHref, key: 'ln-raid' }, edit ? { label: 'Import from Gargul', href: raidHref, key: 'ln-import' } : null] };
    const columns = [{ key: 'item', label: 'Item', primary: true }, { key: 'winner', label: 'Winner' }, { key: 'tag', label: 'Tag' }];
    if (edit) columns.push({ key: 'actions', label: 'More', srLabel: true, hideLabel: true });
    const rows = awards.map(function (w) {
      return { id: w.id, ariaLabel: (w.itemName || 'Item') + ' awarded to ' + (L().isDisenchanted(w) ? 'nobody (disenchanted)' : L().winnerText(w.winner)), cells: {
        item: L().itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + (w.manual ? ' <span class="gs-chip gs-chip-src" title="Added by an officer, not imported from Gargul">Manual</span>' : '') + (w.note ? '<span class="gs-char-sub">Note: ' + esc(w.note) + '</span>' : ''),
        winner: L().winnerHtml(gid, w.winner, w.match), tag: tagCellHtml(w, edit, !!(x.saved && x.saved[w.id])),
        actions: edit ? moreMenuHtml(gd, w) : '' } };
    });
    const empty = '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">No loot recorded</h2><p class="gs-lead gs-lead-sm">' + esc(edit ? 'Import a Gargul export on the raid page, or add an award by hand.' : 'Nothing was awarded on this night.') + '</p></section>';
    return G.ui.listPageHtml({
      head: { title: title, context: context, back: back, more: more }, pageClass: 'gs-loot-page gs-loot-night',
      noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'),
      bodyHtml: G.ui.dataTableHtml({ label: 'Loot awarded on ' + title, columns: columns, rows: rows, limit: 1000, showAll: true, noun: 'awards', emptyHtml: empty }),
      footHtml: awards.length ? esc('All ' + plural(awards.length, 'award', 'awards') + ', in the order they were awarded.') + ' <a href="' + esc(raidHref) + '">Open the raid page</a>' : '',
    });
  }

  function loadNight(r, gd) {
    const gid = gd.guild.id;
    return G.api.loot.raid(gid, r.rid).then(function (res) {
      const awards = Array.isArray(res.awards) ? res.awards : [];
      const teamId = awards.length ? awards[0].teamId : G.app.teamFor(gd);
      const prev = a().lootNight;
      const saved = prev && prev.gid === gid && prev.rid === r.rid ? prev.saved : {};
      const state = { gid: gid, rid: r.rid, teamId: teamId, status: 'ok', awards: awards, canEdit: !!res.canEdit, raid: awards.length ? { raidOn: awards[0].raidOn } : {}, saved: saved || {} };
      a().lootNight = state;
      if (!teamId) return null;
      // The date, title and zone of the night (best effort: the page works without them).
      return G.api.loot.raids(gid, teamId).then(function (list) {
        const hit = (list && Array.isArray(list.raids) ? list.raids : []).filter(function (x) { return x.raidId === r.rid; })[0];
        if (hit) state.raid = { raidOn: hit.raidOn, title: hit.title, zone: hit.zone };
        return null;
      }, function () { return null; });
    }, function (err) {
      if (err && err.status === 403) { a().lootNight = { gid: gid, rid: r.rid, status: 'denied' }; return null; }
      if (err && err.status === 404) { a().lootNight = { gid: gid, rid: r.rid, status: 'none' }; return null; }
      throw err;
    });
  }

  function mainNight(r, gd) {
    const x = a().lootNight;
    if (!x || x.gid !== gd.guild.id || x.rid !== r.rid) return G.pages.signin.loadingHtml();
    return nightHtml({ guildData: gd, state: x, alert: st().pageAlert });
  }

  function nightNameFor(r) {
    const x = a().lootNight;
    return x && x.rid === r.rid && x.status === 'ok' ? dayText(x.raid && x.raid.raidOn) : '';
  }

  // Looks an award up on the loaded night or person page: { award, list } or null.
  function findAward(aid) {
    const night = a().lootNight;
    const person = a().personLoot;
    const lists = [night && night.status === 'ok' ? night.awards : null, person && person.data ? person.data.awards : null];
    for (let i = 0; i < lists.length; i++) {
      const hit = (lists[i] || []).filter(function (w) { return w.id === aid; })[0];
      if (hit) return hit;
    }
    return null;
  }

  function dropAward(aid) {
    const night = a().lootNight;
    if (night && Array.isArray(night.awards)) night.awards = night.awards.filter(function (w) { return w.id !== aid; });
    const person = a().personLoot;
    if (person && person.data && Array.isArray(person.data.awards)) person.data.awards = person.data.awards.filter(function (w) { return w.id !== aid; });
  }

  G.handlers.change['ln-tag'] = function (sel) {
    const x = a().lootNight;
    const gd = currentGd();
    if (!x || x.status !== 'ok' || !gd) return;
    const aid = sel.getAttribute('data-aid');
    sel.disabled = true;
    G.api.loot.update(gd.guild.id, aid, { tag: sel.value }).then(function (res) {
      if (res && res.award) x.awards = x.awards.map(function (w) { return w.id === aid ? res.award : w; });
      x.saved = {};
      x.saved[aid] = true;
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      G.app.handleError(err, { pageAlert: true });
      G.app.render();
    });
  };

  G.handlers.click['ln-delete'] = function (el) {
    const award = findAward(el.getAttribute('data-aid'));
    if (!award || !G.pages.raidLoot) return;
    G.ui.openDialog(G.pages.raidLoot.deleteDialogHtml(award, 'ln-delete-form'), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['ln-delete-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const aid = form.getAttribute('data-aid');
    G.ui.runDialog(form, G.api.loot.remove(gd.guild.id, aid), function () {
      dropAward(aid);
      st().pageAlert = '';
      G.app.render();
    });
  };

  // ── item ──
  function itemHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const x = opts.state;
    const back = { href: href({ name: 'section', gid: gid, section: 'loot' }), label: 'Loot' };
    if (x.status === 'none') {
      return G.ui.listPageHtml({ head: { title: 'Item', back: back }, bodyHtml: '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">Nobody has received that item yet.</h2><p class="gs-lead gs-lead-sm">Only items that were awarded on this team show here.</p></section>' });
    }
    if (x.status === 'denied') {
      return G.ui.listPageHtml({ head: { title: 'Item', back: back }, bodyHtml: '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">Item look-up is not shown</h2><p class="gs-lead gs-lead-sm">Your guild doesn\'t let members look up items.</p></section>' });
    }
    const d = x.data;
    const drops = Array.isArray(d.drops) ? d.drops : [];
    const edit = L().allows(gd, 'loot.edit', d.team && d.team.id);
    const nightsOf = {};
    drops.forEach(function (w) { nightsOf[w.raidId] = (nightsOf[w.raidId] || 0) + 1; });
    const nightIds = Object.keys(nightsOf);
    const counts = d.counts || {};
    const lastOn = drops.length ? dayText(drops[0].raidOn) : '';
    const context = plural(counts.total || drops.length, 'award', 'awards') + ' on ' + plural(nightIds.length, 'raid night', 'raid nights') + (lastOn ? ' - last dropped ' + lastOn : '');
    const stat = function (label, value) { return '<div class="gs-summary-item"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>'; };
    const summary = '<dl class="gs-summary">' + stat('Awards', counts.total || drops.length) + stat('Main spec', counts.MS || 0) + stat('Off spec', counts.OS || 0) + stat('Raid nights', nightIds.length) + '</dl>';
    // Awards per night, oldest first.
    const perNight = nightIds.map(function (rid) { return { rid: rid, raidOn: drops.filter(function (w) { return w.raidId === rid; })[0].raidOn, n: nightsOf[rid] }; })
      .sort(function (p, q) { return String(p.raidOn).localeCompare(String(q.raidOn)); });
    const over = '<ul class="gs-lhub-links" aria-label="Awards per night">' + perNight.map(function (n) {
      return '<li><a class="gs-lhub-link" href="' + esc(href({ name: 'lootnight', gid: gid, rid: n.rid })) + '"><span class="gs-lhub-main"><strong>' + esc(dayText(n.raidOn)) + '</strong></span><span class="gs-lhub-figure gs-num">' + esc(n.n) + '</span></a></li>';
    }).join('') + '</ul>';
    // Who has it: one row per winner per night.
    const groups = [];
    const byKey = {};
    drops.forEach(function (w) {
      const key = (w.winner && w.winner.name ? String(w.winner.name).toLowerCase() + '|' + (w.winner.realm || '') : 'de|' + w.id) + '|' + w.raidId;
      if (!byKey[key]) { byKey[key] = { first: w, times: 0, tags: [] }; groups.push(byKey[key]); }
      byKey[key].times += 1;
      if (byKey[key].tags.indexOf(w.tag) < 0) byKey[key].tags.push(w.tag);
    });
    const whoRows = groups.map(function (g) {
      return { id: g.first.id, cells: {
        winner: L().winnerHtml(gid, g.first.winner, g.first.match) + (edit && g.times > 1 && g.first.winner && g.first.winner.name ? '<span class="gs-chip gs-chip-flag">Possible duplicate</span>' : ''),
        times: esc(g.times), tag: g.tags.map(function (t) { return L().tagChipHtml(t, null); }).join(' '),
        night: '<a href="' + esc(href({ name: 'lootnight', gid: gid, rid: g.first.raidId })) + '">' + esc(dayText(g.first.raidOn)) + '</a>' } };
    });
    const who = G.ui.dataTableHtml({ label: 'Who has ' + (d.item.itemName || 'this item'), columns: [{ key: 'winner', label: 'Winner', primary: true }, { key: 'times', label: 'Times', align: 'right' }, { key: 'tag', label: 'Tag' }, { key: 'night', label: 'Night' }],
      rows: whoRows, limit: 25, noun: 'awards', showAllAction: 'litem-showall', showAll: !!(a().lootItemUi && a().lootItemUi.showAll) });
    const fixLine = edit ? '<p class="gs-fine">To fix an award, open its raid night and use More.' + (groups.some(function (g) { return g.times > 1 && g.first.winner && g.first.winner.name; }) ? ' <a class="gs-fg-u" href="' + esc(href({ name: 'lootfix', gid: gid })) + '">Review in Needs fixing</a>' : '') + '</p>' : '';
    return G.ui.objectPageHtml({
      head: { title: d.item.itemName || 'Item ' + d.item.itemId, context: context, back: back }, pageClass: 'gs-loot-page gs-loot-item-page',
      noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'),
      sections: [
        { id: 'li-sum', title: 'Item', bodyHtml: '<p>' + L().itemHtml({ itemId: d.item.itemId, itemName: d.item.itemName, quality: d.item.quality }, gd.guild.gameVersion) + '</p>' + summary },
        { id: 'li-over', title: 'Drops over time', chipHtml: '<span class="gs-fine">Awards per night</span>', bodyHtml: over },
        { id: 'li-who', title: 'Who has it', chipHtml: '<span class="gs-fine">' + esc(plural(new Set(groups.map(function (g) { return g.first.winner && g.first.winner.name ? String(g.first.winner.name).toLowerCase() : g.first.id; })).size, 'player', 'players')) + '</span>', bodyHtml: who + fixLine },
      ],
    });
  }

  function loadItem(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().lootItem = { gid: gid, itemId: r.itemId, status: 'none' }; return null; }
    return G.api.loot.item(gid, teamId, r.itemId).then(function (data) {
      a().lootItem = { gid: gid, itemId: r.itemId, teamId: teamId, status: 'ok', data: data };
      return null;
    }, function (err) {
      if (err && err.status === 404) { a().lootItem = { gid: gid, itemId: r.itemId, teamId: teamId, status: 'none' }; return null; }
      if (err && err.status === 403) { a().lootItem = { gid: gid, itemId: r.itemId, teamId: teamId, status: 'denied' }; return null; }
      throw err;
    });
  }

  function mainItem(r, gd) {
    const x = a().lootItem;
    if (!x || x.gid !== gd.guild.id || String(x.itemId) !== String(r.itemId)) return G.pages.signin.loadingHtml();
    return itemHtml({ guildData: gd, state: x, alert: st().pageAlert });
  }

  function itemNameFor(r) {
    const x = a().lootItem;
    return x && String(x.itemId) === String(r.itemId) && x.status === 'ok' && x.data && x.data.item ? x.data.item.itemName || 'Item ' + x.data.item.itemId : '';
  }

  G.handlers.click['litem-showall'] = function () {
    const s = a();
    s.lootItemUi = { showAll: true };
    G.app.render();
  };

  // ── pages the next lane builds ──
  function notBuiltHtml(title) {
    return G.ui.listPageHtml({ head: { title: title, back: { href: href({ name: 'section', gid: (currentGd() || { guild: {} }).guild.id, section: 'loot' }), label: 'Loot' } }, bodyHtml: '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">Not built yet</h2><p class="gs-lead gs-lead-sm">This page is coming next.</p></section>' });
  }

  G.pages.lootNight = { moreMenuHtml: moreMenuHtml, nightHtml: nightHtml, countsText: countsText, load: loadNight, main: mainNight, nameFor: nightNameFor };
  G.pages.lootItem = { itemHtml: itemHtml, load: loadItem, main: mainItem, nameFor: itemNameFor };
  G.pages.lootAward = { load: function () { return null; }, main: function () { return notBuiltHtml('Award'); } };
  G.pages.lootFix = { load: function () { return null; }, main: function () { return notBuiltHtml('Needs fixing'); } };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
