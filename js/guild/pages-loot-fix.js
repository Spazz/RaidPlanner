// ── PAGE: NEEDS FIXING (#/g/:gid/loot/fix) - loot awards that look wrong (T1 list) ──
// GET /loot/fix?team= gives { team, duplicates: [{ key, raidId, raidOn, itemId, itemName, winnerKey, winnerName, awards }], unknown: [award] } to Team Leads and above.
// A possible duplicate (same night, same item, same winner) is kept with "Keep both" (POST /loot/fix/keep: the group leaves the list for every officer), or one
// award is opened or deleted. An unknown winner (no roster character, no guest) is fixed in Edit details. Safe to load alone: nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  function L() { return G.pages.loot; }
  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function href(route) { return G.router.format(route); }
  function dayText(raidOn) { return G.ui.weekdayDay(raidOn) || raidOn || 'Raid night'; }
  function cur() { const x = a().lootFix; return x && x.status === 'ok' && currentGd() ? x : null; }

  function awardRowHtml(gd, w, n) {
    const gid = gd.guild.id;
    const when = w.manual ? 'Added by hand' : 'Awarded ' + L().timeText(w.awardedAt, gd.guild.timeZone);
    return '<li class="gs-lf-award"><span class="gs-lf-n"><strong>Award ' + esc(n) + '</strong><span class="gs-fine">' + esc(when) + '</span></span>' + L().tagChipHtml(w.tag, w.tagSetBy) +
      '<span class="gs-lf-acts"><a class="gs-btn gs-btn-sm" href="' + esc(href({ name: 'lootaward', gid: gid, aid: w.id })) + '" aria-label="' + esc('Open award ' + n) + '">Open award</a>' +
      '<button type="button" class="gs-btn gs-btn-sm gs-btn-danger-outline" data-action="lf-delete" data-aid="' + esc(w.id) + '" data-key="lf-del-' + esc(w.id) + '" aria-label="' + esc('Delete award ' + n) + '">Delete</button></span></li>';
  }

  function groupHtml(gd, g) {
    const gid = gd.guild.id;
    const winner = (g.awards[0] && g.awards[0].match) || {};
    const flag = winner.kind === 'unmatched' ? '<span class="gs-chip gs-chip-flag">Not on roster</span>' : (winner.kind === 'guest' ? '<span class="gs-chip gs-chip-flag">Guest</span>' : '');
    return '<li class="gs-lf-group" data-group="' + esc(g.key) + '"><div class="gs-lf-head"><span class="gs-lf-title">' +
      L().itemHtml({ itemId: g.itemId, itemName: g.itemName, quality: g.awards[0] && g.awards[0].quality }, gd.guild.gameVersion) +
      '<span class="gs-fine"><a href="' + esc(href({ name: 'lootnight', gid: gid, rid: g.raidId })) + '">' + esc(dayText(g.raidOn)) + '</a> - ' + esc(g.winnerName) + '</span>' + flag + '</span></div>' +
      '<ul class="gs-lf-awards" aria-label="' + esc('Awards of ' + (g.itemName || 'this item') + ' to ' + g.winnerName) + '">' + g.awards.map(function (w, i) { return awardRowHtml(gd, w, i + 1); }).join('') + '</ul>' +
      '<div class="gs-lf-keep"><button type="button" class="gs-btn gs-btn-sm" data-action="lf-keep" data-group="' + esc(g.key) + '" data-key="lf-keep-' + esc(g.key) + '">Keep both</button>' +
      '<span class="gs-fine">Both are real. This group stops showing here.</span></div></li>';
  }

  function unknownHtml(gd, list) {
    if (!list.length) return '<p class="gs-fine" id="lf-unknown-none">None. Every winner matches a roster character or a guest.</p>';
    const rows = list.map(function (w) {
      return { id: w.id, cells: {
        item: L().itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion),
        winner: L().winnerHtml(gd.guild.id, w.winner, w.match),
        night: '<a href="' + esc(href({ name: 'lootnight', gid: gd.guild.id, rid: w.raidId })) + '">' + esc(dayText(w.raidOn)) + '</a>',
        actions: '<a class="gs-btn gs-btn-sm" href="' + esc(href({ name: 'lootaward', gid: gd.guild.id, aid: w.id, edit: true })) + '" aria-label="' + esc('Edit details of ' + (w.itemName || 'this award')) + '">Edit details</a>' } };
    });
    return G.ui.dataTableHtml({ label: 'Awards with an unknown winner', columns: [{ key: 'item', label: 'Item', primary: true }, { key: 'winner', label: 'Winner' }, { key: 'night', label: 'Night' }, { key: 'actions', label: 'Fix', srLabel: true, hideLabel: true }],
      rows: rows, limit: 1000, showAll: true, noun: 'awards' });
  }

  // opts: { guildData, state: { status, data }, alert }
  function fixHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const back = { href: href({ name: 'section', gid: gd.guild.id, section: 'loot' }), label: 'Loot' };
    if (x.status === 'denied') {
      return G.ui.listPageHtml({ head: { title: 'Needs fixing', back: back }, bodyHtml: '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">Only Team Leads and above can fix loot.</h2><p class="gs-lead gs-lead-sm">Ask an officer of your team to look at it.</p></section>' });
    }
    const d = x.data;
    const dupes = Array.isArray(d.duplicates) ? d.duplicates : [];
    const unknown = Array.isArray(d.unknown) ? d.unknown : [];
    const team = d.team && d.team.name ? ' for ' + d.team.name : '';
    const empty = !dupes.length && !unknown.length;
    const body = empty
      ? '<section class="gs-empty-card" id="lf-empty"><h2 class="gs-h2 gs-h2-lg">Nothing needs fixing</h2><p class="gs-lead gs-lead-sm">No possible duplicates and no unknown winner names' + esc(team) + '.</p></section>'
      : '<section class="gs-osection gs-lf-sec" id="lf-dupes" aria-labelledby="lf-dupes-h"><div class="gs-osection-head"><h2 class="gs-h2" id="lf-dupes-h">Possible duplicates</h2><span class="gs-fine">Same night, same item, same winner</span></div><div class="gs-osection-body">' +
        (dupes.length ? '<ul class="gs-lf-groups" aria-label="Possible duplicates">' + dupes.map(function (g) { return groupHtml(gd, g); }).join('') + '</ul>' : '<p class="gs-fine" id="lf-dupes-none">None.</p>') + '</div></section>' +
        '<section class="gs-osection gs-lf-sec" id="lf-unknown" aria-labelledby="lf-unknown-h"><div class="gs-osection-head"><h2 class="gs-h2" id="lf-unknown-h">Unknown winner names</h2><span class="gs-fine">Not on the roster, not a guest</span></div><div class="gs-osection-body">' + unknownHtml(gd, unknown) + '</div></section>';
    return G.ui.listPageHtml({
      head: { title: 'Needs fixing', context: 'Loot awards that look wrong' + team + '. ' + plural(dupes.length, 'possible duplicate', 'possible duplicates') + ', ' + plural(unknown.length, 'unknown winner', 'unknown winners') + '.', back: back },
      pageClass: 'gs-loot-page gs-loot-fix', noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'), bodyHtml: body,
    });
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().lootFix = { gid: gid, teamId: null, status: 'ok', data: { team: null, duplicates: [], unknown: [] } }; return null; }
    return G.api.loot.fix(gid, teamId).then(function (data) {
      a().lootFix = { gid: gid, teamId: teamId, status: 'ok', data: data };
      return null;
    }, function (err) {
      if (err && err.status === 403) { a().lootFix = { gid: gid, teamId: teamId, status: 'denied' }; return null; }
      throw err;
    });
  }

  function main(r, gd) {
    const x = a().lootFix;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return fixHtml({ guildData: gd, state: x, alert: st().pageAlert });
  }

  function reload(x, gd) {
    return G.api.loot.fix(gd.guild.id, x.teamId).then(function (data) { x.data = data; st().pageAlert = ''; G.app.render(); }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  G.handlers.click['lf-keep'] = function (el) {
    const x = cur();
    const gd = currentGd();
    if (!x || !gd) return;
    const key = el.getAttribute('data-group');
    const g = (x.data.duplicates || []).filter(function (p) { return p.key === key; })[0];
    if (!g) return;
    el.disabled = true;
    G.api.loot.keep(gd.guild.id, g.raidId, g.itemId, g.winnerKey).then(function () {
      x.data.duplicates = x.data.duplicates.filter(function (p) { return p.key !== key; });
      st().pageAlert = '';
      G.app.render();
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  function findAward(x, aid) {
    const groups = x.data.duplicates || [];
    for (let i = 0; i < groups.length; i++) {
      const hit = groups[i].awards.filter(function (w) { return w.id === aid; })[0];
      if (hit) return hit;
    }
    return (x.data.unknown || []).filter(function (w) { return w.id === aid; })[0] || null;
  }

  G.handlers.click['lf-delete'] = function (el) {
    const x = cur();
    const award = x ? findAward(x, el.getAttribute('data-aid')) : null;
    if (!award || !G.pages.raidLoot) return;
    G.ui.openDialog(G.pages.raidLoot.deleteDialogHtml(award, 'lf-delete-form'), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['lf-delete-form'] = function (form) {
    const x = cur();
    const gd = currentGd();
    if (!x || !gd) return;
    G.ui.runDialog(form, G.api.loot.remove(gd.guild.id, form.getAttribute('data-aid')), function () { reload(x, gd); });
  };

  G.pages.lootFix = { fixHtml: fixHtml, load: load, main: main };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
